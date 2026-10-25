#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>

namespace {

constexpr std::uint32_t kBlockSize = 128U;
constexpr double kSampleRate = 48000.0;
constexpr std::size_t kScanBlocks = 4500U; // 12 seconds at 48 kHz.
constexpr std::size_t kLateWindowBlocks = 512U;
constexpr float kAudibleFloor = 1.0e-10F;
constexpr float kSuppressedPeakCeiling = 1.0e-6F; // -120 dBFS amplitude.
constexpr std::size_t kSuppressedHeldBlocks = 64U;
constexpr std::size_t kPostNoteOffBlocks = 128U;

struct ScanMetrics {
    std::uint64_t sample_values = 0U;
    std::uint64_t subnormal_values = 0U;
    std::uint64_t exact_zero_values = 0U;
    std::uint64_t late_silent_blocks = 0U;
    std::uint64_t first_subnormal_frame = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t first_sleep_frame = std::numeric_limits<std::uint64_t>::max();
    float minimum_nonzero_abs = std::numeric_limits<float>::infinity();
    float late_peak = 0.0F;
};

struct AudibleParityMetrics {
    std::uint64_t first_sleep_frame = std::numeric_limits<std::uint64_t>::max();
    float max_suppressed_reference_peak = 0.0F;
    float max_suppressed_difference = 0.0F;
    float max_post_note_off_difference = 0.0F;
};

brk::modal::Patch held_tail_patch() {
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    patch.coupling = brk::modal::Coupling::Serial;
    patch.coupling_profile = brk::modal::CouplingProfile::Stable;
    patch.release_mode = brk::modal::ReleaseMode::Damped;
    patch.polyphony = 1U;
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    patch.output_gain_db = -6.0F;
    patch.resonator_gain_db = 12.0F;

    patch.resonator_a.enabled = true;
    patch.resonator_a.partials = 16U;
    patch.resonator_a.max_render_partials = 16U;
    patch.resonator_a.decay_seconds = 0.04F;
    patch.resonator_a.release_scale = 1.0F;

    patch.resonator_b.enabled = true;
    patch.resonator_b.partials = 16U;
    patch.resonator_b.max_render_partials = 16U;
    patch.resonator_b.decay_seconds = 0.05F;
    patch.resonator_b.release_scale = 1.0F;

    patch.exciter.mallet_direct = 0.0F;
    patch.exciter.mallet_resonator = 1.0F;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.0F;
    return patch;
}

bool scan_value(float value, std::uint64_t frame, ScanMetrics& metrics) {
    if (!std::isfinite(value)) return false;
    ++metrics.sample_values;
    if (value == 0.0F) {
        ++metrics.exact_zero_values;
        return true;
    }
    const float magnitude = std::abs(value);
    metrics.minimum_nonzero_abs = std::min(metrics.minimum_nonzero_abs, magnitude);
    if (std::fpclassify(value) == FP_SUBNORMAL) {
        ++metrics.subnormal_values;
        metrics.first_subnormal_frame = std::min(metrics.first_subnormal_frame, frame);
    }
    return true;
}

bool held_tail_scan(ScanMetrics& metrics) {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, 0x48454c445441494cULL)) return false;
    engine.set_modal_kernel(brk::modal::ModalKernel::Scalar);
    engine.set_tail_policy(brk::modal::TailPolicy::Conservative);
    engine.set_patch(held_tail_patch());
    engine.note_on({1U, 48, 0.9F, 0.0F});

    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};
    for (std::size_t block = 0U; block < kScanBlocks; ++block) {
        engine.process(left.data(), right.data(), kBlockSize);
        if (engine.active_voice_count() != 1U || engine.held_voice_count() != 1U
            || engine.sustained_voice_count() != 0U) {
            return false;
        }
        if (engine.sleeping_voice_count() > 1U || engine.tail_sleep_stats().entries > 1U) {
            return false;
        }
        if (metrics.first_sleep_frame == std::numeric_limits<std::uint64_t>::max()
            && engine.sleeping_voice_count() == 1U) {
            metrics.first_sleep_frame = static_cast<std::uint64_t>((block + 1U) * kBlockSize);
        }

        float block_peak = 0.0F;
        for (std::uint32_t frame = 0U; frame < kBlockSize; ++frame) {
            const auto absolute_frame = static_cast<std::uint64_t>(block) * kBlockSize + frame;
            if (!scan_value(left[frame], absolute_frame, metrics)
                || !scan_value(right[frame], absolute_frame, metrics)) {
                return false;
            }
            block_peak = std::max(block_peak, std::abs(left[frame]));
            block_peak = std::max(block_peak, std::abs(right[frame]));
        }

        if (block + kLateWindowBlocks >= kScanBlocks) {
            metrics.late_peak = std::max(metrics.late_peak, block_peak);
            if (block_peak <= kAudibleFloor) ++metrics.late_silent_blocks;
        }
    }

    return engine.active_voice_count() == 1U
        && engine.held_voice_count() == 1U
        && engine.sleeping_voice_count() == 1U
        && engine.tail_sleep_stats().entries == 1U
        && engine.tail_sleep_stats().retired_voices == 0U
        && engine.tail_sleep_stats().skipped_voice_frames > 0U
        && metrics.first_sleep_frame != std::numeric_limits<std::uint64_t>::max()
        && metrics.late_silent_blocks == kLateWindowBlocks
        && metrics.late_peak <= kAudibleFloor;
}

bool finite_pair(
    const std::array<float, kBlockSize>& left,
    const std::array<float, kBlockSize>& right) {
    for (std::uint32_t frame = 0U; frame < kBlockSize; ++frame) {
        if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])) return false;
    }
    return true;
}

bool exact_pair(
    const std::array<float, kBlockSize>& reference_left,
    const std::array<float, kBlockSize>& reference_right,
    const std::array<float, kBlockSize>& candidate_left,
    const std::array<float, kBlockSize>& candidate_right) {
    for (std::uint32_t frame = 0U; frame < kBlockSize; ++frame) {
        if (reference_left[frame] != candidate_left[frame]
            || reference_right[frame] != candidate_right[frame]) {
            return false;
        }
    }
    return true;
}

void accumulate_suppressed_metrics(
    const std::array<float, kBlockSize>& reference_left,
    const std::array<float, kBlockSize>& reference_right,
    const std::array<float, kBlockSize>& candidate_left,
    const std::array<float, kBlockSize>& candidate_right,
    float& max_reference_peak,
    float& max_difference) {
    for (std::uint32_t frame = 0U; frame < kBlockSize; ++frame) {
        max_reference_peak = std::max(max_reference_peak, std::abs(reference_left[frame]));
        max_reference_peak = std::max(max_reference_peak, std::abs(reference_right[frame]));
        max_difference = std::max(max_difference, std::abs(reference_left[frame] - candidate_left[frame]));
        max_difference = std::max(max_difference, std::abs(reference_right[frame] - candidate_right[frame]));
    }
}

bool held_tail_audible_parity(AudibleParityMetrics& metrics) {
    brk::modal::Engine reference;
    brk::modal::Engine candidate;
    constexpr std::uint64_t seed = 0x41554449424c4550ULL;
    if (!reference.prepare(kSampleRate, kBlockSize, seed)
        || !candidate.prepare(kSampleRate, kBlockSize, seed)) {
        return false;
    }

    reference.set_modal_kernel(brk::modal::ModalKernel::Scalar);
    candidate.set_modal_kernel(brk::modal::ModalKernel::Scalar);
    reference.set_tail_policy(brk::modal::TailPolicy::Disabled);
    candidate.set_tail_policy(brk::modal::TailPolicy::Conservative);
    const auto patch = held_tail_patch();
    reference.set_patch(patch);
    candidate.set_patch(patch);
    reference.note_on({1U, 48, 0.9F, 0.0F});
    candidate.note_on({1U, 48, 0.9F, 0.0F});

    std::array<float, kBlockSize> reference_left{};
    std::array<float, kBlockSize> reference_right{};
    std::array<float, kBlockSize> candidate_left{};
    std::array<float, kBlockSize> candidate_right{};

    // Tail policy observation is bookkeeping only until the Conservative voice
    // actually enters sleep. The rendered audio must therefore remain bit-exact
    // against the Disabled-policy reference through the complete sleep-entry block.
    for (std::size_t block = 0U; block < 4096U; ++block) {
        reference.process(reference_left.data(), reference_right.data(), kBlockSize);
        candidate.process(candidate_left.data(), candidate_right.data(), kBlockSize);
        if (!finite_pair(reference_left, reference_right)
            || !finite_pair(candidate_left, candidate_right)
            || !exact_pair(reference_left, reference_right, candidate_left, candidate_right)) {
            return false;
        }
        if (candidate.sleeping_voice_count() == 1U) {
            metrics.first_sleep_frame = static_cast<std::uint64_t>((block + 1U) * kBlockSize);
            break;
        }
    }

    if (metrics.first_sleep_frame == std::numeric_limits<std::uint64_t>::max()) return false;
    if (candidate.active_voice_count() != 1U || candidate.held_voice_count() != 1U
        || candidate.sleeping_voice_count() != 1U || reference.active_voice_count() != 1U
        || reference.held_voice_count() != 1U || reference.sleeping_voice_count() != 0U) {
        return false;
    }

    // Once Conservative sleep begins, the only intentional audio difference is
    // removal of a tail that already remained below the complete-voice threshold
    // for the full dwell interval. Bound the actually suppressed output to
    // -120 dBFS, rather than inferring audibility from internal state alone.
    for (std::size_t block = 0U; block < kSuppressedHeldBlocks; ++block) {
        reference.process(reference_left.data(), reference_right.data(), kBlockSize);
        candidate.process(candidate_left.data(), candidate_right.data(), kBlockSize);
        if (!finite_pair(reference_left, reference_right)
            || !finite_pair(candidate_left, candidate_right)) {
            return false;
        }
        accumulate_suppressed_metrics(
            reference_left,
            reference_right,
            candidate_left,
            candidate_right,
            metrics.max_suppressed_reference_peak,
            metrics.max_suppressed_difference);
    }

    if (metrics.max_suppressed_reference_peak > kSuppressedPeakCeiling
        || metrics.max_suppressed_difference > kSuppressedPeakCeiling) {
        return false;
    }

    // NOTE_OFF is an explicit wake/release lifecycle event. The sleeper clears
    // its frozen sub-audible residual, while the Disabled reference releases the
    // still-advancing residual. Bound that transition difference to the same
    // -120 dBFS ceiling so lifecycle correctness is also sound-safe.
    reference.note_off(1U);
    candidate.note_off(1U);
    for (std::size_t block = 0U; block < kPostNoteOffBlocks; ++block) {
        reference.process(reference_left.data(), reference_right.data(), kBlockSize);
        candidate.process(candidate_left.data(), candidate_right.data(), kBlockSize);
        if (!finite_pair(reference_left, reference_right)
            || !finite_pair(candidate_left, candidate_right)) {
            return false;
        }
        float ignored_reference_peak = 0.0F;
        accumulate_suppressed_metrics(
            reference_left,
            reference_right,
            candidate_left,
            candidate_right,
            ignored_reference_peak,
            metrics.max_post_note_off_difference);
    }

    return metrics.max_post_note_off_difference <= kSuppressedPeakCeiling
        && reference.held_voice_count() == 0U
        && candidate.held_voice_count() == 0U;
}

} // namespace

int main() {
    ScanMetrics metrics{};
    if (!held_tail_scan(metrics)) {
        std::cerr << "held-tail scan failed to reach retained sleeping held state\n";
        return 1;
    }

    AudibleParityMetrics audible{};
    if (!held_tail_audible_parity(audible)) {
        std::cerr << "held-tail audible parity/suppression bound failed\n";
        return 1;
    }

    std::cout << "held_tail_scan_blocks=" << kScanBlocks << '\n';
    std::cout << "held_tail_scan_seconds="
              << static_cast<double>(kScanBlocks * kBlockSize) / kSampleRate << '\n';
    std::cout << "held_tail_sample_values=" << metrics.sample_values << '\n';
    std::cout << "held_tail_subnormal_values=" << metrics.subnormal_values << '\n';
    std::cout << "held_tail_exact_zero_values=" << metrics.exact_zero_values << '\n';
    std::cout << "held_tail_minimum_nonzero_abs=" << metrics.minimum_nonzero_abs << '\n';
    std::cout << "held_tail_first_subnormal_frame=";
    if (metrics.first_subnormal_frame == std::numeric_limits<std::uint64_t>::max()) {
        std::cout << "none\n";
    } else {
        std::cout << metrics.first_subnormal_frame << '\n';
    }
    std::cout << "held_tail_first_sleep_frame=" << metrics.first_sleep_frame << '\n';
    std::cout << "held_tail_late_peak=" << metrics.late_peak << '\n';
    std::cout << "held_tail_late_silent_blocks=" << metrics.late_silent_blocks << '\n';
    std::cout << "held_tail_audible_parity_first_sleep_frame=" << audible.first_sleep_frame << '\n';
    std::cout << "held_tail_max_suppressed_reference_peak=" << audible.max_suppressed_reference_peak << '\n';
    std::cout << "held_tail_max_suppressed_difference=" << audible.max_suppressed_difference << '\n';
    std::cout << "held_tail_max_post_note_off_difference=" << audible.max_post_note_off_difference << '\n';
    std::cout << "held_tail_pre_sleep_bit_exact=PASS\n";
    std::cout << "held_tail_suppressed_below_minus_120_dbfs=PASS\n";
    std::cout << "held_tail_note_off_difference_below_minus_120_dbfs=PASS\n";
    std::cout << "held_tail_active_voice_retained=PASS\n";
    std::cout << "held_tail_sleeping_voice_retained=PASS\n";
    std::cout << "brk_modal_held_tail_subnormal_scan=PASS\n";
    return 0;
}

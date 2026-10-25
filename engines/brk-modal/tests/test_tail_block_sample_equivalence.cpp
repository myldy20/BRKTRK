#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>

namespace {

constexpr std::uint32_t kRate = 48000U;
constexpr std::uint32_t kBlock = 128U;
constexpr std::uint64_t kSeed = 0x5441494c45515631ULL;
constexpr double kMaxTerminalError = 2.0e-5;
constexpr std::uint64_t kMaxSleepDeltaFrames = 2U * kBlock;

struct Evidence {
    double max_abs_error = 0.0;
    std::uint64_t block_sleep_frame = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t sample_sleep_frame = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t compared_frames = 0U;
};

brk::modal::Patch make_patch() {
    brk::modal::Patch patch{};
    patch.coupling_profile = brk::modal::CouplingProfile::Stable;
    patch.coupling = brk::modal::Coupling::Parallel;
    patch.release_mode = brk::modal::ReleaseMode::Natural;
    patch.polyphony = 1U;
    patch.resonator_a.enabled = true;
    patch.resonator_a.model = brk::modal::Model::Marimba;
    patch.resonator_a.partials = 8U;
    patch.resonator_a.max_render_partials = 8U;
    patch.resonator_a.decay_seconds = 0.05F;
    patch.resonator_a.material = -0.35F;
    patch.resonator_a.tone = 0.0F;
    patch.resonator_b.enabled = false;
    patch.exciter.mallet_direct = 0.0F;
    patch.exciter.mallet_resonator = 1.0F;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.0F;
    patch.resonator_gain_db = -6.0F;
    patch.output_gain_db = -9.0F;
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    return patch;
}

bool prepare(brk::modal::Engine& engine) {
    if (!engine.prepare(kRate, kBlock, kSeed)) return false;
    engine.set_patch(make_patch());
    engine.set_tail_policy(brk::modal::TailPolicy::Conservative);
    return true;
}

bool finite_block(const std::array<float, kBlock>& left,
                  const std::array<float, kBlock>& right) {
    for (std::size_t index = 0U; index < left.size(); ++index) {
        if (!std::isfinite(left[index]) || !std::isfinite(right[index])) return false;
    }
    return true;
}

bool run(Evidence& evidence) {
    brk::modal::Engine blocked;
    brk::modal::Engine sampled;
    if (!prepare(blocked) || !prepare(sampled)) return false;

    const brk::modal::NoteOn note{1U, 60, 1.0F, 0.0F};
    blocked.note_on(note);
    sampled.note_on(note);

    std::array<float, kBlock> block_left{};
    std::array<float, kBlock> block_right{};
    std::array<float, kBlock> sample_left{};
    std::array<float, kBlock> sample_right{};

    // Before release, Conservative policy must not affect a physically held
    // note. Rendering 128 frames at once or 1 frame at a time is therefore
    // required to be bit-exact.
    for (int warm = 0; warm < 4; ++warm) {
        blocked.process(block_left.data(), block_right.data(), kBlock);
        for (std::uint32_t frame = 0U; frame < kBlock; ++frame) {
            sampled.process(sample_left.data() + frame, sample_right.data() + frame, 1U);
        }
        if (!finite_block(block_left, block_right) || !finite_block(sample_left, sample_right)) return false;
        for (std::size_t index = 0U; index < block_left.size(); ++index) {
            if (block_left[index] != sample_left[index] || block_right[index] != sample_right[index]) {
                return false;
            }
        }
    }

    blocked.note_off(1U);
    sampled.note_off(1U);

    const std::uint64_t max_frames = static_cast<std::uint64_t>(4U) * kRate;
    bool blocked_retired = false;
    bool sampled_retired = false;
    for (std::uint64_t frame_base = 0U; frame_base < max_frames; frame_base += kBlock) {
        blocked.process(block_left.data(), block_right.data(), kBlock);
        if (!finite_block(block_left, block_right)) return false;
        if (evidence.block_sleep_frame == std::numeric_limits<std::uint64_t>::max()
            && blocked.sleeping_voice_count() != 0U) {
            evidence.block_sleep_frame = frame_base + kBlock - 1U;
        }

        for (std::uint32_t frame = 0U; frame < kBlock; ++frame) {
            sampled.process(sample_left.data() + frame, sample_right.data() + frame, 1U);
            if (!std::isfinite(sample_left[frame]) || !std::isfinite(sample_right[frame])) return false;
            if (evidence.sample_sleep_frame == std::numeric_limits<std::uint64_t>::max()
                && sampled.sleeping_voice_count() != 0U) {
                evidence.sample_sleep_frame = frame_base + frame;
            }
        }

        for (std::size_t index = 0U; index < block_left.size(); ++index) {
            evidence.max_abs_error = std::max(
                evidence.max_abs_error,
                static_cast<double>(std::abs(block_left[index] - sample_left[index])));
            evidence.max_abs_error = std::max(
                evidence.max_abs_error,
                static_cast<double>(std::abs(block_right[index] - sample_right[index])));
        }
        evidence.compared_frames += kBlock;

        blocked_retired = blocked.active_voice_count() == 0U;
        sampled_retired = sampled.active_voice_count() == 0U;
        if (blocked_retired && sampled_retired) break;
    }

    if (!blocked_retired || !sampled_retired) return false;
    if (evidence.block_sleep_frame == std::numeric_limits<std::uint64_t>::max()
        || evidence.sample_sleep_frame == std::numeric_limits<std::uint64_t>::max()) {
        return false;
    }

    const std::uint64_t sleep_delta = evidence.block_sleep_frame > evidence.sample_sleep_frame
        ? evidence.block_sleep_frame - evidence.sample_sleep_frame
        : evidence.sample_sleep_frame - evidence.block_sleep_frame;
    return sleep_delta <= kMaxSleepDeltaFrames
        && evidence.max_abs_error <= kMaxTerminalError;
}

} // namespace

int main() {
    Evidence evidence{};
    if (!run(evidence)) {
        std::cerr << "Conservative block/sample equivalence failed\n";
        return 1;
    }

    const std::uint64_t sleep_delta = evidence.block_sleep_frame > evidence.sample_sleep_frame
        ? evidence.block_sleep_frame - evidence.sample_sleep_frame
        : evidence.sample_sleep_frame - evidence.block_sleep_frame;
    std::cout << "conservative_block_sample_max_abs_error=" << evidence.max_abs_error << '\n';
    std::cout << "conservative_block_sleep_frame=" << evidence.block_sleep_frame << '\n';
    std::cout << "conservative_sample_sleep_frame=" << evidence.sample_sleep_frame << '\n';
    std::cout << "conservative_sleep_delta_frames=" << sleep_delta << '\n';
    std::cout << "conservative_compared_frames=" << evidence.compared_frames << '\n';
    std::cout << "conservative_pre_release_exact=PASS\n";
    std::cout << "conservative_terminal_error_bounded=PASS\n";
    std::cout << "conservative_both_paths_retired=PASS\n";
    std::cout << "brk_modal_tail_block_sample_equivalence=PASS\n";
    return 0;
}

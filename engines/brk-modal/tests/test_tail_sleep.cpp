#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

constexpr std::uint32_t kBlockSize = 128U;
constexpr double kSampleRate = 48000.0;

struct RenderResult {
    std::vector<float> left;
    std::vector<float> right;
    brk::modal::TailSleepStats stats{};
    std::uint64_t first_sleep_frame = std::numeric_limits<std::uint64_t>::max();
};

struct ErrorMetrics {
    double maximum = 0.0;
    double rms = 0.0;
    double signal_rms = 0.0;
    double snr_db = 300.0;
};

brk::modal::Patch terminal_tail_patch() {
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    patch.resonator_a.partials = 24U;
    patch.resonator_a.max_render_partials = 24U;
    patch.resonator_a.decay_seconds = 0.55F;
    patch.resonator_a.release_scale = 0.08F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.partials = 13U;
    patch.resonator_b.max_render_partials = 13U;
    patch.resonator_b.decay_seconds = 0.42F;
    patch.resonator_b.release_scale = 0.08F;
    patch.release_mode = brk::modal::ReleaseMode::Damped;
    patch.polyphony = 4U;
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    patch.output_gain_db = -6.0F;
    return patch;
}

brk::modal::Patch natural_tail_patch() {
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    patch.resonator_a.partials = 32U;
    patch.resonator_a.max_render_partials = 32U;
    patch.resonator_a.decay_seconds = 1.2F;
    patch.resonator_a.release_scale = 1.0F;
    patch.resonator_b.enabled = false;
    patch.release_mode = brk::modal::ReleaseMode::Natural;
    patch.polyphony = 2U;
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    patch.output_gain_db = -6.0F;
    return patch;
}

RenderResult render(const brk::modal::Patch& patch, brk::modal::TailPolicy policy, std::size_t blocks) {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, 0x503437435441494cULL)) {
        throw std::runtime_error("prepare failed");
    }
    engine.set_modal_kernel(brk::modal::ModalKernel::Scalar);
    engine.set_tail_policy(policy);
    engine.set_patch(patch);
    engine.note_on({1U, 52, 0.83F, 0.0F});
    engine.note_on({2U, 59, 0.69F, 0.03F});

    RenderResult result;
    result.left.reserve(blocks * kBlockSize);
    result.right.reserve(blocks * kBlockSize);
    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};
    for (std::size_t block = 0; block < blocks; ++block) {
        if (block == 24U) {
            engine.note_off(1U);
            engine.note_off(2U);
        }
        engine.process(left.data(), right.data(), kBlockSize);
        result.left.insert(result.left.end(), left.begin(), left.end());
        result.right.insert(result.right.end(), right.begin(), right.end());
        if (result.first_sleep_frame == std::numeric_limits<std::uint64_t>::max()
            && engine.tail_sleep_stats().entries != 0U) {
            result.first_sleep_frame = static_cast<std::uint64_t>((block + 1U) * kBlockSize);
        }
    }
    result.stats = engine.tail_sleep_stats();
    return result;
}

ErrorMetrics compare(const RenderResult& reference, const RenderResult& candidate) {
    if (reference.left.size() != candidate.left.size() || reference.right.size() != candidate.right.size()) {
        throw std::runtime_error("render size mismatch");
    }
    long double error_squared = 0.0;
    long double signal_squared = 0.0;
    double maximum = 0.0;
    std::size_t count = 0U;
    const auto accumulate = [&](const std::vector<float>& expected, const std::vector<float>& actual) {
        for (std::size_t index = 0; index < expected.size(); ++index) {
            const double error = static_cast<double>(expected[index]) - static_cast<double>(actual[index]);
            maximum = std::max(maximum, std::abs(error));
            error_squared += static_cast<long double>(error * error);
            signal_squared += static_cast<long double>(expected[index]) * static_cast<long double>(expected[index]);
            ++count;
        }
    };
    accumulate(reference.left, candidate.left);
    accumulate(reference.right, candidate.right);
    const double rms = std::sqrt(static_cast<double>(error_squared / static_cast<long double>(count)));
    const double signal_rms = std::sqrt(static_cast<double>(signal_squared / static_cast<long double>(count)));
    const double snr = rms > 0.0 ? 20.0 * std::log10(signal_rms / rms) : 300.0;
    return {maximum, rms, signal_rms, snr};
}

void require_finite(const std::array<float, kBlockSize>& values) {
    for (float value : values) {
        if (!std::isfinite(value)) throw std::runtime_error("non-finite output");
    }
}

void process_blocks(
    brk::modal::Engine& engine,
    std::array<float, kBlockSize>& left,
    std::array<float, kBlockSize>& right,
    std::size_t blocks) {
    for (std::size_t block = 0; block < blocks; ++block) {
        engine.process(left.data(), right.data(), kBlockSize);
        require_finite(left);
        require_finite(right);
    }
}

void require_eventual_sleep(
    brk::modal::Engine& engine,
    std::array<float, kBlockSize>& left,
    std::array<float, kBlockSize>& right,
    const char* failure) {
    for (std::size_t block = 0; block < 4096U && engine.sleeping_voice_count() == 0U; ++block) {
        process_blocks(engine, left, right, 1U);
    }
    if (engine.sleeping_voice_count() == 0U) throw std::runtime_error(failure);
}

void require_held_awake(const brk::modal::Engine& engine, const char* failure) {
    if (engine.active_voice_count() != 1U || engine.held_voice_count() != 1U
        || engine.sustained_voice_count() != 0U || engine.sleeping_voice_count() != 0U) {
        throw std::runtime_error(failure);
    }
}

void lifecycle_checks() {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, 0x5034374357414b45ULL)) {
        throw std::runtime_error("lifecycle prepare failed");
    }
    engine.set_tail_policy(brk::modal::TailPolicy::Conservative);
    auto lifecycle_patch = terminal_tail_patch();
    lifecycle_patch.polyphony = 1U;
    engine.set_patch(lifecycle_patch);
    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};

    // Stable/Wild legacy decay-only exciters may sleep after the complete voice
    // has remained sub-audible for dwell, but the physically held note identity
    // must stay alive indefinitely rather than entering released-tail retirement.
    engine.note_on({11U, 48, 0.8F, 0.0F});
    require_eventual_sleep(engine, left, right, "silent held legacy voice never entered tail sleep");
    if (engine.active_voice_count() != 1U || engine.held_voice_count() != 1U
        || engine.sleeping_voice_count() != 1U) {
        throw std::runtime_error("held sleeping voice lost active/key identity");
    }
    const auto held_sleep_stats = engine.tail_sleep_stats();
    process_blocks(engine, left, right, 256U);
    if (engine.active_voice_count() != 1U || engine.held_voice_count() != 1U
        || engine.sleeping_voice_count() != 1U) {
        throw std::runtime_error("held sleeping voice was auto-retired");
    }
    if (engine.tail_sleep_stats().skipped_voice_frames <= held_sleep_stats.skipped_voice_frames) {
        throw std::runtime_error("held sleeping voice did not skip DSP frames");
    }

    // Sustain NOTE_OFF must wake the held sleeper to a zero residual state and
    // preserve the sustained lifecycle instead of retiring the key identity.
    engine.set_sustain(true);
    engine.note_off(11U);
    if (engine.sleeping_voice_count() != 0U || engine.sustained_voice_count() != 1U
        || engine.active_voice_count() != 1U || engine.held_voice_count() != 0U) {
        throw std::runtime_error("sustain NOTE_OFF did not wake held sleeper correctly");
    }
    const auto entries_before_sustain = engine.tail_sleep_stats().entries;
    process_blocks(engine, left, right, 1024U);
    if (engine.tail_sleep_stats().entries != entries_before_sustain) {
        throw std::runtime_error("sustained voice entered tail sleep");
    }
    if (engine.sustained_voice_count() != 1U) throw std::runtime_error("sustain state lost");

    engine.set_sustain(false);
    require_eventual_sleep(engine, left, right, "released voice never entered tail sleep");

    // Kernel changes must not disturb sleeping terminal state. A same-note-id
    // retrigger then deterministically recycles the sleeping slot and starts
    // from a clean, finite voice state on either scalar or vector builds.
    engine.set_modal_kernel(brk::modal::ModalKernel::Auto);
    const auto before_retrigger = engine.tail_sleep_stats();
    engine.note_on({11U, 55, 0.91F, 0.0F});
    process_blocks(engine, left, right, 1U);
    if (engine.sleeping_voice_count() != 0U) throw std::runtime_error("same-note retrigger left stale sleeping voice");
    if (engine.tail_sleep_stats().recycled_voices <= before_retrigger.recycled_voices) {
        throw std::runtime_error("sleeping voice reuse was not recorded");
    }
    if (engine.active_voice_count() == 0U || engine.held_voice_count() == 0U) {
        throw std::runtime_error("same-note retrigger did not create an active held voice");
    }

    engine.choke(11U);
    process_blocks(engine, left, right, 1U);
    if (engine.active_voice_count() != 0U || engine.sleeping_voice_count() != 0U) {
        throw std::runtime_error("choke left live or sleeping state");
    }

    // OneShot voices are terminal from note-on, but they still cannot sleep
    // until the exciter and resonator observer have remained quiet for dwell.
    auto one_shot = lifecycle_patch;
    one_shot.release_mode = brk::modal::ReleaseMode::OneShot;
    one_shot.exciter.noise_decay_ms = 900.0F;
    engine.set_patch(one_shot);
    engine.note_on({12U, 52, 0.78F, 0.0F});
    const auto entries_before_one_shot = engine.tail_sleep_stats().entries;
    process_blocks(engine, left, right, 64U);
    if (engine.tail_sleep_stats().entries != entries_before_one_shot) {
        throw std::runtime_error("OneShot slept while its exciter was still materially active");
    }
    require_eventual_sleep(engine, left, right, "OneShot terminal tail never slept");

    const auto before_patch_change = engine.tail_sleep_stats();
    engine.set_patch(lifecycle_patch);
    if (engine.sleeping_voice_count() != 0U || engine.active_voice_count() != 0U) {
        throw std::runtime_error("patch change did not retire frozen terminal state");
    }
    if (engine.tail_sleep_stats().retired_voices <= before_patch_change.retired_voices) {
        throw std::runtime_error("patch-change retirement was not recorded");
    }

    engine.note_on({13U, 57, 0.84F, 0.0F});
    engine.note_off(13U);
    require_eventual_sleep(engine, left, right, "second released tail never slept");
    const auto before_disable = engine.tail_sleep_stats();
    engine.set_tail_policy(brk::modal::TailPolicy::Disabled);
    if (engine.sleeping_voice_count() != 0U || engine.active_voice_count() != 0U) {
        throw std::runtime_error("disabling policy did not retire frozen released tails");
    }
    if (engine.tail_sleep_stats().retired_voices <= before_disable.retired_voices) {
        throw std::runtime_error("policy-disable released retirement was not recorded");
    }

    // Patch edits and policy disable wake a held sleeper without resurrecting
    // frozen residual state or dropping the note identity.
    engine.set_tail_policy(brk::modal::TailPolicy::Conservative);
    engine.set_patch(lifecycle_patch);
    engine.note_on({15U, 50, 0.86F, 0.0F});
    require_eventual_sleep(engine, left, right, "held patch-edit fixture never slept");
    const auto before_held_patch = engine.tail_sleep_stats();
    auto edited_patch = lifecycle_patch;
    edited_patch.resonator_a.decay_seconds = 0.37F;
    engine.set_patch(edited_patch);
    require_held_awake(engine, "set_patch dropped or failed to wake held sleeper");
    if (engine.tail_sleep_stats().retired_voices != before_held_patch.retired_voices) {
        throw std::runtime_error("set_patch counted held sleeper as retired");
    }
    process_blocks(engine, left, right, 1U);

    require_eventual_sleep(engine, left, right, "held live-edit fixture never re-slept");
    const auto before_live_edit = engine.tail_sleep_stats();
    auto live_patch = edited_patch;
    live_patch.resonator_a.decay_seconds = 0.29F;
    engine.set_live_decay_patch(live_patch, true, false);
    require_held_awake(engine, "live patch edit dropped or failed to wake held sleeper");
    if (engine.tail_sleep_stats().retired_voices != before_live_edit.retired_voices) {
        throw std::runtime_error("live patch edit counted held sleeper as retired");
    }
    process_blocks(engine, left, right, 1U);

    require_eventual_sleep(engine, left, right, "held policy-disable fixture never re-slept");
    const auto before_held_disable = engine.tail_sleep_stats();
    engine.set_tail_policy(brk::modal::TailPolicy::Disabled);
    require_held_awake(engine, "policy disable dropped or failed to wake held sleeper");
    if (engine.tail_sleep_stats().retired_voices != before_held_disable.retired_voices) {
        throw std::runtime_error("policy disable counted held sleeper as retired");
    }
    process_blocks(engine, left, right, 1U);
    engine.choke(15U);

    // Reference remains pinned to its existing held-note route; Conservative
    // sleep must not change pressed-note behavior there.
    engine.set_tail_policy(brk::modal::TailPolicy::Conservative);
    auto reference_patch = lifecycle_patch;
    reference_patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    reference_patch.resonator_a.decay_seconds = 0.04F;
    reference_patch.resonator_b.decay_seconds = 0.05F;
    engine.set_patch(reference_patch);
    const auto reference_entries = engine.tail_sleep_stats().entries;
    engine.note_on({16U, 52, 0.75F, 0.0F});
    process_blocks(engine, left, right, 2048U);
    if (engine.tail_sleep_stats().entries != reference_entries || engine.sleeping_voice_count() != 0U
        || engine.active_voice_count() != 1U || engine.held_voice_count() != 1U) {
        throw std::runtime_error("Reference held voice entered Conservative sleep");
    }
    engine.choke(16U);

    // Upstream ADSR is explicitly excluded: even a long-held voice must keep
    // advancing its envelope state instead of being frozen by the legacy-tail optimization.
    auto upstream_patch = lifecycle_patch;
    upstream_patch.exciter.use_upstream_noise = true;
    upstream_patch.exciter.noise_attack_ms = 1.0F;
    upstream_patch.exciter.noise_decay_ms = 1.0F;
    upstream_patch.exciter.noise_sustain = 0.0F;
    upstream_patch.exciter.noise_direct = 0.0F;
    upstream_patch.exciter.noise_resonator = 0.0F;
    upstream_patch.exciter.mallet_direct = 0.0F;
    upstream_patch.exciter.mallet_resonator = 0.0F;
    upstream_patch.resonator_a.decay_seconds = 0.04F;
    upstream_patch.resonator_b.decay_seconds = 0.05F;
    engine.set_patch(upstream_patch);
    const auto upstream_entries = engine.tail_sleep_stats().entries;
    engine.note_on({17U, 55, 0.72F, 0.0F});
    process_blocks(engine, left, right, 2048U);
    if (engine.tail_sleep_stats().entries != upstream_entries || engine.sleeping_voice_count() != 0U
        || engine.active_voice_count() != 1U || engine.held_voice_count() != 1U) {
        throw std::runtime_error("upstream ADSR held voice entered Conservative sleep");
    }
    engine.choke(17U);

    engine.set_patch(lifecycle_patch);
    engine.note_on({14U, 60, 0.7F, 0.0F});
    engine.reset();
    if (engine.active_voice_count() != 0U || engine.sleeping_voice_count() != 0U) {
        throw std::runtime_error("reset left live tail state");
    }
    const auto reset_stats = engine.tail_sleep_stats();
    if (reset_stats.entries != 0U || reset_stats.retired_voices != 0U
        || reset_stats.recycled_voices != 0U || reset_stats.skipped_voice_frames != 0U) {
        throw std::runtime_error("reset did not clear tail statistics");
    }
}

} // namespace

int main() {
    try {
        brk::modal::Engine probe;
        if (!probe.prepare(kSampleRate, kBlockSize, 1U)) throw std::runtime_error("probe prepare failed");
        if (probe.tail_policy() != brk::modal::TailPolicy::Disabled) {
            throw std::runtime_error("no-sleep oracle is not the default");
        }
        if (std::string(brk::modal::tail_policy_name(brk::modal::TailPolicy::Conservative)) != "conservative") {
            throw std::runtime_error("tail policy name mismatch");
        }

        constexpr std::size_t kRenderBlocks = 3200U;
        const auto parity_patch = natural_tail_patch();
        const auto oracle = render(parity_patch, brk::modal::TailPolicy::Disabled, kRenderBlocks);
        const auto candidate = render(parity_patch, brk::modal::TailPolicy::Conservative, kRenderBlocks);
        const auto metrics = compare(oracle, candidate);

        if (oracle.stats.entries != 0U || oracle.stats.skipped_voice_frames != 0U) {
            throw std::runtime_error("disabled oracle recorded tail sleep work");
        }
        if (candidate.stats.entries < 2U || candidate.stats.skipped_voice_frames == 0U) {
            throw std::runtime_error("conservative candidate did not skip terminal-tail work");
        }
        if (candidate.first_sleep_frame == std::numeric_limits<std::uint64_t>::max()) {
            throw std::runtime_error("sleep frame was not observed");
        }
        if (metrics.maximum > 1.5e-6 || metrics.rms > 1.0e-7 || metrics.snr_db < 100.0) {
            std::cerr << "max=" << metrics.maximum << " rms=" << metrics.rms
                      << " signal_rms=" << metrics.signal_rms << " snr_db=" << metrics.snr_db << '\n';
            throw std::runtime_error("tail sleep audio error exceeded conservative gate");
        }

        lifecycle_checks();

        std::cout << "tail_policy_default=disabled\n";
        std::cout << "sleep_entries=" << candidate.stats.entries << '\n';
        std::cout << "skipped_voice_frames=" << candidate.stats.skipped_voice_frames << '\n';
        std::cout << "first_sleep_frame=" << candidate.first_sleep_frame << '\n';
        std::cout << "max_abs_error=" << metrics.maximum << '\n';
        std::cout << "rms_error=" << metrics.rms << '\n';
        std::cout << "snr_db=" << metrics.snr_db << '\n';
        std::cout << "held_sleep_lifecycle=ok\n";
        std::cout << "held_sleep_reference_excluded=ok\n";
        std::cout << "held_sleep_upstream_excluded=ok\n";
        std::cout << "lifecycle_wake=ok\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_tail_sleep_tests: " << error.what() << '\n';
        return 1;
    }
}

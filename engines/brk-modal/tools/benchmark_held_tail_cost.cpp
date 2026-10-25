#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
constexpr std::uint32_t kBlockSize = 128U;
constexpr double kSampleRate = 48000.0;
constexpr std::size_t kRounds = 7U;
constexpr std::size_t kMeasuredBlocks = 128U;
constexpr std::size_t kLatePrerollBlocks = 3750U; // 10 seconds.
constexpr float kSilentFloor = 1.0e-10F;
constexpr double kMaxSleepOverAwake = 0.50;
constexpr double kMaxSleepOverIdle = 2.00;
volatile double g_sink = 0.0;

struct SampleEvidence {
    std::uint64_t values = 0U;
    std::uint64_t subnormal = 0U;
    std::uint64_t exact_zero = 0U;
    float peak = 0.0F;
    float minimum_nonzero = std::numeric_limits<float>::infinity();
};

struct PhaseResult {
    double median_ns_per_block = 0.0;
    SampleEvidence evidence{};
    std::size_t active_voices = 0U;
    std::size_t held_voices = 0U;
    std::size_t sleeping_voices = 0U;
    brk::modal::TailSleepStats tail_stats{};
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

void observe(float value, SampleEvidence& evidence) {
    ++evidence.values;
    if (value == 0.0F) {
        ++evidence.exact_zero;
        return;
    }
    const float magnitude = std::abs(value);
    evidence.peak = std::max(evidence.peak, magnitude);
    evidence.minimum_nonzero = std::min(evidence.minimum_nonzero, magnitude);
    if (std::fpclassify(value) == FP_SUBNORMAL) ++evidence.subnormal;
}

bool render_blocks(brk::modal::Engine& engine,
                   std::size_t blocks,
                   std::array<float, kBlockSize>& left,
                   std::array<float, kBlockSize>& right) {
    for (std::size_t block = 0U; block < blocks; ++block) {
        engine.process(left.data(), right.data(), kBlockSize);
        for (std::size_t frame = 0U; frame < kBlockSize; ++frame) {
            if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])) return false;
        }
    }
    return true;
}

PhaseResult run_phase(std::size_t preroll_blocks,
                      bool trigger_note,
                      brk::modal::TailPolicy policy) {
    std::vector<double> timings;
    timings.reserve(kRounds);
    PhaseResult result{};

    for (std::size_t round = 0U; round < kRounds; ++round) {
        brk::modal::Engine engine;
        if (!engine.prepare(kSampleRate, kBlockSize, 0x48454c44434f5354ULL + round)) return {};
        engine.set_modal_kernel(brk::modal::ModalKernel::Scalar);
        engine.set_tail_policy(policy);
        engine.set_patch(held_tail_patch());
        if (trigger_note) engine.note_on({1U, 48, 0.9F, 0.0F});

        std::array<float, kBlockSize> left{};
        std::array<float, kBlockSize> right{};
        if (!render_blocks(engine, preroll_blocks, left, right)) return {};

        SampleEvidence evidence{};
        const auto begin = Clock::now();
        for (std::size_t block = 0U; block < kMeasuredBlocks; ++block) {
            engine.process(left.data(), right.data(), kBlockSize);
            for (std::size_t frame = 0U; frame < kBlockSize; ++frame) {
                if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])) return {};
                observe(left[frame], evidence);
                observe(right[frame], evidence);
            }
            g_sink += static_cast<double>(left.back()) + static_cast<double>(right.back());
        }
        const auto end = Clock::now();
        const double ns = std::chrono::duration<double, std::nano>(end - begin).count();
        timings.push_back(ns / static_cast<double>(kMeasuredBlocks));

        if (round == 0U) {
            result.evidence = evidence;
            result.active_voices = engine.active_voice_count();
            result.held_voices = engine.held_voice_count();
            result.sleeping_voices = engine.sleeping_voice_count();
            result.tail_stats = engine.tail_sleep_stats();
        }
    }

    std::sort(timings.begin(), timings.end());
    result.median_ns_per_block = timings[timings.size() / 2U];
    return result;
}

void print_phase(const char* name, const PhaseResult& phase) {
    const double subnormal_fraction = phase.evidence.values == 0U ? 0.0
        : static_cast<double>(phase.evidence.subnormal) / static_cast<double>(phase.evidence.values);
    std::cout << name << "_median_ns_per_block=" << phase.median_ns_per_block << '\n';
    std::cout << name << "_sample_values=" << phase.evidence.values << '\n';
    std::cout << name << "_subnormal_values=" << phase.evidence.subnormal << '\n';
    std::cout << name << "_subnormal_fraction=" << subnormal_fraction << '\n';
    std::cout << name << "_exact_zero_values=" << phase.evidence.exact_zero << '\n';
    std::cout << name << "_peak=" << phase.evidence.peak << '\n';
    std::cout << name << "_minimum_nonzero=" << phase.evidence.minimum_nonzero << '\n';
    std::cout << name << "_active_voices=" << phase.active_voices << '\n';
    std::cout << name << "_held_voices=" << phase.held_voices << '\n';
    std::cout << name << "_sleeping_voices=" << phase.sleeping_voices << '\n';
    std::cout << name << "_sleep_entries=" << phase.tail_stats.entries << '\n';
    std::cout << name << "_retired_voices=" << phase.tail_stats.retired_voices << '\n';
    std::cout << name << "_skipped_voice_frames=" << phase.tail_stats.skipped_voice_frames << '\n';
}

bool valid_phase(const PhaseResult& phase) {
    return phase.median_ns_per_block > 0.0
        && std::isfinite(phase.median_ns_per_block)
        && phase.evidence.values == 2U * kMeasuredBlocks * kBlockSize;
}

} // namespace

int main() {
#ifdef __EMSCRIPTEN__
    std::cout << "held_tail_cost_backend=wasm\n";
#else
    std::cout << "held_tail_cost_backend=native\n";
#endif
    std::cout << "held_tail_cost_rounds=" << kRounds << '\n';
    std::cout << "held_tail_cost_measured_blocks=" << kMeasuredBlocks << '\n';

    const auto idle = run_phase(0U, false, brk::modal::TailPolicy::Conservative);
    const auto awake_late = run_phase(kLatePrerollBlocks, true, brk::modal::TailPolicy::Disabled);
    const auto sleeping_late = run_phase(kLatePrerollBlocks, true, brk::modal::TailPolicy::Conservative);
    if (!valid_phase(idle) || !valid_phase(awake_late) || !valid_phase(sleeping_late)) {
        std::cerr << "invalid held-tail benchmark phase\n";
        return 1;
    }

    if (idle.active_voices != 0U || idle.held_voices != 0U || idle.sleeping_voices != 0U) return 2;
    if (awake_late.active_voices != 1U || awake_late.held_voices != 1U
        || awake_late.sleeping_voices != 0U || awake_late.tail_stats.entries != 0U) return 3;
    if (sleeping_late.active_voices != 1U || sleeping_late.held_voices != 1U
        || sleeping_late.sleeping_voices != 1U || sleeping_late.tail_stats.entries != 1U
        || sleeping_late.tail_stats.retired_voices != 0U
        || sleeping_late.tail_stats.skipped_voice_frames == 0U) return 4;
    if (!(awake_late.evidence.peak <= kSilentFloor)) return 5;
    if (sleeping_late.evidence.peak != 0.0F
        || sleeping_late.evidence.exact_zero != sleeping_late.evidence.values
        || sleeping_late.evidence.subnormal != 0U) return 6;

    const double sleep_over_awake = sleeping_late.median_ns_per_block / awake_late.median_ns_per_block;
    const double sleep_over_idle = sleeping_late.median_ns_per_block / idle.median_ns_per_block;
    const double awake_over_idle = awake_late.median_ns_per_block / idle.median_ns_per_block;

    print_phase("idle", idle);
    print_phase("awake_late", awake_late);
    print_phase("sleeping_late", sleeping_late);
    std::cout << "sleep_over_awake=" << sleep_over_awake << '\n';
    std::cout << "sleep_over_idle=" << sleep_over_idle << '\n';
    std::cout << "awake_over_idle=" << awake_over_idle << '\n';
    std::cout << "sleep_over_awake_gate=" << kMaxSleepOverAwake << '\n';
    std::cout << "sleep_over_idle_gate=" << kMaxSleepOverIdle << '\n';

    if (!(sleep_over_awake <= kMaxSleepOverAwake)) {
        std::cerr << "held sleep did not reduce late held DSP cost enough\n";
        return 7;
    }
    if (!(sleep_over_idle <= kMaxSleepOverIdle)) {
        std::cerr << "held sleep remained too expensive relative to idle\n";
        return 8;
    }

    std::cout << "held_tail_cost_lifecycle=PASS\n";
    std::cout << "held_tail_cost_reduction=PASS\n";
    std::cout << "brk_modal_held_tail_cost_evidence=PASS\n";
    return 0;
}

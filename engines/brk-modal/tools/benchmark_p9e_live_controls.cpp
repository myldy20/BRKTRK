#include "brk_modal/brk_modal.hpp"

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string_view>

namespace {
using Clock = std::chrono::steady_clock;
constexpr std::uint32_t kRate = 48000U;
constexpr std::uint32_t kBlock = 128U;
constexpr int kIterations = 1600;

brk::modal::Patch make_patch() {
    brk::modal::Patch patch{};
    patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.polyphony = 8;
    patch.resonator_a.model = brk::modal::Model::Squared;
    patch.resonator_a.partials = 32;
    patch.resonator_a.decay_seconds = 4.5F;
    patch.resonator_a.material = -0.47F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::Marimba;
    patch.resonator_b.partials = 32;
    patch.resonator_b.decay_seconds = 16.2F;
    patch.resonator_b.material = -0.57F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.noise_resonator = 0.23F;
    patch.resonator_gain_db = -6.0F;
    return patch;
}

void seed_voices(brk::modal::Engine& engine, const brk::modal::Patch& patch) {
    engine.set_patch(patch);
    constexpr std::array<std::int16_t, 8> keys{84, 86, 88, 89, 91, 93, 95, 96};
    for (std::size_t i = 0; i < keys.size(); ++i) {
        engine.note_on({static_cast<std::uint32_t>(i + 1U), keys[i], 1.0F, 0.0F});
    }
}

template <typename Fn>
double time_ms(Fn&& fn) {
    const auto begin = Clock::now();
    fn();
    return std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
}

void print_case(std::string_view name, double generic_ms, double fast_ms) {
    std::cout << name << "_generic_ms=" << generic_ms << '\n';
    std::cout << name << "_fast_ms=" << fast_ms << '\n';
    std::cout << name << "_ratio=" << (generic_ms > 0.0 ? fast_ms / generic_ms : 0.0) << '\n';
}

bool run_reconfigure_benchmark() {
    auto patch = make_patch();
    brk::modal::Engine generic_width;
    brk::modal::Engine fast_width;
    brk::modal::Engine generic_tone;
    brk::modal::Engine fast_tone;
    brk::modal::Engine generic_all;
    brk::modal::Engine fast_all;
    for (auto* engine : {&generic_width, &fast_width, &generic_tone, &fast_tone, &generic_all, &fast_all}) {
        if (!engine->prepare(kRate, kBlock, 0x42454e43U)) return false;
        seed_voices(*engine, patch);
    }

    const double generic_width_ms = time_ms([&] {
        auto p = patch;
        for (int i = 0; i < kIterations; ++i) {
            p.stereo_width = 0.5F + 0.5F * static_cast<float>(i & 1);
            generic_width.set_patch(p);
        }
    });
    const double fast_width_ms = time_ms([&] {
        auto p = patch;
        for (int i = 0; i < kIterations; ++i) {
            p.stereo_width = 0.5F + 0.5F * static_cast<float>(i & 1);
            fast_width.set_live_performance_patch(
                p, false, false, false, false, false, false, true);
        }
    });

    const double generic_tone_ms = time_ms([&] {
        auto p = patch;
        for (int i = 0; i < kIterations; ++i) {
            const float phase = static_cast<float>(i % 64) / 63.0F;
            p.resonator_a.tone = -0.25F + 0.70F * phase;
            generic_tone.set_patch(p);
        }
    });
    const double fast_tone_ms = time_ms([&] {
        auto p = patch;
        for (int i = 0; i < kIterations; ++i) {
            const float phase = static_cast<float>(i % 64) / 63.0F;
            p.resonator_a.tone = -0.25F + 0.70F * phase;
            fast_tone.set_live_performance_patch(
                p, false, false, true, false, false, false, false);
        }
    });

    const double generic_all_ms = time_ms([&] {
        auto p = patch;
        for (int i = 0; i < kIterations; ++i) {
            const float phase = static_cast<float>(i % 64) / 63.0F;
            p.resonator_a.decay_seconds = 2.25F + 2.25F * phase;
            p.resonator_a.material = -0.47F + 0.62F * phase;
            p.resonator_a.tone = 0.35F * phase;
            p.stereo_width = 0.5F + 0.5F * phase;
            generic_all.set_patch(p);
        }
    });
    const double fast_all_ms = time_ms([&] {
        auto p = patch;
        for (int i = 0; i < kIterations; ++i) {
            const float phase = static_cast<float>(i % 64) / 63.0F;
            p.resonator_a.decay_seconds = 2.25F + 2.25F * phase;
            p.resonator_a.material = -0.47F + 0.62F * phase;
            p.resonator_a.tone = 0.35F * phase;
            p.stereo_width = 0.5F + 0.5F * phase;
            fast_all.set_live_performance_patch(
                p, true, true, true, false, false, false, true);
        }
    });

    print_case("width_only", generic_width_ms, fast_width_ms);
    print_case("tone_only", generic_tone_ms, fast_tone_ms);
    print_case("four_control", generic_all_ms, fast_all_ms);
    return fast_width_ms < generic_width_ms
        && fast_tone_ms < generic_tone_ms
        && fast_all_ms < generic_all_ms;
}

bool run_high_register_steal_probe() {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 0x53544541U)) return false;
    auto patch = make_patch();
    patch.stereo_width = 0.5F;
    patch.resonator_a.decay_seconds = 2.25F;
    patch.resonator_a.material = 0.0F;
    patch.resonator_a.tone = 0.0F;
    engine.set_patch(patch);

    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    float previous = 0.0F;
    float previous_delta = 0.0F;
    float max_delta = 0.0F;
    float max_second_delta = 0.0F;
    float peak = 0.0F;
    std::uint32_t next_id = 1U;
    constexpr std::array<std::int16_t, 12> keys{84, 86, 88, 89, 91, 93, 95, 96, 97, 98, 99, 100};

    for (int block = 0; block < 220; ++block) {
        if (block % 4 == 0) {
            const auto key = keys[static_cast<std::size_t>((block / 4) % static_cast<int>(keys.size()))];
            engine.note_on({next_id++, key, 1.0F, 0.0F});
        }
        engine.process(left.data(), right.data(), kBlock);
        for (std::size_t i = 0; i < kBlock; ++i) {
            if (!std::isfinite(left[i]) || !std::isfinite(right[i])) return false;
            const float mono = 0.5F * (left[i] + right[i]);
            peak = std::max(peak, std::max(std::abs(left[i]), std::abs(right[i])));
            const float delta = mono - previous;
            max_delta = std::max(max_delta, std::abs(delta));
            max_second_delta = std::max(max_second_delta, std::abs(delta - previous_delta));
            previous_delta = delta;
            previous = mono;
        }
    }
    std::cout << "high_register_steal_peak=" << peak << '\n';
    std::cout << "high_register_steal_max_delta=" << max_delta << '\n';
    std::cout << "high_register_steal_max_second_delta=" << max_second_delta << '\n';
    return peak < 1.0F;
}
} // namespace

int main() {
    const bool benchmark_ok = run_reconfigure_benchmark();
    const bool probe_ok = run_high_register_steal_probe();
    return benchmark_ok && probe_ok ? 0 : 1;
}

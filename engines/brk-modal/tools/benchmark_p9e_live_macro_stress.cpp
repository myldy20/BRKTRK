#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string_view>

namespace {
using Clock = std::chrono::steady_clock;
constexpr std::uint32_t kRate = 48000U;
constexpr std::uint32_t kBlock = 128U;

// This is a diagnostic benchmark, not a product quality gate. It reproduces the
// musician-facing live macro path with render work between coefficient updates.
enum class Macro {
    Width,
    WidthReverse,
    Decay,
    Material,
    Tone,
    All,
};

brk::modal::Patch crystal_patch() {
    brk::modal::Patch patch{};
    patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.polyphony = 8;

    patch.resonator_a.enabled = true;
    patch.resonator_a.model = brk::modal::Model::Squared;
    patch.resonator_a.partials = 32;
    patch.resonator_a.max_render_partials = 32;
    patch.resonator_a.decay_seconds = 4.5F;
    patch.resonator_a.material = -0.47F;
    patch.resonator_a.tone = 0.0F;
    patch.resonator_a.hit_position = 0.26F;
    patch.resonator_a.inharmonicity = 0.0001F;
    patch.resonator_a.ratio = 0.78F;
    patch.resonator_a.release_scale = 0.55F;
    patch.resonator_a.normalize_modal_energy = false;

    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::Marimba;
    patch.resonator_b.partials = 32;
    patch.resonator_b.max_render_partials = 32;
    patch.resonator_b.decay_seconds = 16.2F;
    patch.resonator_b.material = -0.57F;
    patch.resonator_b.tone = 0.0F;
    patch.resonator_b.hit_position = 0.26F;
    patch.resonator_b.inharmonicity = 0.0001F;
    patch.resonator_b.ratio = 0.78F;
    patch.resonator_b.release_scale = 1.0F;
    patch.resonator_b.normalize_modal_energy = false;

    patch.exciter.use_upstream_noise = true;
    patch.exciter.mallet_direct = 0.0F;
    patch.exciter.mallet_resonator = 0.0F;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.23F;
    patch.exciter.noise_filter_mode = brk::modal::NoiseFilterMode::BandPass;
    patch.exciter.noise_filter_frequency_hz = 2784.0F;
    patch.exciter.noise_filter_q = 3.047F;
    patch.exciter.noise_attack_ms = 1.0F;
    patch.exciter.noise_decay_ms = 23.0F;
    patch.exciter.noise_sustain = 0.0F;
    patch.exciter.noise_release_ms = 407.0F;

    // The imported Reference preset has no BRK macro-velocity layer.
    patch.velocity.response = 0.0F;
    patch.velocity.decay_octaves = 0.0F;
    patch.velocity.material = 0.0F;
    patch.velocity.tone = 0.0F;
    patch.velocity.inharmonicity = 0.0F;
    patch.resonator_gain_db = -6.0F;
    patch.output_gain_db = -3.0F;
    return patch;
}

void seed_voices(brk::modal::Engine& engine, const brk::modal::Patch& patch, int base_key) {
    engine.set_patch(patch);
    constexpr std::array<int, 8> offsets{0, 2, 4, 5, 7, 9, 11, 12};
    for (std::size_t index = 0; index < offsets.size(); ++index) {
        engine.note_on({
            static_cast<std::uint32_t>(index + 1U),
            static_cast<std::int16_t>(base_key + offsets[index]),
            1.0F,
            0.0F,
        });
    }
}

struct PhaseMetrics {
    float peak = 0.0F;
    float max_delta = 0.0F;
    float max_second_delta = 0.0F;
};

struct ContinuousTracker {
    bool have_previous = false;
    bool have_previous_delta = false;
    float previous = 0.0F;
    float previous_delta = 0.0F;

    void add(float left, float right, PhaseMetrics& metrics) noexcept {
        const float mono = 0.5F * (left + right);
        metrics.peak = std::max(metrics.peak, std::max(std::abs(left), std::abs(right)));
        if (!have_previous) {
            previous = mono;
            have_previous = true;
            return;
        }
        const float delta = mono - previous;
        metrics.max_delta = std::max(metrics.max_delta, std::abs(delta));
        if (have_previous_delta) {
            metrics.max_second_delta = std::max(
                metrics.max_second_delta,
                std::abs(delta - previous_delta));
        }
        previous_delta = delta;
        have_previous_delta = true;
        previous = mono;
    }
};

struct Result {
    double ramp_total_ms = 0.0;
    double ramp_max_128_ms = 0.0;
    double pre_max_128_ms = 0.0;
    PhaseMetrics pre{};
    PhaseMetrics ramp{};
    PhaseMetrics post{};
};

std::uint32_t ramp_frames(Macro macro) noexcept {
    switch (macro) {
        case Macro::Decay:
        case Macro::All:
            return 576U; // 12 ms Decay policy.
        case Macro::WidthReverse:
            return 768U; // two serialized 8 ms Width ramps.
        default:
            return 384U; // 8 ms Material/Tone/Width policy.
    }
}

void update_patch(brk::modal::Patch& patch, Macro macro, std::uint32_t frame) noexcept {
    const auto ramp = [](std::uint32_t f, std::uint32_t frames) noexcept {
        return frames <= 1U ? 1.0F
            : std::min(1.0F, static_cast<float>(f) / static_cast<float>(frames - 1U));
    };

    if (macro == Macro::WidthReverse) {
        if (frame < 384U) {
            const float t = ramp(frame, 384U);
            patch.stereo_width = 1.0F + (0.05F - 1.0F) * t;
        } else {
            const float t = ramp(frame - 384U, 384U);
            patch.stereo_width = 0.05F + (0.5F - 0.05F) * t;
        }
        return;
    }

    const float t8 = ramp(frame, 384U);
    const float t12 = ramp(frame, 576U);
    if (macro == Macro::Width || macro == Macro::All) {
        patch.stereo_width = 1.0F + (0.5F - 1.0F) * t8;
    }
    if (macro == Macro::Decay || macro == Macro::All) {
        patch.resonator_a.decay_seconds = 4.5F + (2.25F - 4.5F) * t12;
    }
    if (macro == Macro::Material || macro == Macro::All) {
        patch.resonator_a.material = -0.47F + (0.0F + 0.47F) * t8;
    }
    if (macro == Macro::Tone) {
        patch.resonator_a.tone = 0.35F * t8;
    }
}

void apply_live(
    brk::modal::Engine& engine,
    const brk::modal::Patch& patch,
    Macro macro,
    std::uint32_t frame) noexcept {

    const bool eight_ms_active = frame < 384U;
    const bool update_width = macro == Macro::Width
        || macro == Macro::WidthReverse
        || (macro == Macro::All && eight_ms_active);
    const bool update_decay = macro == Macro::Decay || macro == Macro::All;
    const bool update_material = macro == Macro::Material
        || (macro == Macro::All && eight_ms_active);
    const bool update_tone = macro == Macro::Tone;
    engine.set_live_performance_patch(
        patch,
        update_decay, update_material, update_tone,
        false, false, false,
        update_width);
}

Result run_case(Macro macro, int base_key, brk::modal::ModalKernel kernel) {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 0x4d414352U + static_cast<unsigned>(base_key))) {
        throw std::runtime_error("BRK Modal prepare failed");
    }
    engine.set_modal_kernel(kernel);
    engine.set_tail_policy(brk::modal::TailPolicy::Disabled);
    auto patch = crystal_patch();
    seed_voices(engine, patch, base_key);

    Result result{};
    ContinuousTracker tracker{};
    PhaseMetrics discard{};
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};

    for (int block = 0; block < 24; ++block) {
        const auto begin = Clock::now();
        engine.process(left.data(), right.data(), kBlock);
        const double elapsed = std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
        if (block >= 18) result.pre_max_128_ms = std::max(result.pre_max_128_ms, elapsed);
        for (std::size_t i = 0; i < kBlock; ++i) {
            tracker.add(left[i], right[i], block >= 18 ? result.pre : discard);
        }
    }

    const std::uint32_t frames = ramp_frames(macro);
    const auto ramp_begin = Clock::now();
    for (std::uint32_t chunk = 0; chunk < frames; chunk += kBlock) {
        const std::uint32_t chunk_end = std::min(frames, chunk + kBlock);
        const auto chunk_begin = Clock::now();
        for (std::uint32_t frame = chunk; frame < chunk_end; ++frame) {
            update_patch(patch, macro, frame);
            apply_live(engine, patch, macro, frame);
            float out_left = 0.0F;
            float out_right = 0.0F;
            engine.process(&out_left, &out_right, 1U);
            if (!std::isfinite(out_left) || !std::isfinite(out_right)) {
                throw std::runtime_error("non-finite live macro output");
            }
            tracker.add(out_left, out_right, result.ramp);
        }
        result.ramp_max_128_ms = std::max(
            result.ramp_max_128_ms,
            std::chrono::duration<double, std::milli>(Clock::now() - chunk_begin).count());
    }
    result.ramp_total_ms = std::chrono::duration<double, std::milli>(Clock::now() - ramp_begin).count();

    for (int block = 0; block < 24; ++block) {
        engine.process(left.data(), right.data(), kBlock);
        for (std::size_t i = 0; i < kBlock; ++i) tracker.add(left[i], right[i], result.post);
    }
    return result;
}

const char* macro_name(Macro macro) noexcept {
    switch (macro) {
        case Macro::Width: return "width";
        case Macro::WidthReverse: return "width_reverse";
        case Macro::Decay: return "decay";
        case Macro::Material: return "material";
        case Macro::Tone: return "tone";
        case Macro::All: return "all_to_middle";
    }
    return "unknown";
}

void print_result(
    std::string_view register_name,
    Macro macro,
    std::string_view kernel_name,
    const Result& result) {

    const double d2_ratio = result.pre.max_second_delta > 0.0F
        ? static_cast<double>(result.ramp.max_second_delta / result.pre.max_second_delta)
        : 0.0;
    std::cout
        << "live_macro_stress register=" << register_name
        << " control=" << macro_name(macro)
        << " kernel=" << kernel_name
        << " pre_max_128_ms=" << result.pre_max_128_ms
        << " ramp_total_ms=" << result.ramp_total_ms
        << " ramp_max_128_ms=" << result.ramp_max_128_ms
        << " pre_peak=" << result.pre.peak
        << " ramp_peak=" << result.ramp.peak
        << " post_peak=" << result.post.peak
        << " pre_d2=" << result.pre.max_second_delta
        << " ramp_d2=" << result.ramp.max_second_delta
        << " d2_ratio=" << d2_ratio
        << " post_d2=" << result.post.max_second_delta
        << '\n';
}
} // namespace

int main() {
    constexpr std::array<Macro, 6> cases{
        Macro::Width,
        Macro::WidthReverse,
        Macro::Decay,
        Macro::Material,
        Macro::Tone,
        Macro::All,
    };
    for (const auto& register_case : {
             std::pair<std::string_view, int>{"C4", 60},
             std::pair<std::string_view, int>{"C6", 84},
         }) {
        for (const Macro macro : cases) {
            print_result(
                register_case.first,
                macro,
                "scalar",
                run_case(macro, register_case.second, brk::modal::ModalKernel::Scalar));
            if (brk::modal::modal_vector_kernel_available()) {
                print_result(
                    register_case.first,
                    macro,
                    "vector4",
                    run_case(macro, register_case.second, brk::modal::ModalKernel::Vector4));
            }
        }
    }
    return 0;
}

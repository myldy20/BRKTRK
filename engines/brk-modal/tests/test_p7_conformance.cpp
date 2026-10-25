#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using brk::modal::Engine;
using brk::modal::FactoryPatch;
using brk::modal::ModalKernel;
using brk::modal::NoteOn;
using brk::modal::Patch;
using brk::modal::QualityProfile;
using brk::modal::TailPolicy;

struct RenderResult {
    std::vector<float> interleaved;
    float peak = 0.0F;
    std::size_t subnormals = 0U;
};

int fail(int code, const std::string& message) {
    std::cerr << "P7_CONFORMANCE_FAIL code=" << code << " " << message << '\n';
    return code;
}

bool finite_audio(const RenderResult& result) {
    for (const float sample : result.interleaved) {
        if (!std::isfinite(sample)) return false;
    }
    return true;
}

void inspect_sample(RenderResult& result, float left, float right) {
    result.peak = std::max(result.peak, std::max(std::abs(left), std::abs(right)));
    if (std::fpclassify(left) == FP_SUBNORMAL) ++result.subnormals;
    if (std::fpclassify(right) == FP_SUBNORMAL) ++result.subnormals;
    result.interleaved.push_back(left);
    result.interleaved.push_back(right);
}

RenderResult render_fixture(double sample_rate, std::uint32_t max_block_frames) {
    Engine engine;
    if (!engine.prepare(sample_rate, max_block_frames, 0x5037434f4e464f52ULL)) {
        throw std::runtime_error("prepare failed");
    }
    engine.set_modal_kernel(ModalKernel::Scalar);
    engine.set_tail_policy(TailPolicy::Disabled);
    const Patch source = brk::modal::make_factory_patch(FactoryPatch::DeepMembrane);
    engine.set_patch(brk::modal::apply_quality_profile(source, QualityProfile::Full));

    const std::uint32_t total_frames =
        static_cast<std::uint32_t>(std::llround(sample_rate * 0.30));
    const std::array<std::uint32_t, 8> event_frames{
        0U,
        static_cast<std::uint32_t>(std::llround(sample_rate / 16.0)),
        static_cast<std::uint32_t>(std::llround(sample_rate / 12.0)),
        static_cast<std::uint32_t>(std::llround(sample_rate / 10.0)),
        static_cast<std::uint32_t>(std::llround(sample_rate / 8.0)),
        static_cast<std::uint32_t>(std::llround(sample_rate / 6.0)),
        static_cast<std::uint32_t>(std::llround(sample_rate / 5.0)),
        static_cast<std::uint32_t>(std::llround(sample_rate / 4.0)),
    };

    RenderResult result;
    result.interleaved.reserve(static_cast<std::size_t>(total_frames) * 2U);
    std::vector<float> left(max_block_frames);
    std::vector<float> right(max_block_frames);

    std::uint32_t cursor = 0U;
    std::size_t next_event = 0U;
    while (cursor < total_frames) {
        while (next_event < event_frames.size() && event_frames[next_event] == cursor) {
            switch (next_event) {
            case 0:
                engine.note_on(NoteOn{1U, 43, 0.82F, 0.0F});
                engine.note_on(NoteOn{2U, 50, 0.64F, 0.0F});
                break;
            case 1: engine.set_sustain(true); break;
            case 2: engine.note_off(1U); break;
            case 3: engine.note_on(NoteOn{1U, 55, 0.71F, 0.0F}); break;
            case 4: engine.choke(2U); break;
            case 5: engine.set_sustain(false); break;
            case 6: engine.note_on(NoteOn{3U, 62, 0.58F, -0.15F}); break;
            case 7:
                engine.note_off(3U);
                engine.all_notes_off();
                break;
            default: break;
            }
            ++next_event;
        }

        const std::uint32_t next_boundary = next_event < event_frames.size()
            ? event_frames[next_event]
            : total_frames;
        const std::uint32_t until_boundary = next_boundary > cursor
            ? next_boundary - cursor
            : total_frames - cursor;
        const std::uint32_t frames = std::min(
            max_block_frames,
            std::min(until_boundary, total_frames - cursor));
        if (frames == 0U) continue;

        engine.process(left.data(), right.data(), frames);
        for (std::uint32_t frame = 0U; frame < frames; ++frame) {
            inspect_sample(result, left[frame], right[frame]);
        }
        cursor += frames;
    }
    return result;
}

float maximum_absolute_error(const RenderResult& a, const RenderResult& b) {
    if (a.interleaved.size() != b.interleaved.size()) {
        return std::numeric_limits<float>::infinity();
    }
    float maximum = 0.0F;
    for (std::size_t i = 0U; i < a.interleaved.size(); ++i) {
        maximum = std::max(maximum, std::abs(a.interleaved[i] - b.interleaved[i]));
    }
    return maximum;
}

std::uint32_t next_random(std::uint32_t& state) {
    state = state * 1664525U + 1013904223U;
    return state;
}

float weird_value(std::uint32_t& state, std::size_t iteration) {
    switch (iteration % 9U) {
    case 0: return std::numeric_limits<float>::quiet_NaN();
    case 1: return std::numeric_limits<float>::infinity();
    case 2: return -std::numeric_limits<float>::infinity();
    case 3: return 1.0e30F;
    case 4: return -1.0e30F;
    default:
        return static_cast<float>(static_cast<std::int32_t>(next_random(state))) / 1000000.0F;
    }
}

bool run_malformed_patch_fuzz(std::size_t& failed_iteration) {
    Engine engine;
    if (!engine.prepare(48000.0, 64U, 0x503746555a5a0001ULL)) return false;
    engine.set_modal_kernel(ModalKernel::Scalar);
    std::array<float, 64> left{};
    std::array<float, 64> right{};
    std::uint32_t random = 0x7a31d00dU;

    for (std::size_t iteration = 0U; iteration < 128U; ++iteration) {
        Patch patch = brk::modal::make_factory_patch(FactoryPatch::GlassString);
        patch.resonator_a.decay_seconds = weird_value(random, iteration);
        patch.resonator_a.material = weird_value(random, iteration + 1U);
        patch.resonator_a.tone = weird_value(random, iteration + 2U);
        patch.resonator_a.inharmonicity = weird_value(random, iteration + 3U);
        patch.resonator_a.coarse_semitones = weird_value(random, iteration + 4U);
        patch.resonator_b.ratio = weird_value(random, iteration + 5U);
        patch.exciter.mallet_keytrack = weird_value(random, iteration + 6U);
        patch.exciter.noise_filter_frequency_hz = weird_value(random, iteration + 7U);
        patch.velocity.curve = weird_value(random, iteration + 8U);
        patch.resonator_gain_db = weird_value(random, iteration + 9U);
        patch.output_gain_db = weird_value(random, iteration + 10U);
        patch.parallel_mix = weird_value(random, iteration + 11U);
        patch.stereo_width = weird_value(random, iteration + 12U);

        engine.reset();
        engine.set_patch(patch);
        engine.note_on(NoteOn{
            static_cast<std::uint32_t>(iteration + 1U),
            static_cast<std::int16_t>(36 + (iteration % 48U)),
            0.7F,
            0.0F,
        });
        engine.process(left.data(), right.data(), static_cast<std::uint32_t>(left.size()));
        for (std::size_t frame = 0U; frame < left.size(); ++frame) {
            if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])
                || std::abs(left[frame]) > 8.0F || std::abs(right[frame]) > 8.0F) {
                failed_iteration = iteration;
                return false;
            }
        }
    }
    return true;
}

} // namespace

int main() {
    {
        Engine engine;
        if (engine.prepare(7999.0, 128U, 1U)) return fail(10, "accepted sample rate below minimum");
    }
    {
        Engine engine;
        if (engine.prepare(384001.0, 128U, 1U)) return fail(11, "accepted sample rate above maximum");
    }
    {
        Engine engine;
        if (engine.prepare(48000.0, 0U, 1U)) return fail(12, "accepted zero max block");
    }

    constexpr std::array<double, 2> sample_rates{44100.0, 48000.0};
    constexpr std::array<std::uint32_t, 7> block_sizes{1U, 7U, 31U, 64U, 127U, 128U, 257U};

    float worst_partition_error = 0.0F;
    float maximum_peak = 0.0F;
    std::size_t total_subnormals = 0U;

    for (const double sample_rate : sample_rates) {
        const RenderResult baseline = render_fixture(sample_rate, block_sizes.front());
        if (!finite_audio(baseline) || baseline.peak <= 1.0e-7F) {
            return fail(20, "baseline is non-finite or silent at sample_rate=" + std::to_string(sample_rate));
        }
        const RenderResult repeated = render_fixture(sample_rate, block_sizes.front());
        const float repeat_error = maximum_absolute_error(baseline, repeated);
        if (repeat_error != 0.0F) {
            return fail(21, "repeat determinism error=" + std::to_string(repeat_error));
        }

        for (const auto block_size : block_sizes) {
            const RenderResult candidate = render_fixture(sample_rate, block_size);
            if (!finite_audio(candidate) || candidate.peak <= 1.0e-7F) {
                return fail(22, "candidate non-finite/silent sr=" + std::to_string(sample_rate)
                    + " block=" + std::to_string(block_size));
            }
            const float error = maximum_absolute_error(baseline, candidate);
            worst_partition_error = std::max(worst_partition_error, error);
            maximum_peak = std::max(maximum_peak, candidate.peak);
            total_subnormals += candidate.subnormals;
            if (error != 0.0F) {
                return fail(23, "partition error=" + std::to_string(error)
                    + " sr=" + std::to_string(sample_rate)
                    + " block=" + std::to_string(block_size));
            }
        }
    }

    if (total_subnormals != 0U) {
        return fail(24, "output subnormals=" + std::to_string(total_subnormals));
    }
    std::size_t failed_fuzz_iteration = 0U;
    if (!run_malformed_patch_fuzz(failed_fuzz_iteration)) {
        return fail(30, "malformed patch fuzz failed iteration=" + std::to_string(failed_fuzz_iteration));
    }

    std::cout << "p7_sample_rates=44100,48000\n";
    std::cout << "p7_block_sizes=1,7,31,64,127,128,257\n";
    std::cout << "p7_partition_max_absolute_error=" << worst_partition_error << '\n';
    std::cout << "p7_deterministic_repeat=exact\n";
    std::cout << "p7_output_subnormals=" << total_subnormals << '\n';
    std::cout << "p7_malformed_patch_fuzz_cases=128\n";
    std::cout << "p7_maximum_peak=" << maximum_peak << '\n';
    return 0;
}

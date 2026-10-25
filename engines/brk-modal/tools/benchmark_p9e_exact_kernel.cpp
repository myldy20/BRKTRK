#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using brk::modal::Coupling;
using brk::modal::CouplingProfile;
using brk::modal::Engine;
using brk::modal::Model;
using brk::modal::ModalKernel;
using brk::modal::NoteOn;
using brk::modal::Patch;
using brk::modal::QualityProfile;
using brk::modal::ReleaseMode;
using brk::modal::StereoMode;

constexpr std::uint64_t kSeed = 0x42524b5039454142ULL;

Patch crystal_patch() {
    Patch patch{};
    patch.coupling_profile = CouplingProfile::Reference;
    patch.coupling = Coupling::Serial;
    patch.polyphony = 8;
    patch.stereo_mode = StereoMode::Comb;
    patch.stereo_width = 0.80F;
    patch.release_mode = ReleaseMode::Natural;
    patch.output_gain_db = -12.0F;
    patch.resonator_gain_db = 12.0F;

    patch.resonator_a.enabled = true;
    patch.resonator_a.model = Model::Squared;
    patch.resonator_a.partials = 32;
    patch.resonator_a.max_render_partials = 32;
    patch.resonator_a.decay_seconds = 4.5F;
    patch.resonator_a.material = -0.12F;
    patch.resonator_a.tone = 0.08F;
    patch.resonator_a.spectral_focus = 0.15F;

    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Marimba;
    patch.resonator_b.partials = 32;
    patch.resonator_b.max_render_partials = 32;
    patch.resonator_b.decay_seconds = 16.2F;
    patch.resonator_b.material = -0.05F;
    patch.resonator_b.tone = 0.10F;
    patch.resonator_b.spectral_focus = 0.12F;

    patch.exciter.mallet_direct = 0.0F;
    patch.exciter.mallet_resonator = 0.62F;
    patch.exciter.mallet_velocity_direct = 0.0F;
    patch.exciter.mallet_velocity_resonator = 0.0F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.72F;
    patch.exciter.noise_velocity_direct = 0.0F;
    patch.exciter.noise_velocity_resonator = 0.0F;
    patch.exciter.noise_attack_ms = 1.0F;
    patch.exciter.noise_decay_ms = 190.0F;
    patch.exciter.noise_sustain = 0.0F;
    patch.exciter.noise_release_ms = 407.0F;
    patch.exciter.noise_filter_frequency_hz = 5200.0F;
    patch.exciter.noise_filter_q = 0.85F;

    return brk::modal::apply_quality_profile(patch, QualityProfile::Balanced);
}

Patch spread_patch() {
    Patch patch = crystal_patch();
    patch.coupling = Coupling::Parallel;
    patch.stereo_mode = StereoMode::VoiceSpread;
    patch.stereo_width = 0.73F;
    patch.resonator_a.model = Model::Plate;
    patch.resonator_a.decay_seconds = 2.8F;
    patch.resonator_b.model = Model::Bell;
    patch.resonator_b.decay_seconds = 3.4F;
    patch.parallel_mix = 0.37F;
    return patch;
}

void trigger_chord(Engine& engine, std::uint32_t base_id = 1000U) {
    constexpr std::array<std::int16_t, 8> keys{36, 43, 48, 55, 60, 64, 67, 72};
    constexpr std::array<float, 8> velocities{0.21F, 0.34F, 0.47F, 0.58F, 0.69F, 0.78F, 0.89F, 1.0F};
    for (std::size_t i = 0; i < keys.size(); ++i) {
        engine.note_on(NoteOn{base_id + static_cast<std::uint32_t>(i), keys[i], velocities[i], 0.0F});
    }
}

void append_interleaved(std::ofstream& stream, const std::vector<float>& left, const std::vector<float>& right, std::uint32_t frames) {
    for (std::uint32_t i = 0; i < frames; ++i) {
        stream.write(reinterpret_cast<const char*>(&left[i]), sizeof(float));
        stream.write(reinterpret_cast<const char*>(&right[i]), sizeof(float));
    }
}

void render_corpus_case(
    std::ofstream& stream,
    ModalKernel kernel,
    double sample_rate,
    std::uint32_t max_block,
    Patch patch,
    std::uint32_t total_frames,
    bool exercise_lifecycle) {

    Engine engine;
    if (!engine.prepare(sample_rate, max_block, kSeed + static_cast<std::uint64_t>(sample_rate) + max_block)) {
        throw std::runtime_error("engine prepare failed");
    }
    engine.set_modal_kernel(kernel);
    engine.set_patch(patch);
    trigger_chord(engine);

    std::vector<float> left(max_block);
    std::vector<float> right(max_block);
    constexpr std::array<std::uint32_t, 10> partitions{1, 7, 31, 64, 127, 5, 96, 17, 128, 53};
    std::uint32_t rendered = 0U;
    std::size_t partition_index = 0U;
    bool sustain_on = false;
    bool sustain_off = false;
    bool edited = false;
    bool retriggered = false;
    bool choked = false;

    while (rendered < total_frames) {
        if (exercise_lifecycle) {
            const auto t = static_cast<double>(rendered) / sample_rate;
            if (!sustain_on && t >= 0.35) {
                engine.set_sustain(true);
                sustain_on = true;
            }
            if (!edited && t >= 0.70) {
                patch.exciter.noise_resonator = 0.41F;
                patch.exciter.noise_direct = 0.07F;
                patch.stereo_width = 0.49F;
                engine.set_patch(patch);
                edited = true;
            }
            if (!retriggered && t >= 1.00) {
                engine.note_on(NoteOn{1002U, 52, 0.63F, 0.125F});
                retriggered = true;
            }
            if (!sustain_off && t >= 1.25) {
                engine.set_sustain(false);
                for (std::uint32_t id = 1000U; id < 1008U; ++id) engine.note_off(id);
                sustain_off = true;
            }
            if (!choked && t >= 1.65) {
                engine.choke(1005U);
                choked = true;
            }
        } else if (rendered >= static_cast<std::uint32_t>(0.45 * sample_rate)) {
            for (std::uint32_t id = 1000U; id < 1008U; ++id) engine.note_off(id);
        }

        std::uint32_t frames = std::min(partitions[partition_index++ % partitions.size()], max_block);
        frames = std::min(frames, total_frames - rendered);
        engine.process(left.data(), right.data(), frames);
        append_interleaved(stream, left, right, frames);
        rendered += frames;
    }
}

void write_oracle_corpus(const std::string& path) {
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("cannot open oracle output");

    const std::array<ModalKernel, 2> kernels{ModalKernel::Scalar, ModalKernel::Auto};
    for (const auto kernel : kernels) {
        render_corpus_case(stream, kernel, 44100.0, 257U, crystal_patch(), 44100U * 3U, true);
        render_corpus_case(stream, kernel, 48000.0, 128U, crystal_patch(), 48000U * 5U, true);
        render_corpus_case(stream, kernel, 96000.0, 192U, spread_patch(), 96000U * 2U, true);
        Patch single = crystal_patch();
        single.resonator_b.enabled = false;
        single.polyphony = 1;
        render_corpus_case(stream, kernel, 48000.0, 113U, single, 48000U * 2U, false);
    }
}

struct PhaseResult {
    std::string name;
    double median_ns_per_block = 0.0;
};

void render_frames(Engine& engine, std::uint32_t frames, std::vector<float>& left, std::vector<float>& right) {
    constexpr std::uint32_t block = 128U;
    while (frames != 0U) {
        const std::uint32_t count = std::min(block, frames);
        engine.process(left.data(), right.data(), count);
        frames -= count;
    }
}

double benchmark_phase(std::uint32_t preroll_frames, std::uint32_t measured_blocks) {
    std::vector<double> rounds;
    rounds.reserve(7U);
    for (int round = 0; round < 7; ++round) {
        Engine engine;
        if (!engine.prepare(48000.0, 128U, kSeed + static_cast<std::uint64_t>(round))) {
            throw std::runtime_error("benchmark prepare failed");
        }
        engine.set_modal_kernel(ModalKernel::Auto);
        engine.set_patch(crystal_patch());
        trigger_chord(engine, 2000U);
        std::vector<float> left(128U);
        std::vector<float> right(128U);
        render_frames(engine, preroll_frames, left, right);

        const auto start = std::chrono::steady_clock::now();
        for (std::uint32_t block = 0; block < measured_blocks; ++block) {
            engine.process(left.data(), right.data(), 128U);
        }
        const auto stop = std::chrono::steady_clock::now();
        const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count();
        rounds.push_back(static_cast<double>(ns) / static_cast<double>(measured_blocks));
    }
    std::sort(rounds.begin(), rounds.end());
    return rounds[rounds.size() / 2U];
}

std::vector<PhaseResult> benchmark_phases() {
    return {
        {"active_excitation", benchmark_phase(0U, 188U)},
        {"early_decay", benchmark_phase(24000U, 188U)},
        {"long_decay", benchmark_phase(96000U, 375U)},
        {"late_decay", benchmark_phase(192000U, 375U)},
    };
}

void write_report(const std::string& path, const std::vector<PhaseResult>& results) {
    std::ofstream stream(path, std::ios::trunc);
    if (!stream) throw std::runtime_error("cannot open report output");
    stream << "{\n  \"schema\": \"brk-modal-p9e-exact-kernel-benchmark-v1\",\n";
    stream << "  \"sampleRate\": 48000,\n  \"blockFrames\": 128,\n  \"voices\": 8,\n";
    stream << "  \"modalUnitsPerVoice\": 64,\n  \"estimatedModalWorkUnits\": 512,\n";
    stream << "  \"kernel\": \"" << brk::modal::modal_kernel_name(ModalKernel::Auto) << "\",\n";
    stream << "  \"phases\": {\n";
    for (std::size_t i = 0; i < results.size(); ++i) {
        const auto& row = results[i];
        stream << "    \"" << row.name << "\": {\"medianNsPerBlock\": "
               << std::fixed << std::setprecision(3) << row.median_ns_per_block << "}";
        stream << (i + 1U == results.size() ? "\n" : ",\n");
    }
    stream << "  }\n}\n";
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "usage: brk_modal_p9e_exact_kernel_benchmark <oracle.bin> <report.json>\n";
        return 2;
    }
    try {
        write_oracle_corpus(argv[1]);
        const auto results = benchmark_phases();
        write_report(argv[2], results);
        for (const auto& row : results) {
            std::cout << row.name << " median_ns_per_block=" << row.median_ns_per_block << '\n';
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}

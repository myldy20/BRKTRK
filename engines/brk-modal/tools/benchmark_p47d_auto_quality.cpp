#include "brk_modal/auto_quality.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kBlockSize = 128U;
constexpr std::uint32_t kRenderFrames = kSampleRate * 2U;
constexpr double kPi = 3.14159265358979323846;

struct RenderedAudio {
    std::vector<float> mono;
};

struct AudioError {
    double max_abs = 0.0;
    double rms = 0.0;
    double snr_db = 300.0;
    double spectral_residual_db = -300.0;
    double high_band_residual_db = -300.0;
};

struct CaseResult {
    std::string name;
    brk::modal::PatchStructureMetrics structure{};
    brk::modal::QualityApplicationReport report{};
    double full_us_per_block = 0.0;
    double balanced_us_per_block = 0.0;
    double cpu_ratio = 1.0;
    AudioError error{};
};

brk::modal::Patch make_tolerant_bar() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Marimba;
    patch.resonator_a.partials = 48U;
    patch.resonator_a.decay_seconds = 1.2F;
    patch.resonator_b.enabled = false;
    patch.release_mode = ReleaseMode::OneShot;
    patch.output_gain_db = -6.0F;
    return patch;
}

brk::modal::Patch make_general_gong() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Drumhead;
    patch.resonator_a.partials = 64U;
    patch.resonator_a.decay_seconds = 17.17F;
    patch.resonator_a.material = -0.76F;
    patch.resonator_a.inharmonicity = 0.0021F;
    patch.resonator_b.enabled = false;
    patch.release_mode = ReleaseMode::OneShot;
    patch.output_gain_db = -9.0F;
    return patch;
}

brk::modal::Patch make_dense_crash() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Plate;
    patch.resonator_a.partials = 64U;
    patch.resonator_a.decay_seconds = 5.39F;
    patch.resonator_a.material = 0.19F;
    patch.resonator_a.tone = 0.36F;
    patch.resonator_a.ratio = 0.78F;
    patch.resonator_a.coarse_semitones = -12.0F;
    patch.resonator_a.fine_cents = 14.0F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Plate;
    patch.resonator_b.partials = 64U;
    patch.resonator_b.decay_seconds = 9.53F;
    patch.resonator_b.tone = 0.30F;
    patch.resonator_b.ratio = 0.78F;
    patch.resonator_b.coarse_semitones = -3.0F;
    patch.resonator_b.fine_cents = 33.0F;
    patch.coupling = Coupling::Parallel;
    patch.parallel_mix = 0.5F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.mallet_direct = 0.0F;
    patch.exciter.mallet_resonator = 0.8F;
    patch.exciter.mallet_hardness_hz = 670.0F;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.1448F;
    patch.exciter.noise_filter_mode = NoiseFilterMode::BandPass;
    patch.exciter.noise_filter_frequency_hz = 1315.0F;
    patch.exciter.noise_filter_q = 2.017F;
    patch.exciter.noise_attack_ms = 12.0F;
    patch.exciter.noise_decay_ms = 1356.0F;
    patch.exciter.noise_release_ms = 1227.0F;
    patch.release_mode = ReleaseMode::OneShot;
    patch.resonator_gain_db = 10.32F;
    patch.output_gain_db = -2.5F;
    return patch;
}

bool render_patch(const brk::modal::Patch& patch, std::uint64_t seed, RenderedAudio& output) {
    using namespace brk::modal;
    Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, seed)) return false;
    engine.set_patch(patch);
    engine.note_on({1U, 52, 0.82F, 0.0F});

    output.mono.assign(kRenderFrames, 0.0F);
    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};
    for (std::uint32_t offset = 0U; offset < kRenderFrames; offset += kBlockSize) {
        engine.process(left.data(), right.data(), kBlockSize);
        for (std::uint32_t index = 0U; index < kBlockSize; ++index) {
            const float sample = 0.5F * (left[index] + right[index]);
            if (!std::isfinite(sample)) return false;
            output.mono[offset + index] = sample;
        }
    }
    return true;
}

AudioError compare_audio(const RenderedAudio& reference, const RenderedAudio& candidate) {
    AudioError result{};
    if (reference.mono.size() != candidate.mono.size() || reference.mono.empty()) {
        result.max_abs = 1.0;
        result.rms = 1.0;
        result.snr_db = -300.0;
        result.spectral_residual_db = 300.0;
        result.high_band_residual_db = 300.0;
        return result;
    }

    double reference_energy = 0.0;
    double difference_energy = 0.0;
    for (std::size_t index = 0U; index < reference.mono.size(); ++index) {
        const double ref = reference.mono[index];
        const double diff = candidate.mono[index] - ref;
        reference_energy += ref * ref;
        difference_energy += diff * diff;
        result.max_abs = std::max(result.max_abs, std::abs(diff));
    }
    result.rms = std::sqrt(difference_energy / static_cast<double>(reference.mono.size()));
    if (difference_energy > 0.0 && reference_energy > 0.0) {
        result.snr_db = 10.0 * std::log10(reference_energy / difference_energy);
    }

    constexpr std::size_t fft_size = 1024U;
    const std::size_t start = std::min<std::size_t>(
        reference.mono.size() - fft_size,
        kSampleRate / 2U);
    double spectral_reference = 0.0;
    double spectral_difference = 0.0;
    double high_reference = 0.0;
    double high_difference = 0.0;
    for (std::size_t bin = 1U; bin <= fft_size / 2U; ++bin) {
        double ref_real = 0.0;
        double ref_imag = 0.0;
        double diff_real = 0.0;
        double diff_imag = 0.0;
        for (std::size_t index = 0U; index < fft_size; ++index) {
            const double window = 0.5 - 0.5 * std::cos(
                2.0 * kPi * static_cast<double>(index) / static_cast<double>(fft_size - 1U));
            const double angle = -2.0 * kPi * static_cast<double>(bin * index)
                / static_cast<double>(fft_size);
            const double ref = window * reference.mono[start + index];
            const double diff = window * (candidate.mono[start + index] - reference.mono[start + index]);
            ref_real += ref * std::cos(angle);
            ref_imag += ref * std::sin(angle);
            diff_real += diff * std::cos(angle);
            diff_imag += diff * std::sin(angle);
        }
        const double ref_power = ref_real * ref_real + ref_imag * ref_imag;
        const double diff_power = diff_real * diff_real + diff_imag * diff_imag;
        spectral_reference += ref_power;
        spectral_difference += diff_power;
        const double frequency = static_cast<double>(bin * kSampleRate) / static_cast<double>(fft_size);
        if (frequency >= 4000.0) {
            high_reference += ref_power;
            high_difference += diff_power;
        }
    }
    if (spectral_difference > 0.0 && spectral_reference > 0.0) {
        result.spectral_residual_db = 10.0 * std::log10(spectral_difference / spectral_reference);
    }
    if (high_difference > 0.0 && high_reference > 0.0) {
        result.high_band_residual_db = 10.0 * std::log10(high_difference / high_reference);
    }
    return result;
}

double benchmark_patch(brk::modal::Patch patch, std::uint64_t seed) {
    using namespace brk::modal;
    patch.resonator_a.decay_seconds = std::max(20.0F, patch.resonator_a.decay_seconds);
    if (patch.resonator_b.enabled) {
        patch.resonator_b.decay_seconds = std::max(20.0F, patch.resonator_b.decay_seconds);
    }
    patch.release_mode = ReleaseMode::OneShot;

    std::array<double, 7U> runs{};
    for (std::size_t run = 0U; run < runs.size(); ++run) {
        Engine engine;
        if (!engine.prepare(kSampleRate, kBlockSize, seed + run)) return 0.0;
        engine.set_patch(patch);
        for (std::uint32_t note = 0U; note < 16U; ++note) {
            engine.note_on({note + 1U, static_cast<std::int16_t>(36 + note), 0.78F, 0.0F});
        }
        std::array<float, kBlockSize> left{};
        std::array<float, kBlockSize> right{};
        for (std::uint32_t warmup = 0U; warmup < 64U; ++warmup) {
            engine.process(left.data(), right.data(), kBlockSize);
        }
        constexpr std::uint32_t blocks = 1024U;
        const auto start = std::chrono::steady_clock::now();
        for (std::uint32_t block = 0U; block < blocks; ++block) {
            engine.process(left.data(), right.data(), kBlockSize);
        }
        const auto stop = std::chrono::steady_clock::now();
        runs[run] = std::chrono::duration<double, std::micro>(stop - start).count()
            / static_cast<double>(blocks);
    }
    std::sort(runs.begin(), runs.end());
    return runs[runs.size() / 2U];
}

void write_json_string(std::ostream& output, const std::string& value) {
    output << '"';
    for (const char character : value) {
        if (character == '"' || character == '\\') output << '\\';
        output << character;
    }
    output << '"';
}

} // namespace

int main(int argc, char** argv) {
    using namespace brk::modal;
    const std::string output_path = argc > 1 ? argv[1] : "p47d-auto-quality.json";
    const std::array<std::pair<const char*, Patch>, 3U> cases{{
        {"tolerant-bar", make_tolerant_bar()},
        {"general-gong", make_general_gong()},
        {"dense-crash", make_dense_crash()},
    }};

    std::vector<CaseResult> results;
    for (std::size_t index = 0U; index < cases.size(); ++index) {
        const Patch& source = cases[index].second;
        const Patch full = apply_auto_quality_profile(source, QualityProfile::Full);
        const Patch balanced = apply_auto_quality_profile(source, QualityProfile::Balanced);
        RenderedAudio full_audio{};
        RenderedAudio balanced_audio{};
        const std::uint64_t seed = 0x5034374400000000ULL + index;
        if (!render_patch(full, seed, full_audio) || !render_patch(balanced, seed, balanced_audio)) {
            std::cerr << "render failed for " << cases[index].first << '\n';
            return 1;
        }

        CaseResult result{};
        result.name = cases[index].first;
        result.structure = analyze_patch_structure(source);
        result.report = describe_auto_quality_application(source, QualityProfile::Balanced);
        result.error = compare_audio(full_audio, balanced_audio);
        result.full_us_per_block = benchmark_patch(full, seed + 0x1000U);
        result.balanced_us_per_block = benchmark_patch(balanced, seed + 0x1000U);
        result.cpu_ratio = result.full_us_per_block > 0.0
            ? result.balanced_us_per_block / result.full_us_per_block
            : 1.0;
        results.push_back(result);
    }

    std::ofstream output(output_path);
    if (!output) return 2;
    output << std::fixed << std::setprecision(9);
    output << "{\n  \"schema\": \"brk-modal-p47d-auto-quality-v1\",\n";
    output << "  \"sampleRate\": " << kSampleRate << ",\n";
    output << "  \"blockSize\": " << kBlockSize << ",\n";
    output << "  \"interpretation\": \"CPU ratios and residual-spectrum/audio errors must be read together; spectral reduction is never quality-neutral\",\n";
    output << "  \"cases\": [\n";
    for (std::size_t index = 0U; index < results.size(); ++index) {
        const CaseResult& result = results[index];
        output << "    {\n      \"name\": ";
        write_json_string(output, result.name);
        output << ",\n      \"spectrumClass\": ";
        write_json_string(output, patch_spectrum_class_name(result.structure.spectrum_class));
        output << ",\n      \"denseSpectrumGuard\": "
               << (result.report.dense_spectrum_guard ? "true" : "false") << ",\n";
        output << "      \"authoredModalCount\": " << result.report.authored_modal_count << ",\n";
        output << "      \"retainedModalCount\": " << result.report.retained_modal_count << ",\n";
        output << "      \"modalRetentionRatio\": " << result.report.modal_retention_ratio << ",\n";
        output << "      \"estimatedWorkRatio\": " << result.report.estimated_work_ratio << ",\n";
        output << "      \"fullMedianUsPerBlock\": " << result.full_us_per_block << ",\n";
        output << "      \"balancedMedianUsPerBlock\": " << result.balanced_us_per_block << ",\n";
        output << "      \"measuredCpuRatio\": " << result.cpu_ratio << ",\n";
        output << "      \"audioMaxAbsError\": " << result.error.max_abs << ",\n";
        output << "      \"audioRmsError\": " << result.error.rms << ",\n";
        output << "      \"audioSnrDb\": " << result.error.snr_db << ",\n";
        output << "      \"spectralResidualDb\": " << result.error.spectral_residual_db << ",\n";
        output << "      \"highBandResidualDb\": " << result.error.high_band_residual_db << "\n";
        output << "    }" << (index + 1U == results.size() ? "\n" : ",\n");
    }
    output << "  ]\n}\n";
    std::cout << "p47d_report=" << output_path << '\n';
    return 0;
}

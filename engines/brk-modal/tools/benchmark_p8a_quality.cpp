#include "brk_modal/auto_quality.hpp"
#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kBlockSize = 128U;
constexpr std::uint32_t kWarmupBlocks = 48U;
constexpr std::uint32_t kMeasuredBlocks = 256U;
constexpr std::size_t kRuns = 5U;

brk::modal::Patch make_sparse_bar() {
    using namespace brk::modal;
    Patch patch = make_factory_patch(FactoryPatch::WoodenBar);
    patch.polyphony = 16U;
    patch.resonator_a.partials = 48U;
    patch.resonator_b.enabled = false;
    patch.resonator_a.decay_seconds = 20.0F;
    patch.release_mode = ReleaseMode::OneShot;
    return patch;
}

brk::modal::Patch make_general_gong() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Drumhead;
    patch.resonator_a.partials = 64U;
    patch.resonator_a.decay_seconds = 20.0F;
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
    patch.resonator_a.decay_seconds = 20.0F;
    patch.resonator_a.material = 0.19F;
    patch.resonator_a.tone = 0.36F;
    patch.resonator_a.ratio = 0.78F;
    patch.resonator_a.coarse_semitones = -12.0F;
    patch.resonator_a.fine_cents = 14.0F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Plate;
    patch.resonator_b.partials = 64U;
    patch.resonator_b.decay_seconds = 20.0F;
    patch.resonator_b.tone = 0.30F;
    patch.resonator_b.ratio = 0.78F;
    patch.resonator_b.coarse_semitones = -3.0F;
    patch.resonator_b.fine_cents = 33.0F;
    patch.coupling = Coupling::Parallel;
    patch.parallel_mix = 0.5F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.mallet_resonator = 0.8F;
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

brk::modal::Patch make_serial_bell() {
    using namespace brk::modal;
    Patch patch = make_factory_patch(FactoryPatch::RitualBell);
    patch.resonator_a.decay_seconds = 20.0F;
    patch.resonator_b.decay_seconds = 20.0F;
    patch.release_mode = ReleaseMode::OneShot;
    return patch;
}

double benchmark(brk::modal::Patch patch, std::uint64_t seed) {
    using namespace brk::modal;
    std::array<double, kRuns> runs{};
    for (std::size_t run = 0U; run < runs.size(); ++run) {
        Engine engine;
        if (!engine.prepare(kSampleRate, kBlockSize, seed + run)) return 0.0;
        engine.set_modal_kernel(ModalKernel::Auto);
        engine.set_tail_policy(TailPolicy::Disabled);
        engine.set_patch(patch);
        for (std::uint32_t note = 0U; note < 16U; ++note) {
            engine.note_on({note + 1U, static_cast<std::int16_t>(36 + note), 0.78F, 0.0F});
        }
        std::array<float, kBlockSize> left{};
        std::array<float, kBlockSize> right{};
        for (std::uint32_t block = 0U; block < kWarmupBlocks; ++block) {
            engine.process(left.data(), right.data(), kBlockSize);
        }
        const auto start = std::chrono::steady_clock::now();
        for (std::uint32_t block = 0U; block < kMeasuredBlocks; ++block) {
            engine.process(left.data(), right.data(), kBlockSize);
        }
        const auto stop = std::chrono::steady_clock::now();
        runs[run] = std::chrono::duration<double, std::micro>(stop - start).count()
            / static_cast<double>(kMeasuredBlocks);
    }
    std::sort(runs.begin(), runs.end());
    return runs[runs.size() / 2U];
}

struct Case {
    const char* name;
    brk::modal::Patch patch;
};

void write_profile(std::ostream& out, const char* name,
                   const brk::modal::Patch& source,
                   brk::modal::QualityProfile profile,
                   double full_us, std::uint64_t seed,
                   bool comma) {
    using namespace brk::modal;
    const Patch applied = apply_auto_quality_profile(source, profile);
    const auto report = describe_auto_quality_application(source, profile);
    const double measured = profile == QualityProfile::Full
        ? full_us : benchmark(applied, seed);
    const double ratio = full_us > 0.0 ? measured / full_us : 1.0;
    out << "        \"" << name << "\": {"
        << "\"medianUsPerBlock\": " << measured
        << ", \"cpuRatioVsFull\": " << ratio
        << ", \"estimatedWorkRatio\": " << report.estimated_work_ratio
        << ", \"retainedModes\": " << report.retained_modal_count
        << ", \"modalRetentionRatio\": " << report.modal_retention_ratio
        << "}" << (comma ? "," : "") << "\n";
}

} // namespace

int main(int argc, char** argv) {
    using namespace brk::modal;
    const std::string output_path = argc > 1 ? argv[1] : "p8a-quality-benchmark.json";
    const std::array<Case, 4U> cases{{
        {"sparse-bar", make_sparse_bar()},
        {"general-gong", make_general_gong()},
        {"dense-crash", make_dense_crash()},
        {"serial-bell", make_serial_bell()},
    }};

    std::ofstream out(output_path);
    if (!out) return 1;
    out << std::fixed << std::setprecision(9);
    out << "{\n"
        << "  \"schema\": \"brk-modal-p8a-quality-benchmark-v1\",\n"
        << "  \"sampleRate\": " << kSampleRate << ",\n"
        << "  \"blockSize\": " << kBlockSize << ",\n"
        << "  \"measuredBlocksPerRun\": " << kMeasuredBlocks << ",\n"
        << "  \"medianRuns\": " << kRuns << ",\n"
        << "  \"cases\": [\n";

    for (std::size_t index = 0U; index < cases.size(); ++index) {
        const auto& item = cases[index];
        const std::uint64_t seed = 0x5038410000000000ULL + index * 0x1000ULL;
        const Patch full = apply_auto_quality_profile(item.patch, QualityProfile::Full);
        const double full_us = benchmark(full, seed);
        if (!(full_us > 0.0)) return 2;
        out << "    {\n"
            << "      \"name\": \"" << item.name << "\",\n"
            << "      \"profiles\": {\n";
        write_profile(out, "full", item.patch, QualityProfile::Full, full_us, seed, true);
        write_profile(out, "balanced", item.patch, QualityProfile::Balanced, full_us, seed + 0x100ULL, true);
        write_profile(out, "economy", item.patch, QualityProfile::Economy, full_us, seed + 0x200ULL, false);
        out << "      }\n"
            << "    }" << (index + 1U == cases.size() ? "\n" : ",\n");
    }
    out << "  ]\n}\n";

    std::cout << "p8a_benchmark_cases=4\n";
    std::cout << "p8a_benchmark_profiles=full,balanced,economy\n";
    std::cout << "p8a_benchmark_sample_rate=48000\n";
    std::cout << "p8a_benchmark_block_size=128\n";
    return 0;
}

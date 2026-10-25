#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kBlockSize = 128U;
constexpr std::size_t kMaximumVoices = 16U;

struct BenchmarkCase {
    std::string id;
    brk::modal::Patch patch;
    std::size_t voices = 1U;
};

struct Distribution {
    double p50 = 0.0;
    double p95 = 0.0;
    double p99 = 0.0;
    double maximum = 0.0;
};

struct Result {
    std::string id;
    std::string requested_kernel;
    std::string active_kernel;
    std::size_t voices = 0U;
    std::size_t work_units = 0U;
    Distribution control;
    Distribution attack;
    Distribution steady;
    double steady_p99_deadline_fraction = 0.0;
    double checksum = 0.0;
};

using Clock = std::chrono::steady_clock;

Distribution summarize(std::vector<double> timings) {
    if (timings.empty()) return {};
    std::sort(timings.begin(), timings.end());
    const auto percentile = [&](double fraction) {
        const double position = fraction * static_cast<double>(timings.size() - 1U);
        const auto low = static_cast<std::size_t>(std::floor(position));
        const auto high = static_cast<std::size_t>(std::ceil(position));
        const double mix = position - static_cast<double>(low);
        return timings[low] * (1.0 - mix) + timings[high] * mix;
    };
    return {percentile(0.50), percentile(0.95), percentile(0.99), timings.back()};
}

double elapsed_us(Clock::time_point start, Clock::time_point finish) {
    return std::chrono::duration<double, std::micro>(finish - start).count();
}

std::vector<BenchmarkCase> build_cases() {
    std::vector<BenchmarkCase> cases;

    auto plate = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    plate.resonator_a.partials = 61U;
    plate.resonator_a.max_render_partials = 61U;
    plate.polyphony = 8U;
    cases.push_back({"soft_plate_8x61", plate, 8U});

    auto bell = brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell);
    bell.resonator_a.partials = 64U;
    bell.resonator_b.partials = 43U;
    bell.polyphony = 8U;
    cases.push_back({"ritual_bell_serial_8x64x43", bell, 8U});

    auto membrane = brk::modal::make_factory_patch(brk::modal::FactoryPatch::DeepMembrane);
    membrane.resonator_a.partials = 48U;
    membrane.resonator_b.partials = 31U;
    membrane.polyphony = 8U;
    cases.push_back({"deep_membrane_parallel_8x48x31", membrane, 8U});

    brk::modal::Patch maximum;
    maximum.resonator_a.model = brk::modal::Model::Plate;
    maximum.resonator_a.partials = 64U;
    maximum.resonator_b.enabled = true;
    maximum.resonator_b.model = brk::modal::Model::Drumhead;
    maximum.resonator_b.partials = 64U;
    maximum.exciter.mallet_resonator = 0.85F;
    maximum.polyphony = 16U;
    maximum.stereo_mode = brk::modal::StereoMode::Mono;
    cases.push_back({"maximum_parallel_16x64x64", maximum, 16U});

    auto reduced = maximum;
    reduced.resonator_a.max_render_partials = 31U;
    reduced.resonator_b.max_render_partials = 19U;
    reduced.polyphony = 8U;
    cases.push_back({"tail_mix_8x31x19", reduced, 8U});
    return cases;
}

void trigger_voices(brk::modal::Engine& engine, std::size_t voices, std::uint32_t generation) {
    static constexpr std::array<std::int16_t, kMaximumVoices> notes{
        36, 43, 48, 52, 55, 60, 64, 67, 71, 72, 76, 79, 81, 84, 88, 91,
    };
    for (std::size_t voice = 0; voice < voices; ++voice) {
        engine.note_on({
            generation * 100U + static_cast<std::uint32_t>(voice + 1U),
            notes[voice],
            0.55F + 0.025F * static_cast<float>(voice % 12U),
            0.0F,
        });
    }
}

Result run_case(
    const BenchmarkCase& test_case,
    brk::modal::ModalKernel requested_kernel,
    std::size_t repeats,
    std::size_t steady_blocks) {

    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, 0x50343742454e4348ULL)) {
        throw std::runtime_error("engine prepare failed");
    }
    engine.set_modal_kernel(requested_kernel);
    engine.set_patch(test_case.patch);

    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};
    std::vector<double> control_timings;
    std::vector<double> attack_timings;
    std::vector<double> steady_timings;
    control_timings.reserve(repeats);
    attack_timings.reserve(repeats);
    steady_timings.reserve(steady_blocks);
    long double checksum = 0.0;

    for (std::size_t repeat = 0; repeat < repeats; ++repeat) {
        engine.reset();
        const auto control_start = Clock::now();
        trigger_voices(engine, test_case.voices, static_cast<std::uint32_t>(repeat + 1U));
        const auto control_finish = Clock::now();
        control_timings.push_back(elapsed_us(control_start, control_finish));

        const auto attack_start = Clock::now();
        engine.process(left.data(), right.data(), kBlockSize);
        const auto attack_finish = Clock::now();
        attack_timings.push_back(elapsed_us(attack_start, attack_finish));
        checksum += left[repeat % kBlockSize];
        checksum += right[(repeat * 7U) % kBlockSize];
    }

    engine.reset();
    trigger_voices(engine, test_case.voices, 999U);
    for (std::size_t block = 0; block < 64U; ++block) {
        engine.process(left.data(), right.data(), kBlockSize);
    }
    for (std::size_t block = 0; block < steady_blocks; ++block) {
        const auto start = Clock::now();
        engine.process(left.data(), right.data(), kBlockSize);
        const auto finish = Clock::now();
        steady_timings.push_back(elapsed_us(start, finish));
        checksum += left[block % kBlockSize];
        checksum += right[(block * 11U) % kBlockSize];
    }

    Result result;
    result.id = test_case.id;
    result.requested_kernel = brk::modal::modal_kernel_name(requested_kernel);
    result.active_kernel = brk::modal::modal_kernel_name(engine.active_modal_kernel());
    result.voices = test_case.voices;
    result.work_units = brk::modal::estimated_modal_work_units(test_case.patch);
    result.control = summarize(std::move(control_timings));
    result.attack = summarize(std::move(attack_timings));
    result.steady = summarize(std::move(steady_timings));
    const double deadline_us = static_cast<double>(kBlockSize) * 1.0e6 / static_cast<double>(kSampleRate);
    result.steady_p99_deadline_fraction = result.steady.p99 / deadline_us;
    result.checksum = static_cast<double>(checksum);
    return result;
}

void write_distribution(std::ofstream& output, const char* name, const Distribution& value, bool comma) {
    output << "      \"" << name << "\": {\n";
    output << "        \"p50Microseconds\": " << value.p50 << ",\n";
    output << "        \"p95Microseconds\": " << value.p95 << ",\n";
    output << "        \"p99Microseconds\": " << value.p99 << ",\n";
    output << "        \"maxMicroseconds\": " << value.maximum << "\n";
    output << "      }" << (comma ? ",\n" : "\n");
}

void write_json(const std::filesystem::path& path, const std::vector<Result>& results, bool quick) {
    std::ofstream output(path);
    if (!output) throw std::runtime_error("cannot create benchmark report");
    output << std::setprecision(12);
    output << "{\n";
    output << "  \"schema\": \"brk-modal-p47b-kernel-benchmark-v1\",\n";
    output << "  \"mode\": \"" << (quick ? "ci-quick" : "full") << "\",\n";
    output << "  \"sampleRate\": " << kSampleRate << ",\n";
    output << "  \"blockSize\": " << kBlockSize << ",\n";
    output << "  \"vectorKernelAvailable\": "
           << (brk::modal::modal_vector_kernel_available() ? "true" : "false") << ",\n";
    output << "  \"results\": [\n";
    for (std::size_t index = 0; index < results.size(); ++index) {
        const auto& result = results[index];
        output << "    {\n";
        output << "      \"id\": \"" << result.id << "\",\n";
        output << "      \"requestedKernel\": \"" << result.requested_kernel << "\",\n";
        output << "      \"activeKernel\": \"" << result.active_kernel << "\",\n";
        output << "      \"voices\": " << result.voices << ",\n";
        output << "      \"estimatedModalWorkUnits\": " << result.work_units << ",\n";
        write_distribution(output, "controlEvent", result.control, true);
        write_distribution(output, "attackBlock", result.attack, true);
        write_distribution(output, "steadyState", result.steady, true);
        output << "      \"steadyP99DeadlineFraction\": " << result.steady_p99_deadline_fraction << ",\n";
        output << "      \"checksum\": " << result.checksum << "\n";
        output << "    }" << (index + 1U == results.size() ? "\n" : ",\n");
    }
    output << "  ]\n";
    output << "}\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 2 || argc > 3) {
            std::cerr << "usage: brk_modal_p47b_kernel_benchmark <report.json> [--quick]\n";
            return 2;
        }
        const bool quick = argc == 3 && std::string(argv[2]) == "--quick";
        if (argc == 3 && !quick) throw std::runtime_error("unknown option");
        const std::size_t repeats = quick ? 64U : 512U;
        const std::size_t steady_blocks = quick ? 384U : 4096U;
        std::vector<Result> results;
        for (const auto& test_case : build_cases()) {
            for (const auto kernel : {brk::modal::ModalKernel::Scalar, brk::modal::ModalKernel::Vector4}) {
                const auto result = run_case(test_case, kernel, repeats, steady_blocks);
                std::cout << result.id << ' ' << result.requested_kernel
                          << " active=" << result.active_kernel
                          << " control_p50_us=" << result.control.p50
                          << " attack_p50_us=" << result.attack.p50
                          << " steady_p50_us=" << result.steady.p50
                          << " steady_p99_us=" << result.steady.p99 << '\n';
                results.push_back(result);
            }
        }
        write_json(argv[1], results, quick);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_p47b_kernel_benchmark: " << error.what() << '\n';
        return 1;
    }
}

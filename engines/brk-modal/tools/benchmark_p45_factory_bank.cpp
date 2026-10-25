#include "brk_modal/ripplerx_programs.hpp"

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

#ifndef BRK_MODAL_PROGRAM_BANK_INCLUDE
#error "BRK_MODAL_PROGRAM_BANK_INCLUDE must name the generated .inc file"
#endif

namespace brk::modal {
#include BRK_MODAL_PROGRAM_BANK_INCLUDE
} // namespace brk::modal

namespace {

constexpr std::uint32_t kSampleRate = 48000;
constexpr std::uint32_t kBlockSize = 128;
constexpr std::size_t kMaximumVoices = 16;

struct BenchmarkCase {
    std::string id;
    std::string lane;
    brk::modal::Patch patch;
    std::uint32_t program_index = 0;
    std::size_t voices = 1;
};

struct Result {
    std::string id;
    std::string lane;
    std::uint32_t program_index = 0;
    std::size_t voices = 0;
    std::size_t requested_partials_a = 0;
    std::size_t requested_partials_b = 0;
    bool serial = false;
    double p50_us = 0.0;
    double p95_us = 0.0;
    double p99_us = 0.0;
    double maximum_us = 0.0;
    double p99_deadline_fraction = 0.0;
    double checksum = 0.0;
};

double percentile(const std::vector<double>& sorted, double fraction) {
    if (sorted.empty()) return 0.0;
    const double position = fraction * static_cast<double>(sorted.size() - 1U);
    const auto low = static_cast<std::size_t>(std::floor(position));
    const auto high = static_cast<std::size_t>(std::ceil(position));
    const double mix = position - static_cast<double>(low);
    return sorted[low] * (1.0 - mix) + sorted[high] * mix;
}

std::vector<BenchmarkCase> build_cases() {
    std::vector<BenchmarkCase> cases;
    const std::array<brk::modal::RipplerXProgram, 5> programs{
        brk::modal::RipplerXProgram::Init,
        brk::modal::RipplerXProgram::Gong,
        brk::modal::RipplerXProgram::Ride2,
        brk::modal::RipplerXProgram::Flute,
        brk::modal::RipplerXProgram::Kalimba,
    };
    const std::array<std::size_t, 3> voice_counts{1U, 4U, 8U};
    for (const auto program : programs) {
        const auto index = static_cast<std::uint32_t>(program);
        for (const auto voices : voice_counts) {
            auto patch = brk::modal::make_ripplerx_program(program);
            patch.polyphony = static_cast<std::uint8_t>(voices);
            cases.push_back({
                "factory_" + std::to_string(index) + "_voices_" + std::to_string(voices),
                "matched-factory",
                patch,
                index,
                voices,
            });
        }
    }

    brk::modal::Patch parallel;
    parallel.resonator_a.model = brk::modal::Model::Plate;
    parallel.resonator_a.partials = 32;
    parallel.resonator_b.enabled = true;
    parallel.resonator_b.model = brk::modal::Model::Beam;
    parallel.resonator_b.partials = 32;
    parallel.exciter.mallet_resonator = 0.8F;
    parallel.polyphony = 12;
    cases.push_back({"stress_parallel_12_32x32", "brk-stress", parallel, 0U, 12U});

    auto serial = parallel;
    serial.coupling = brk::modal::Coupling::Serial;
    serial.coupling_profile = brk::modal::CouplingProfile::Stable;
    serial.polyphony = 8;
    cases.push_back({"stress_serial_8_32x32", "brk-stress", serial, 0U, 8U});

    auto maximum = parallel;
    maximum.resonator_a.partials = 64;
    maximum.resonator_b.partials = 64;
    maximum.polyphony = 16;
    cases.push_back({"stress_parallel_16_64x64", "brk-stress", maximum, 0U, 16U});

    brk::modal::Patch tubes;
    tubes.resonator_a.model = brk::modal::Model::ClosedTube;
    tubes.resonator_b.enabled = true;
    tubes.resonator_b.model = brk::modal::Model::OpenTube;
    tubes.exciter.mallet_resonator = 0.2F;
    tubes.exciter.use_upstream_noise = true;
    tubes.exciter.noise_resonator = 0.7F;
    tubes.polyphony = 8;
    cases.push_back({"stress_tubes_8", "brk-stress", tubes, 0U, 8U});
    return cases;
}

Result run_case(const BenchmarkCase& test_case, std::size_t warmup_blocks, std::size_t measured_blocks) {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, 0x50343542454e4348ULL)) {
        throw std::runtime_error("engine prepare failed");
    }
    engine.set_patch(test_case.patch);
    const std::array<std::int16_t, kMaximumVoices> notes{
        36, 43, 48, 52, 55, 60, 64, 67, 71, 72, 76, 79, 81, 84, 88, 91,
    };
    for (std::size_t voice = 0; voice < test_case.voices; ++voice) {
        engine.note_on({static_cast<std::uint32_t>(voice + 1U), notes[voice], 0.75F, 0.0F});
    }

    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};
    for (std::size_t block = 0; block < warmup_blocks; ++block) {
        engine.process(left.data(), right.data(), kBlockSize);
    }

    std::vector<double> timings;
    timings.reserve(measured_blocks);
    long double checksum = 0.0;
    for (std::size_t block = 0; block < measured_blocks; ++block) {
        if (block > 0U && block % 64U == 0U) {
            for (std::size_t voice = 0; voice < test_case.voices; ++voice) {
                const auto note_id = static_cast<std::uint32_t>(voice + 1U);
                engine.note_off(note_id);
                engine.note_on({note_id, notes[voice], 0.75F, 0.0F});
            }
        }
        const auto start = std::chrono::steady_clock::now();
        engine.process(left.data(), right.data(), kBlockSize);
        const auto finish = std::chrono::steady_clock::now();
        const double microseconds = std::chrono::duration<double, std::micro>(finish - start).count();
        timings.push_back(microseconds);
        checksum += static_cast<long double>(left[block % kBlockSize]);
        checksum += static_cast<long double>(right[(block * 7U) % kBlockSize]);
    }
    std::sort(timings.begin(), timings.end());
    const double deadline_us = static_cast<double>(kBlockSize) * 1.0e6 / static_cast<double>(kSampleRate);
    Result result;
    result.id = test_case.id;
    result.lane = test_case.lane;
    result.program_index = test_case.program_index;
    result.voices = test_case.voices;
    result.requested_partials_a = test_case.patch.resonator_a.partials;
    result.requested_partials_b = test_case.patch.resonator_b.enabled ? test_case.patch.resonator_b.partials : 0U;
    result.serial = test_case.patch.coupling == brk::modal::Coupling::Serial;
    result.p50_us = percentile(timings, 0.50);
    result.p95_us = percentile(timings, 0.95);
    result.p99_us = percentile(timings, 0.99);
    result.maximum_us = timings.back();
    result.p99_deadline_fraction = result.p99_us / deadline_us;
    result.checksum = static_cast<double>(checksum);
    return result;
}

void write_json(const std::filesystem::path& path, const std::vector<Result>& results, bool quick) {
    std::ofstream output(path);
    if (!output) throw std::runtime_error("cannot create benchmark report");
    output << std::setprecision(12);
    output << "{\n";
    output << "  \"schema\": \"brk-modal-p45-benchmark-v1\",\n";
    output << "  \"engine\": \"brk-modal\",\n";
    output << "  \"mode\": \"" << (quick ? "ci-quick" : "target-full") << "\",\n";
    output << "  \"sampleRate\": " << kSampleRate << ",\n";
    output << "  \"blockSize\": " << kBlockSize << ",\n";
    output << "  \"deadlineMicroseconds\": "
           << static_cast<double>(kBlockSize) * 1.0e6 / static_cast<double>(kSampleRate) << ",\n";
    output << "  \"cases\": [\n";
    for (std::size_t index = 0; index < results.size(); ++index) {
        const auto& result = results[index];
        output << "    {\n";
        output << "      \"id\": \"" << result.id << "\",\n";
        output << "      \"lane\": \"" << result.lane << "\",\n";
        output << "      \"programIndex\": " << result.program_index << ",\n";
        output << "      \"voices\": " << result.voices << ",\n";
        output << "      \"requestedPartialsA\": " << result.requested_partials_a << ",\n";
        output << "      \"requestedPartialsB\": " << result.requested_partials_b << ",\n";
        output << "      \"serial\": " << (result.serial ? "true" : "false") << ",\n";
        output << "      \"p50Microseconds\": " << result.p50_us << ",\n";
        output << "      \"p95Microseconds\": " << result.p95_us << ",\n";
        output << "      \"p99Microseconds\": " << result.p99_us << ",\n";
        output << "      \"maxMicroseconds\": " << result.maximum_us << ",\n";
        output << "      \"p99DeadlineFraction\": " << result.p99_deadline_fraction << ",\n";
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
            std::cerr << "usage: brk_modal_p45_benchmark <report.json> [--quick]\n";
            return 2;
        }
        const bool quick = argc == 3 && std::string(argv[2]) == "--quick";
        if (argc == 3 && !quick) throw std::runtime_error("unknown option");
        const std::size_t warmup_blocks = quick ? 64U : 512U;
        const std::size_t measured_blocks = quick ? 256U : 4096U;
        std::vector<Result> results;
        for (const auto& test_case : build_cases()) {
            const auto result = run_case(test_case, warmup_blocks, measured_blocks);
            results.push_back(result);
            std::cout << result.id << ": p99_us=" << result.p99_us
                      << " deadline_fraction=" << result.p99_deadline_fraction << '\n';
        }
        write_json(argv[1], results, quick);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_p45_benchmark: " << error.what() << '\n';
        return 1;
    }
}

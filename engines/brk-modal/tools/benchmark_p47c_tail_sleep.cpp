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

constexpr double kSampleRate = 48000.0;
constexpr std::uint32_t kBlockSize = 128U;
constexpr std::size_t kMaximumVoices = 16U;
using Clock = std::chrono::steady_clock;

struct Case {
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

struct PhaseResult {
    Distribution oracle;
    Distribution candidate;
    double p50_ratio = 0.0;
    double p95_ratio = 0.0;
    double p99_ratio = 0.0;
};

struct AudioError {
    double maximum = 0.0;
    double rms = 0.0;
    double signal_rms = 0.0;
    double snr_db = 300.0;
    long double error_squared = 0.0;
    long double signal_squared = 0.0;
    std::uint64_t samples = 0U;

    void add(const std::array<float, kBlockSize>& expected_left,
             const std::array<float, kBlockSize>& expected_right,
             const std::array<float, kBlockSize>& actual_left,
             const std::array<float, kBlockSize>& actual_right) noexcept {
        const auto channel = [&](const auto& expected, const auto& actual) {
            for (std::size_t index = 0; index < kBlockSize; ++index) {
                const double signal = static_cast<double>(expected[index]);
                const double error = signal - static_cast<double>(actual[index]);
                maximum = std::max(maximum, std::abs(error));
                error_squared += static_cast<long double>(error * error);
                signal_squared += static_cast<long double>(signal * signal);
                ++samples;
            }
        };
        channel(expected_left, actual_left);
        channel(expected_right, actual_right);
    }

    void finish() noexcept {
        if (samples == 0U) return;
        rms = std::sqrt(static_cast<double>(error_squared / samples));
        signal_rms = std::sqrt(static_cast<double>(signal_squared / samples));
        snr_db = rms > 0.0 ? 20.0 * std::log10(signal_rms / rms) : 300.0;
    }
};

struct Result {
    std::string id;
    std::size_t voices = 0U;
    std::size_t work_units = 0U;
    std::uint64_t first_sleep_block = 0U;
    brk::modal::TailSleepStats stats{};
    PhaseResult active;
    PhaseResult decaying;
    PhaseResult mostly_silent;
    AudioError error;
    double candidate_skipped_fraction = 0.0;
};

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

PhaseResult make_phase(std::vector<double> oracle, std::vector<double> candidate) {
    PhaseResult phase;
    phase.oracle = summarize(std::move(oracle));
    phase.candidate = summarize(std::move(candidate));
    phase.p50_ratio = phase.oracle.p50 > 0.0 ? phase.candidate.p50 / phase.oracle.p50 : 0.0;
    phase.p95_ratio = phase.oracle.p95 > 0.0 ? phase.candidate.p95 / phase.oracle.p95 : 0.0;
    phase.p99_ratio = phase.oracle.p99 > 0.0 ? phase.candidate.p99 / phase.oracle.p99 : 0.0;
    return phase;
}

std::vector<Case> build_cases() {
    std::vector<Case> cases;

    auto modal = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    modal.resonator_a.partials = 48U;
    modal.resonator_a.max_render_partials = 48U;
    modal.resonator_a.decay_seconds = 1.2F;
    modal.resonator_b.enabled = false;
    modal.release_mode = brk::modal::ReleaseMode::Natural;
    modal.polyphony = 6U;
    modal.stereo_mode = brk::modal::StereoMode::Mono;
    cases.push_back({"modal_parallel_6x48", modal, 6U});

    auto serial = brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell);
    serial.resonator_a.partials = 48U;
    serial.resonator_a.max_render_partials = 48U;
    serial.resonator_a.decay_seconds = 0.9F;
    serial.resonator_b.partials = 32U;
    serial.resonator_b.max_render_partials = 32U;
    serial.resonator_b.decay_seconds = 0.75F;
    serial.release_mode = brk::modal::ReleaseMode::Natural;
    serial.polyphony = 6U;
    serial.stereo_mode = brk::modal::StereoMode::Mono;
    cases.push_back({"modal_serial_6x48x32", serial, 6U});

    auto tube = brk::modal::make_factory_patch(brk::modal::FactoryPatch::BreathingTube);
    tube.resonator_a.decay_seconds = 1.8F;
    tube.resonator_a.release_scale = 1.0F;
    tube.resonator_b.decay_seconds = 1.8F;
    tube.resonator_b.release_scale = 1.0F;
    tube.release_mode = brk::modal::ReleaseMode::Natural;
    tube.polyphony = 6U;
    tube.stereo_mode = brk::modal::StereoMode::Mono;
    cases.push_back({"waveguide_tube_6", tube, 6U});

    return cases;
}

void trigger(brk::modal::Engine& engine, std::size_t voices) {
    static constexpr std::array<std::int16_t, kMaximumVoices> notes{
        36, 43, 48, 52, 55, 60, 64, 67, 71, 72, 76, 79, 81, 84, 88, 91,
    };
    for (std::size_t index = 0; index < voices; ++index) {
        engine.note_on({
            static_cast<std::uint32_t>(index + 1U),
            notes[index],
            0.58F + 0.045F * static_cast<float>(index),
            0.01F * static_cast<float>(index % 3U),
        });
    }
}

void release(brk::modal::Engine& engine, std::size_t voices) {
    for (std::size_t index = 0; index < voices; ++index) {
        engine.note_off(static_cast<std::uint32_t>(index + 1U));
    }
}

struct Pair {
    brk::modal::Engine oracle;
    brk::modal::Engine candidate;
    std::array<float, kBlockSize> oracle_left{};
    std::array<float, kBlockSize> oracle_right{};
    std::array<float, kBlockSize> candidate_left{};
    std::array<float, kBlockSize> candidate_right{};
    bool reverse_order = false;

    explicit Pair(const Case& test_case) {
        if (!oracle.prepare(kSampleRate, kBlockSize, 0x503437435441494cULL)
            || !candidate.prepare(kSampleRate, kBlockSize, 0x503437435441494cULL)) {
            throw std::runtime_error("prepare failed");
        }
        oracle.set_modal_kernel(brk::modal::ModalKernel::Auto);
        candidate.set_modal_kernel(brk::modal::ModalKernel::Auto);
        oracle.set_tail_policy(brk::modal::TailPolicy::Disabled);
        candidate.set_tail_policy(brk::modal::TailPolicy::Conservative);
        oracle.set_patch(test_case.patch);
        candidate.set_patch(test_case.patch);
        trigger(oracle, test_case.voices);
        trigger(candidate, test_case.voices);
    }

    std::pair<double, double> process(AudioError* error) {
        double oracle_us = 0.0;
        double candidate_us = 0.0;
        const auto run_oracle = [&] {
            const auto start = Clock::now();
            oracle.process(oracle_left.data(), oracle_right.data(), kBlockSize);
            oracle_us = elapsed_us(start, Clock::now());
        };
        const auto run_candidate = [&] {
            const auto start = Clock::now();
            candidate.process(candidate_left.data(), candidate_right.data(), kBlockSize);
            candidate_us = elapsed_us(start, Clock::now());
        };
        if (reverse_order) {
            run_candidate();
            run_oracle();
        } else {
            run_oracle();
            run_candidate();
        }
        reverse_order = !reverse_order;
        if (error != nullptr) error->add(oracle_left, oracle_right, candidate_left, candidate_right);
        return {oracle_us, candidate_us};
    }
};

PhaseResult measure(Pair& pair, std::size_t blocks, AudioError& error) {
    std::vector<double> oracle;
    std::vector<double> candidate;
    oracle.reserve(blocks);
    candidate.reserve(blocks);
    for (std::size_t block = 0; block < blocks; ++block) {
        const auto [oracle_us, candidate_us] = pair.process(&error);
        oracle.push_back(oracle_us);
        candidate.push_back(candidate_us);
    }
    return make_phase(std::move(oracle), std::move(candidate));
}

Result run_case(const Case& test_case, bool quick) {
    Pair pair(test_case);
    AudioError error;
    const std::size_t warm_blocks = quick ? 64U : 256U;
    const std::size_t active_blocks = quick ? 192U : 1024U;
    const std::size_t decay_blocks = quick ? 32U : 128U;
    const std::size_t silent_blocks = quick ? 512U : 4096U;
    const std::size_t maximum_seek_blocks = quick ? 4096U : 16384U;

    for (std::size_t block = 0; block < warm_blocks; ++block) pair.process(&error);
    Result result;
    result.id = test_case.id;
    result.voices = test_case.voices;
    result.work_units = brk::modal::estimated_modal_work_units(test_case.patch);
    result.active = measure(pair, active_blocks, error);

    release(pair.oracle, test_case.voices);
    release(pair.candidate, test_case.voices);
    result.decaying = measure(pair, decay_blocks, error);

    std::size_t seek_blocks = 0U;
    while (pair.candidate.tail_sleep_stats().entries == 0U
           && seek_blocks < maximum_seek_blocks) {
        pair.process(&error);
        ++seek_blocks;
    }
    if (pair.candidate.tail_sleep_stats().entries == 0U) {
        throw std::runtime_error(test_case.id + ": conservative tails did not sleep within seek budget");
    }
    result.first_sleep_block = warm_blocks + active_blocks + decay_blocks + seek_blocks;
    result.mostly_silent = measure(pair, silent_blocks, error);
    error.finish();
    result.error = error;
    result.stats = pair.candidate.tail_sleep_stats();
    const double candidate_voice_frames = static_cast<double>(test_case.voices)
        * static_cast<double>(result.first_sleep_block + silent_blocks) * static_cast<double>(kBlockSize);
    result.candidate_skipped_fraction = candidate_voice_frames > 0.0
        ? static_cast<double>(result.stats.skipped_voice_frames) / candidate_voice_frames
        : 0.0;
    return result;
}

void write_distribution(std::ofstream& out, const char* name, const Distribution& value, bool comma) {
    out << "        \"" << name << "\": {\n";
    out << "          \"p50Microseconds\": " << value.p50 << ",\n";
    out << "          \"p95Microseconds\": " << value.p95 << ",\n";
    out << "          \"p99Microseconds\": " << value.p99 << ",\n";
    out << "          \"maxMicroseconds\": " << value.maximum << "\n";
    out << "        }" << (comma ? ",\n" : "\n");
}

void write_phase(std::ofstream& out, const char* name, const PhaseResult& phase, bool comma) {
    out << "      \"" << name << "\": {\n";
    write_distribution(out, "oracle", phase.oracle, true);
    write_distribution(out, "candidate", phase.candidate, true);
    out << "        \"p50CandidateOverOracle\": " << phase.p50_ratio << ",\n";
    out << "        \"p95CandidateOverOracle\": " << phase.p95_ratio << ",\n";
    out << "        \"p99CandidateOverOracle\": " << phase.p99_ratio << "\n";
    out << "      }" << (comma ? ",\n" : "\n");
}

void write_json(const std::filesystem::path& path, const std::vector<Result>& results, bool quick) {
    std::ofstream out(path);
    if (!out) throw std::runtime_error("cannot create benchmark report");
    out << std::setprecision(12);
    out << "{\n";
    out << "  \"schema\": \"brk-modal-p47c-tail-benchmark-v1\",\n";
    out << "  \"mode\": \"" << (quick ? "ci-quick" : "full") << "\",\n";
    out << "  \"sampleRate\": " << kSampleRate << ",\n";
    out << "  \"blockSize\": " << kBlockSize << ",\n";
    out << "  \"modalKernelBackend\": \"" << brk::modal::modal_vector_kernel_backend() << "\",\n";
    out << "  \"results\": [\n";
    for (std::size_t index = 0; index < results.size(); ++index) {
        const auto& result = results[index];
        out << "    {\n";
        out << "      \"id\": \"" << result.id << "\",\n";
        out << "      \"voices\": " << result.voices << ",\n";
        out << "      \"estimatedModalWorkUnits\": " << result.work_units << ",\n";
        out << "      \"firstSleepBlock\": " << result.first_sleep_block << ",\n";
        out << "      \"sleepEntries\": " << result.stats.entries << ",\n";
        out << "      \"retiredVoices\": " << result.stats.retired_voices << ",\n";
        out << "      \"skippedVoiceFrames\": " << result.stats.skipped_voice_frames << ",\n";
        out << "      \"candidateSkippedFraction\": " << result.candidate_skipped_fraction << ",\n";
        write_phase(out, "active", result.active, true);
        write_phase(out, "decaying", result.decaying, true);
        write_phase(out, "mostlySilent", result.mostly_silent, true);
        out << "      \"audioError\": {\n";
        out << "        \"maxAbs\": " << result.error.maximum << ",\n";
        out << "        \"rms\": " << result.error.rms << ",\n";
        out << "        \"signalRms\": " << result.error.signal_rms << ",\n";
        out << "        \"snrDb\": " << result.error.snr_db << "\n";
        out << "      }\n";
        out << "    }" << (index + 1U == results.size() ? "\n" : ",\n");
    }
    out << "  ]\n}\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 2 || argc > 3) {
            std::cerr << "usage: brk_modal_p47c_tail_benchmark <report.json> [--quick]\n";
            return 2;
        }
        const bool quick = argc == 3 && std::string(argv[2]) == "--quick";
        if (argc == 3 && !quick) throw std::runtime_error("unknown option");
        std::vector<Result> results;
        for (const auto& test_case : build_cases()) {
            auto result = run_case(test_case, quick);
            std::cout << result.id
                      << " active_p50_ratio=" << result.active.p50_ratio
                      << " decay_p50_ratio=" << result.decaying.p50_ratio
                      << " silent_p50_ratio=" << result.mostly_silent.p50_ratio
                      << " max_error=" << result.error.maximum
                      << " snr_db=" << result.error.snr_db
                      << " entries=" << result.stats.entries << '\n';
            results.push_back(result);
        }
        write_json(argv[1], results, quick);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_p47c_tail_benchmark: " << error.what() << '\n';
        return 1;
    }
}

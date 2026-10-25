#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kBlockSize = 128U;
constexpr std::uint32_t kRenderFrames = 6U * kSampleRate;
constexpr std::uint32_t kReleaseFrame = kSampleRate / 4U;
constexpr std::uint32_t kWindowBeforeSleep = kSampleRate / 2U;
constexpr std::uint32_t kWindowFrames = 2U * kSampleRate;
constexpr float kDifferenceGain = 100000.0F;

struct Case {
    std::string id;
    brk::modal::Patch patch;
};

struct Render {
    std::vector<float> left;
    std::vector<float> right;
    std::uint64_t first_sleep_frame = std::numeric_limits<std::uint64_t>::max();
    brk::modal::TailSleepStats stats{};
};

struct Metrics {
    double maximum = 0.0;
    double rms = 0.0;
    double signal_rms = 0.0;
    double snr_db = 300.0;
};

void write_u16(std::ofstream& output, std::uint16_t value) {
    const std::array<char, 2> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
    };
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_u32(std::ofstream& output, std::uint32_t value) {
    const std::array<char, 4> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU),
        static_cast<char>((value >> 24U) & 0xffU),
    };
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_wav(const std::filesystem::path& path, const std::vector<float>& left, const std::vector<float>& right) {
    if (left.size() != right.size()) throw std::runtime_error("channel size mismatch");
    std::ofstream output(path, std::ios::binary);
    if (!output) throw std::runtime_error("cannot create WAV");
    const auto frames = static_cast<std::uint32_t>(left.size());
    const std::uint32_t data_bytes = frames * 8U;
    output.write("RIFF", 4);
    write_u32(output, 36U + data_bytes);
    output.write("WAVEfmt ", 8);
    write_u32(output, 16U);
    write_u16(output, 1U);
    write_u16(output, 2U);
    write_u32(output, kSampleRate);
    write_u32(output, kSampleRate * 8U);
    write_u16(output, 8U);
    write_u16(output, 32U);
    output.write("data", 4);
    write_u32(output, data_bytes);
    const auto quantize = [](float sample) {
        const double bounded = std::clamp(static_cast<double>(sample), -1.0, 1.0);
        return static_cast<std::int32_t>(std::llround(bounded * 2147483647.0));
    };
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        write_u32(output, static_cast<std::uint32_t>(quantize(left[frame])));
        write_u32(output, static_cast<std::uint32_t>(quantize(right[frame])));
    }
}

std::vector<Case> build_cases() {
    std::vector<Case> cases;

    auto modal = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    modal.resonator_a.partials = 32U;
    modal.resonator_a.max_render_partials = 32U;
    modal.resonator_a.decay_seconds = 1.2F;
    modal.resonator_b.enabled = false;
    modal.release_mode = brk::modal::ReleaseMode::Natural;
    modal.polyphony = 2U;
    modal.stereo_mode = brk::modal::StereoMode::Mono;
    modal.output_gain_db = -6.0F;
    cases.push_back({"modal_parallel", modal});

    auto serial = brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell);
    serial.resonator_a.partials = 40U;
    serial.resonator_a.max_render_partials = 40U;
    serial.resonator_a.decay_seconds = 0.9F;
    serial.resonator_b.partials = 28U;
    serial.resonator_b.max_render_partials = 28U;
    serial.resonator_b.decay_seconds = 0.75F;
    serial.release_mode = brk::modal::ReleaseMode::Natural;
    serial.polyphony = 2U;
    serial.stereo_mode = brk::modal::StereoMode::Mono;
    cases.push_back({"modal_serial", serial});

    auto tube = brk::modal::make_factory_patch(brk::modal::FactoryPatch::BreathingTube);
    tube.resonator_a.decay_seconds = 1.8F;
    tube.resonator_a.release_scale = 1.0F;
    tube.resonator_b.decay_seconds = 1.8F;
    tube.resonator_b.release_scale = 1.0F;
    tube.release_mode = brk::modal::ReleaseMode::Natural;
    tube.polyphony = 2U;
    tube.stereo_mode = brk::modal::StereoMode::Mono;
    cases.push_back({"waveguide_tube", tube});
    return cases;
}

Render render(const brk::modal::Patch& patch, brk::modal::TailPolicy policy) {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, 0x5034374352454e44ULL)) {
        throw std::runtime_error("prepare failed");
    }
    engine.set_modal_kernel(brk::modal::ModalKernel::Auto);
    engine.set_tail_policy(policy);
    engine.set_patch(patch);
    engine.note_on({1U, 48, 0.84F, 0.0F});
    engine.note_on({2U, 55, 0.68F, 0.02F});

    Render result{std::vector<float>(kRenderFrames), std::vector<float>(kRenderFrames)};
    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};
    std::uint32_t cursor = 0U;
    bool released = false;
    while (cursor < kRenderFrames) {
        if (!released && cursor >= kReleaseFrame) {
            engine.note_off(1U);
            engine.note_off(2U);
            released = true;
        }
        const std::uint32_t count = std::min(kBlockSize, kRenderFrames - cursor);
        engine.process(left.data(), right.data(), count);
        std::copy_n(left.data(), count, result.left.data() + cursor);
        std::copy_n(right.data(), count, result.right.data() + cursor);
        cursor += count;
        if (result.first_sleep_frame == std::numeric_limits<std::uint64_t>::max()
            && engine.tail_sleep_stats().entries != 0U) {
            result.first_sleep_frame = cursor;
        }
    }
    result.stats = engine.tail_sleep_stats();
    return result;
}

Metrics compare(const Render& reference, const Render& candidate, std::size_t start_frame = 0U) {
    long double error_squared = 0.0;
    long double signal_squared = 0.0;
    double maximum = 0.0;
    std::size_t count = 0U;
    const auto accumulate = [&](const std::vector<float>& expected, const std::vector<float>& actual) {
        for (std::size_t index = start_frame; index < expected.size(); ++index) {
            const double signal = static_cast<double>(expected[index]);
            const double error = signal - static_cast<double>(actual[index]);
            maximum = std::max(maximum, std::abs(error));
            error_squared += static_cast<long double>(error * error);
            signal_squared += static_cast<long double>(signal * signal);
            ++count;
        }
    };
    accumulate(reference.left, candidate.left);
    accumulate(reference.right, candidate.right);
    const double rms = count != 0U ? std::sqrt(static_cast<double>(error_squared / count)) : 0.0;
    const double signal_rms = count != 0U ? std::sqrt(static_cast<double>(signal_squared / count)) : 0.0;
    const double snr = rms > 0.0 ? 20.0 * std::log10(signal_rms / rms) : 300.0;
    return {maximum, rms, signal_rms, snr};
}

void append_silence(std::vector<float>& left, std::vector<float>& right, std::uint32_t frames) {
    left.insert(left.end(), frames, 0.0F);
    right.insert(right.end(), frames, 0.0F);
}

void append_window(
    std::vector<float>& left,
    std::vector<float>& right,
    const Render& render,
    std::uint32_t start,
    std::uint32_t frames) {
    left.insert(left.end(), render.left.begin() + start, render.left.begin() + start + frames);
    right.insert(right.end(), render.right.begin() + start, render.right.begin() + start + frames);
}

void append_difference(
    std::vector<float>& left,
    std::vector<float>& right,
    const Render& oracle,
    const Render& candidate,
    std::uint32_t start,
    std::uint32_t frames) {
    for (std::uint32_t offset = 0U; offset < frames; ++offset) {
        const auto index = static_cast<std::size_t>(start + offset);
        left.push_back((oracle.left[index] - candidate.left[index]) * kDifferenceGain);
        right.push_back((oracle.right[index] - candidate.right[index]) * kDifferenceGain);
    }
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 2) {
            std::cerr << "usage: brk_modal_p47c_tail_render <output-dir>\n";
            return 2;
        }
        const std::filesystem::path output_dir = argv[1];
        std::filesystem::create_directories(output_dir);
        std::ofstream metrics_json(output_dir / "tail-sleep-metrics.json");
        std::ofstream cues(output_dir / "listening-cues.csv");
        if (!metrics_json || !cues) throw std::runtime_error("cannot create reports");
        metrics_json << std::setprecision(12);
        metrics_json << "{\n";
        metrics_json << "  \"schema\": \"brk-modal-p47c-tail-parity-v1\",\n";
        metrics_json << "  \"sampleRate\": " << kSampleRate << ",\n";
        metrics_json << "  \"blockSize\": " << kBlockSize << ",\n";
        metrics_json << "  \"differenceGain\": " << kDifferenceGain << ",\n";
        metrics_json << "  \"modalKernelBackend\": \"" << brk::modal::modal_vector_kernel_backend() << "\",\n";
        metrics_json << "  \"cases\": [\n";
        cues << "case,lane,start_seconds,duration_seconds,source_window_start_seconds\n";

        std::vector<float> listening_left;
        std::vector<float> listening_right;
        const auto cases = build_cases();
        const std::uint32_t gap = kSampleRate / 10U;
        for (std::size_t case_index = 0; case_index < cases.size(); ++case_index) {
            const auto oracle = render(cases[case_index].patch, brk::modal::TailPolicy::Disabled);
            const auto candidate = render(cases[case_index].patch, brk::modal::TailPolicy::Conservative);
            if (candidate.first_sleep_frame == std::numeric_limits<std::uint64_t>::max()) {
                throw std::runtime_error(cases[case_index].id + ": tail never slept");
            }
            const auto full = compare(oracle, candidate);
            const auto tail = compare(oracle, candidate, static_cast<std::size_t>(candidate.first_sleep_frame));
            const std::uint32_t sleep_frame = static_cast<std::uint32_t>(candidate.first_sleep_frame);
            const std::uint32_t window_start = sleep_frame > kWindowBeforeSleep
                ? sleep_frame - kWindowBeforeSleep
                : 0U;
            const std::uint32_t window_frames = std::min(kWindowFrames, kRenderFrames - window_start);

            append_silence(listening_left, listening_right, gap);
            const double oracle_start = static_cast<double>(listening_left.size()) / kSampleRate;
            append_window(listening_left, listening_right, oracle, window_start, window_frames);
            cues << cases[case_index].id << ",oracle," << oracle_start << ','
                 << static_cast<double>(window_frames) / kSampleRate << ','
                 << static_cast<double>(window_start) / kSampleRate << '\n';

            append_silence(listening_left, listening_right, gap);
            const double candidate_start = static_cast<double>(listening_left.size()) / kSampleRate;
            append_window(listening_left, listening_right, candidate, window_start, window_frames);
            cues << cases[case_index].id << ",conservative," << candidate_start << ','
                 << static_cast<double>(window_frames) / kSampleRate << ','
                 << static_cast<double>(window_start) / kSampleRate << '\n';

            append_silence(listening_left, listening_right, gap);
            const double difference_start = static_cast<double>(listening_left.size()) / kSampleRate;
            append_difference(listening_left, listening_right, oracle, candidate, window_start, window_frames);
            cues << cases[case_index].id << ",difference_plus_100db," << difference_start << ','
                 << static_cast<double>(window_frames) / kSampleRate << ','
                 << static_cast<double>(window_start) / kSampleRate << '\n';

            metrics_json << "    {\n";
            metrics_json << "      \"id\": \"" << cases[case_index].id << "\",\n";
            metrics_json << "      \"firstSleepFrame\": " << candidate.first_sleep_frame << ",\n";
            metrics_json << "      \"sleepEntries\": " << candidate.stats.entries << ",\n";
            metrics_json << "      \"retiredVoices\": " << candidate.stats.retired_voices << ",\n";
            metrics_json << "      \"skippedVoiceFrames\": " << candidate.stats.skipped_voice_frames << ",\n";
            metrics_json << "      \"fullMaxAbsError\": " << full.maximum << ",\n";
            metrics_json << "      \"fullRmsError\": " << full.rms << ",\n";
            metrics_json << "      \"fullSnrDb\": " << full.snr_db << ",\n";
            metrics_json << "      \"postSleepMaxAbsError\": " << tail.maximum << ",\n";
            metrics_json << "      \"postSleepRmsError\": " << tail.rms << ",\n";
            metrics_json << "      \"postSleepSignalRms\": " << tail.signal_rms << ",\n";
            metrics_json << "      \"postSleepSnrDb\": " << tail.snr_db << "\n";
            metrics_json << "    }" << (case_index + 1U == cases.size() ? "\n" : ",\n");
        }
        metrics_json << "  ]\n}\n";
        write_wav(output_dir / "brk-modal-p47c-tail-listening.wav", listening_left, listening_right);
        std::cout << "tail_policy=conservative\n";
        std::cout << "modal_backend=" << brk::modal::modal_vector_kernel_backend() << '\n';
        std::cout << "listening_frames=" << listening_left.size() << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_p47c_tail_render: " << error.what() << '\n';
        return 1;
    }
}

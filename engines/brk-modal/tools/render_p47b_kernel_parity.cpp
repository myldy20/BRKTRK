#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
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
constexpr std::uint32_t kFrames = kSampleRate;
constexpr float kDifferenceGain = 10000.0F;

struct StereoRender {
    std::vector<float> left;
    std::vector<float> right;
};

struct Metrics {
    double maximum = 0.0;
    double rms = 0.0;
    double signal_rms = 0.0;
    double snr_db = 0.0;
};

struct Case {
    std::string id;
    brk::modal::Patch patch;
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
    auto parallel = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    parallel.resonator_a.partials = 61U;
    parallel.resonator_b.enabled = true;
    parallel.resonator_b.model = brk::modal::Model::Beam;
    parallel.resonator_b.partials = 37U;
    parallel.parallel_mix = 0.37F;
    parallel.polyphony = 6U;
    cases.push_back({"dense_parallel", parallel});

    auto serial = brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell);
    serial.resonator_b.partials = 43U;
    serial.polyphony = 6U;
    cases.push_back({"dense_serial", serial});

    auto reduced = brk::modal::make_factory_patch(brk::modal::FactoryPatch::DeepMembrane);
    reduced.resonator_a.max_render_partials = 31U;
    reduced.resonator_b.max_render_partials = 19U;
    reduced.polyphony = 5U;
    cases.push_back({"scalar_tail_remainder", reduced});
    return cases;
}

StereoRender render(const brk::modal::Patch& patch, brk::modal::ModalKernel initial, bool switch_midway) {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlockSize, 0x5034374250415249ULL)) {
        throw std::runtime_error("prepare failed");
    }
    engine.set_modal_kernel(initial);
    engine.set_patch(patch);
    engine.note_on({1U, 43, 0.82F, 0.0F});
    engine.note_on({2U, 50, 0.71F, 0.0F});
    engine.note_on({3U, 55, 0.63F, -0.07F});
    engine.note_on({4U, 62, 0.94F, 0.04F});

    StereoRender result{std::vector<float>(kFrames), std::vector<float>(kFrames)};
    std::array<float, kBlockSize> left{};
    std::array<float, kBlockSize> right{};
    std::uint32_t cursor = 0U;
    bool released = false;
    bool switched = false;
    while (cursor < kFrames) {
        if (!released && cursor >= kSampleRate / 3U) {
            engine.note_off(1U);
            engine.note_off(2U);
            engine.note_off(3U);
            engine.note_off(4U);
            released = true;
        }
        if (switch_midway && !switched && cursor >= kSampleRate / 2U) {
            engine.set_modal_kernel(brk::modal::ModalKernel::Vector4);
            switched = true;
        }
        const std::uint32_t count = std::min(kBlockSize, kFrames - cursor);
        engine.process(left.data(), right.data(), count);
        std::copy_n(left.data(), count, result.left.data() + cursor);
        std::copy_n(right.data(), count, result.right.data() + cursor);
        cursor += count;
    }
    return result;
}

Metrics compare(const StereoRender& reference, const StereoRender& candidate) {
    long double error_squared = 0.0;
    long double signal_squared = 0.0;
    double maximum = 0.0;
    std::size_t count = 0U;
    const auto accumulate = [&](const std::vector<float>& a, const std::vector<float>& b) {
        for (std::size_t index = 0; index < a.size(); ++index) {
            const double signal = static_cast<double>(a[index]);
            const double error = signal - static_cast<double>(b[index]);
            maximum = std::max(maximum, std::abs(error));
            error_squared += static_cast<long double>(error * error);
            signal_squared += static_cast<long double>(signal * signal);
            ++count;
        }
    };
    accumulate(reference.left, candidate.left);
    accumulate(reference.right, candidate.right);
    const double rms = std::sqrt(static_cast<double>(error_squared / count));
    const double signal_rms = std::sqrt(static_cast<double>(signal_squared / count));
    const double snr = rms > 0.0 ? 20.0 * std::log10(signal_rms / rms) : 300.0;
    return {maximum, rms, signal_rms, snr};
}

void append_silence(std::vector<float>& left, std::vector<float>& right, std::uint32_t frames) {
    left.insert(left.end(), frames, 0.0F);
    right.insert(right.end(), frames, 0.0F);
}

void append_render(std::vector<float>& left, std::vector<float>& right, const StereoRender& render) {
    left.insert(left.end(), render.left.begin(), render.left.end());
    right.insert(right.end(), render.right.begin(), render.right.end());
}

void append_difference(
    std::vector<float>& left,
    std::vector<float>& right,
    const StereoRender& scalar,
    const StereoRender& vector) {
    for (std::size_t index = 0; index < scalar.left.size(); ++index) {
        left.push_back((scalar.left[index] - vector.left[index]) * kDifferenceGain);
        right.push_back((scalar.right[index] - vector.right[index]) * kDifferenceGain);
    }
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 2) {
            std::cerr << "usage: brk_modal_p47b_kernel_parity <output-dir>\n";
            return 2;
        }
        const std::filesystem::path output_dir = argv[1];
        std::filesystem::create_directories(output_dir);
        std::vector<float> listening_left;
        std::vector<float> listening_right;
        std::ofstream cues(output_dir / "listening-cues.csv");
        std::ofstream metrics_json(output_dir / "kernel-parity-metrics.json");
        if (!cues || !metrics_json) throw std::runtime_error("cannot create reports");
        cues << "case,lane,start_seconds,duration_seconds\n";
        metrics_json << std::setprecision(12);
        metrics_json << "{\n  \"schema\": \"brk-modal-p47b-kernel-parity-v1\",\n";
        metrics_json << "  \"sampleRate\": " << kSampleRate << ",\n";
        metrics_json << "  \"differenceGain\": " << kDifferenceGain << ",\n";
        metrics_json << "  \"vectorBackend\": \"" << brk::modal::modal_vector_kernel_backend() << "\",\n";
        metrics_json << "  \"cases\": [\n";

        const auto cases = build_cases();
        const std::uint32_t gap = kSampleRate / 10U;
        for (std::size_t case_index = 0; case_index < cases.size(); ++case_index) {
            const auto scalar = render(cases[case_index].patch, brk::modal::ModalKernel::Scalar, false);
            const auto vector = render(cases[case_index].patch, brk::modal::ModalKernel::Vector4, false);
            const auto switched = render(cases[case_index].patch, brk::modal::ModalKernel::Scalar, true);
            const auto fresh_metrics = compare(scalar, vector);
            const auto switch_metrics = compare(scalar, switched);

            append_silence(listening_left, listening_right, gap);
            const double scalar_start = static_cast<double>(listening_left.size()) / kSampleRate;
            append_render(listening_left, listening_right, scalar);
            cues << cases[case_index].id << ",scalar," << scalar_start << ",1.0\n";
            append_silence(listening_left, listening_right, gap);
            const double vector_start = static_cast<double>(listening_left.size()) / kSampleRate;
            append_render(listening_left, listening_right, vector);
            cues << cases[case_index].id << ",vector4," << vector_start << ",1.0\n";
            append_silence(listening_left, listening_right, gap);
            const double difference_start = static_cast<double>(listening_left.size()) / kSampleRate;
            append_difference(listening_left, listening_right, scalar, vector);
            cues << cases[case_index].id << ",difference_plus_80db," << difference_start << ",1.0\n";

            metrics_json << "    {\n";
            metrics_json << "      \"id\": \"" << cases[case_index].id << "\",\n";
            metrics_json << "      \"freshMaxAbsError\": " << fresh_metrics.maximum << ",\n";
            metrics_json << "      \"freshRmsError\": " << fresh_metrics.rms << ",\n";
            metrics_json << "      \"freshSignalRms\": " << fresh_metrics.signal_rms << ",\n";
            metrics_json << "      \"freshSnrDb\": " << fresh_metrics.snr_db << ",\n";
            metrics_json << "      \"switchMaxAbsError\": " << switch_metrics.maximum << ",\n";
            metrics_json << "      \"switchRmsError\": " << switch_metrics.rms << ",\n";
            metrics_json << "      \"switchSnrDb\": " << switch_metrics.snr_db << "\n";
            metrics_json << "    }" << (case_index + 1U == cases.size() ? "\n" : ",\n");
        }
        metrics_json << "  ]\n}\n";
        write_wav(output_dir / "brk-modal-p47b-kernel-listening.wav", listening_left, listening_right);
        std::cout << "vector_backend=" << brk::modal::modal_vector_kernel_backend() << '\n';
        std::cout << "listening_frames=" << listening_left.size() << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_p47b_kernel_parity: " << error.what() << '\n';
        return 1;
    }
}

#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

void write_u16(std::ofstream& out, std::uint16_t value) {
    const std::array<char, 2> bytes{static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU)};
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_u32(std::ofstream& out, std::uint32_t value) {
    const std::array<char, 4> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU),
        static_cast<char>((value >> 24U) & 0xffU),
    };
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_wav(const std::string& path, const std::vector<float>& left, const std::vector<float>& right, std::uint32_t sample_rate) {
    const auto frames = static_cast<std::uint32_t>(std::min(left.size(), right.size()));
    const std::uint32_t data_bytes = frames * 2U * 2U;
    std::ofstream out(path, std::ios::binary);
    out.write("RIFF", 4);
    write_u32(out, 36U + data_bytes);
    out.write("WAVEfmt ", 8);
    write_u32(out, 16U);
    write_u16(out, 1U);
    write_u16(out, 2U);
    write_u32(out, sample_rate);
    write_u32(out, sample_rate * 4U);
    write_u16(out, 4U);
    write_u16(out, 16U);
    out.write("data", 4);
    write_u32(out, data_bytes);
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto l = static_cast<std::int16_t>(std::lrint(std::clamp(left[i], -1.0F, 1.0F) * 32767.0F));
        const auto r = static_cast<std::int16_t>(std::lrint(std::clamp(right[i], -1.0F, 1.0F) * 32767.0F));
        write_u16(out, static_cast<std::uint16_t>(l));
        write_u16(out, static_cast<std::uint16_t>(r));
    }
}

} // namespace

int main(int argc, char** argv) {
    const std::string output = argc > 1 ? argv[1] : "brk-modal-demo.wav";
    constexpr std::uint32_t sample_rate = 48000;
    constexpr std::uint32_t block = 128;
    constexpr std::uint32_t total_frames = sample_rate * 6U;

    brk::modal::Engine engine;
    if (!engine.prepare(sample_rate, block, 0x4d594c445942524bULL)) return 1;

    auto patch = engine.patch();
    patch.resonator_a.model = brk::modal::Model::Plate;
    patch.resonator_a.ratio = 0.78F;
    patch.resonator_a.partials = 64;
    patch.resonator_a.decay_seconds = 2.4F;
    patch.resonator_a.material = -0.22F;
    patch.resonator_a.tone = 0.18F;
    patch.resonator_a.inharmonicity = 0.015F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::String;
    patch.resonator_b.partials = 32;
    patch.resonator_b.decay_seconds = 1.1F;
    patch.resonator_b.coarse_semitones = 12.0F;
    patch.parallel_mix = 0.28F;
    patch.exciter.mallet_resonator = 0.72F;
    patch.exciter.noise_resonator = 0.12F;
    patch.exciter.noise_decay_ms = 42.0F;
    patch.resonator_gain_db = 18.0F;
    patch.output_gain_db = -3.0F;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    engine.set_patch(patch);

    std::vector<float> left(total_frames);
    std::vector<float> right(total_frames);
    std::array<float, block> block_left{};
    std::array<float, block> block_right{};

    const std::array<int, 5> notes{48, 55, 60, 63, 67};
    for (std::uint32_t offset = 0; offset < total_frames; offset += block) {
        for (std::size_t n = 0; n < notes.size(); ++n) {
            if (offset == static_cast<std::uint32_t>(n) * sample_rate / 2U) {
                engine.note_on({static_cast<std::uint32_t>(n + 1U), static_cast<std::int16_t>(notes[n]), 0.82F, 0.0F});
            }
            if (offset == static_cast<std::uint32_t>(n) * sample_rate / 2U + sample_rate) {
                engine.note_off(static_cast<std::uint32_t>(n + 1U));
            }
        }
        const auto frames = std::min(block, total_frames - offset);
        engine.process(block_left.data(), block_right.data(), frames);
        std::copy_n(block_left.data(), frames, left.data() + offset);
        std::copy_n(block_right.data(), frames, right.data() + offset);
    }

    write_wav(output, left, right, sample_rate);
    std::cout << output << '\n';
    return 0;
}

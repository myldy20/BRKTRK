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
    out.write(bytes.data(), bytes.size());
}

void write_u32(std::ofstream& out, std::uint32_t value) {
    const std::array<char, 4> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU),
        static_cast<char>((value >> 24U) & 0xffU),
    };
    out.write(bytes.data(), bytes.size());
}

void write_wav(const std::string& path, const std::vector<float>& left, const std::vector<float>& right, std::uint32_t sample_rate) {
    const auto frames = static_cast<std::uint32_t>(std::min(left.size(), right.size()));
    const std::uint32_t data_bytes = frames * 4U;
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

brk::modal::Patch patch_for(brk::modal::Model model) {
    brk::modal::Patch patch{};
    patch.resonator_a.model = model;
    patch.resonator_a.partials = 64;
    patch.resonator_b.enabled = false;
    patch.release_mode = brk::modal::ReleaseMode::OneShot;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 0.85F;
    patch.exciter.mallet_resonator = 0.78F;
    patch.exciter.noise_resonator = 0.025F;
    patch.exciter.noise_decay_ms = 25.0F;
    patch.velocity.response = 0.9F;
    patch.output_gain_db = -9.0F;

    if (model == brk::modal::Model::Marimba2) {
        patch.resonator_a.decay_seconds = 1.8F;
        patch.resonator_a.material = -0.28F;
        patch.resonator_a.tone = -0.08F;
        patch.resonator_a.hit_position = 0.30F;
        patch.resonator_a.spectral_focus = 0.16F;
        patch.exciter.mallet_hardness_hz = 620.0F;
        patch.output_gain_db = -6.0F;
    } else if (model == brk::modal::Model::Bell) {
        patch.resonator_a.decay_seconds = 5.8F;
        patch.resonator_a.material = 0.06F;
        patch.resonator_a.tone = 0.04F;
        patch.resonator_a.hit_position = 0.24F;
        patch.resonator_a.spectral_focus = 0.12F;
        patch.exciter.mallet_hardness_hz = 980.0F;
        patch.exciter.noise_resonator = 0.012F;
        patch.output_gain_db = -12.0F;
    } else {
        patch.resonator_a.partials = 40;
        patch.resonator_a.decay_seconds = 0.95F;
        patch.resonator_a.material = -0.32F;
        patch.resonator_a.tone = -0.16F;
        patch.resonator_a.hit_position = 0.34F;
        patch.resonator_a.ratio = 1.0F;
        patch.resonator_a.spectral_focus = 0.34F;
        patch.exciter.mallet_hardness_hz = 330.0F;
        patch.exciter.noise_resonator = 0.12F;
        patch.exciter.noise_decay_ms = 52.0F;
        patch.output_gain_db = -7.0F;
    }
    return patch;
}

} // namespace

int main(int argc, char** argv) {
    const std::string output = argc > 1 ? argv[1] : "brk-modal-p25-upstream-models.wav";
    constexpr std::uint32_t sample_rate = 48000;
    constexpr std::uint32_t block = 128;
    constexpr std::uint32_t section_frames = sample_rate * 4U;
    constexpr std::uint32_t total_frames = section_frames * 3U;

    brk::modal::Engine engine;
    if (!engine.prepare(sample_rate, block, 0x52585031353138ULL)) return 1;

    std::vector<float> left(total_frames);
    std::vector<float> right(total_frames);
    std::array<float, block> block_left{};
    std::array<float, block> block_right{};

    for (std::uint32_t offset = 0; offset < total_frames; offset += block) {
        if (offset == 0U) {
            engine.set_patch(patch_for(brk::modal::Model::Marimba2));
            engine.note_on({1U, 48, 0.52F, 0.0F});
        }
        if (offset == sample_rate) engine.note_on({2U, 55, 0.70F, 0.0F});
        if (offset == sample_rate * 2U) engine.note_on({3U, 60, 0.86F, 0.0F});
        if (offset == section_frames) {
            engine.reset();
            engine.set_patch(patch_for(brk::modal::Model::Bell));
            engine.note_on({10U, 45, 0.76F, 0.0F});
            engine.note_on({11U, 52, 0.64F, 0.0F});
        }
        if (offset == section_frames + sample_rate * 2U) engine.note_on({12U, 57, 0.92F, 0.0F});
        if (offset == section_frames * 2U) {
            engine.reset();
            engine.set_patch(patch_for(brk::modal::Model::Djembe));
        }
        if (offset >= section_frames * 2U && (offset - section_frames * 2U) % (sample_rate / 2U) == 0U) {
            const auto hit = (offset - section_frames * 2U) / (sample_rate / 2U);
            const std::array<std::int16_t, 8> notes{38, 38, 43, 38, 50, 43, 38, 55};
            const std::array<float, 8> velocity{0.32F, 0.55F, 0.44F, 0.82F, 0.62F, 0.72F, 0.94F, 0.68F};
            if (hit < notes.size()) engine.note_on({100U + hit, notes[hit], velocity[hit], 0.0F});
        }

        const auto frames = std::min(block, total_frames - offset);
        engine.process(block_left.data(), block_right.data(), frames);
        std::copy_n(block_left.data(), frames, left.data() + offset);
        std::copy_n(block_right.data(), frames, right.data() + offset);
    }

    write_wav(output, left, right, sample_rate);
    float peak = 0.0F;
    for (std::size_t i = 0; i < left.size(); ++i) peak = std::max({peak, std::abs(left[i]), std::abs(right[i])});
    std::cout << output << '\n' << "peak=" << peak << '\n';
    return peak > 0.0F && peak <= 1.0F ? 0 : 2;
}

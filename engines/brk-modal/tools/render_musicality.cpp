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
        static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU), static_cast<char>((value >> 24U) & 0xffU),
    };
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
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

void render_segment(
    brk::modal::Engine& engine,
    std::vector<float>& left,
    std::vector<float>& right,
    std::uint32_t start,
    std::uint32_t length,
    const std::vector<int>& notes,
    float velocity) {

    constexpr std::uint32_t block = 128;
    std::array<float, block> block_left{};
    std::array<float, block> block_right{};
    for (std::size_t i = 0; i < notes.size(); ++i) {
        engine.note_on({static_cast<std::uint32_t>(i + 1U), static_cast<std::int16_t>(notes[i]), velocity, 0.0F});
    }
    for (std::uint32_t offset = 0; offset < length; offset += block) {
        if (offset == length / 2U) {
            for (std::size_t i = 0; i < notes.size(); ++i) engine.note_off(static_cast<std::uint32_t>(i + 1U));
        }
        const auto count = std::min(block, length - offset);
        engine.process(block_left.data(), block_right.data(), count);
        std::copy_n(block_left.data(), count, left.data() + start + offset);
        std::copy_n(block_right.data(), count, right.data() + start + offset);
    }
    engine.reset();
}

} // namespace

int main(int argc, char** argv) {
    const std::string output = argc > 1 ? argv[1] : "brk-modal-p1b-musicality.wav";
    constexpr std::uint32_t sample_rate = 48000;
    constexpr std::uint32_t seconds = 12;
    constexpr std::uint32_t segment = sample_rate * 3U;
    std::vector<float> left(sample_rate * seconds);
    std::vector<float> right(sample_rate * seconds);

    brk::modal::Engine engine;
    if (!engine.prepare(sample_rate, 128, 0x4d594c445942524bULL)) return 1;

    auto patch = engine.patch();
    patch.output_gain_db = -10.0F;
    patch.stereo_width = 0.8F;
    patch.resonator_gain_db = 16.0F;

    patch.resonator_a.model = brk::modal::Model::String;
    patch.resonator_a.partials = 48;
    patch.resonator_a.decay_seconds = 2.2F;
    patch.resonator_a.spectral_focus = 0.32F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::Beam;
    patch.resonator_b.partials = 32;
    patch.resonator_b.decay_seconds = 1.1F;
    patch.resonator_b.spectral_focus = 0.45F;
    patch.coupling = brk::modal::Coupling::Parallel;
    patch.parallel_mix = 0.28F;
    patch.exciter.noise_resonator = 0.03F;
    engine.set_patch(patch);
    render_segment(engine, left, right, 0U, segment, {48, 55, 60, 64}, 0.72F);

    patch.resonator_a.model = brk::modal::Model::Plate;
    patch.resonator_a.partials = 48;
    patch.resonator_a.decay_seconds = 2.8F;
    patch.resonator_a.spectral_focus = 0.52F;
    patch.resonator_b.model = brk::modal::Model::Membrane;
    patch.resonator_b.partials = 32;
    patch.resonator_b.decay_seconds = 1.4F;
    patch.resonator_b.spectral_focus = 0.58F;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.coupling_profile = brk::modal::CouplingProfile::Stable;
    patch.coupling_split = 0.08F;
    patch.max_coupling_detune_cents = 24.0F;
    patch.exciter.noise_resonator = 0.08F;
    patch.exciter.noise_decay_ms = 32.0F;
    engine.set_patch(patch);
    render_segment(engine, left, right, segment, segment, {43, 50, 55}, 0.78F);

    patch.resonator_a.model = brk::modal::Model::Marimba;
    patch.resonator_a.partials = 16;
    patch.resonator_a.decay_seconds = 1.2F;
    patch.resonator_a.spectral_focus = 0.18F;
    patch.resonator_b.enabled = false;
    patch.coupling = brk::modal::Coupling::Parallel;
    patch.exciter.noise_resonator = 0.0F;
    patch.exciter.mallet_hardness_hz = 1100.0F;
    engine.set_patch(patch);
    render_segment(engine, left, right, segment * 2U, segment, {48, 55, 60, 67}, 0.88F);

    patch.resonator_a.model = brk::modal::Model::ClosedTube;
    patch.resonator_a.decay_seconds = 2.5F;
    patch.resonator_a.tube_radius = 0.72F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::OpenTube;
    patch.resonator_b.decay_seconds = 1.7F;
    patch.resonator_b.coarse_semitones = 12.0F;
    patch.coupling = brk::modal::Coupling::Parallel;
    patch.parallel_mix = 0.38F;
    patch.exciter.noise_resonator = 0.12F;
    patch.exciter.noise_decay_ms = 70.0F;
    engine.set_patch(patch);
    render_segment(engine, left, right, segment * 3U, segment, {36, 43, 48}, 0.68F);

    write_wav(output, left, right, sample_rate);
    std::cout << output << '\n';
    return 0;
}

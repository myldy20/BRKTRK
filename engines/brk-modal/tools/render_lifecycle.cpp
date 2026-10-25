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
constexpr std::uint32_t kRate = 48000;
constexpr std::uint32_t kBlock = 128;

void write_u16(std::ofstream& out, std::uint16_t value) {
    const std::array<char, 2> bytes{static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU)};
    out.write(bytes.data(), bytes.size());
}

void write_u32(std::ofstream& out, std::uint32_t value) {
    const std::array<char, 4> bytes{
        static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU), static_cast<char>((value >> 24U) & 0xffU)};
    out.write(bytes.data(), bytes.size());
}

void write_wav(const std::string& path, const std::vector<float>& left, const std::vector<float>& right) {
    const auto frames = static_cast<std::uint32_t>(std::min(left.size(), right.size()));
    const std::uint32_t data_bytes = frames * 4U;
    std::ofstream out(path, std::ios::binary);
    out.write("RIFF", 4); write_u32(out, 36U + data_bytes); out.write("WAVEfmt ", 8);
    write_u32(out, 16U); write_u16(out, 1U); write_u16(out, 2U); write_u32(out, kRate);
    write_u32(out, kRate * 4U); write_u16(out, 4U); write_u16(out, 16U);
    out.write("data", 4); write_u32(out, data_bytes);
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto l = static_cast<std::int16_t>(std::lrint(std::clamp(left[i], -1.0F, 1.0F) * 32767.0F));
        const auto r = static_cast<std::int16_t>(std::lrint(std::clamp(right[i], -1.0F, 1.0F) * 32767.0F));
        write_u16(out, static_cast<std::uint16_t>(l));
        write_u16(out, static_cast<std::uint16_t>(r));
    }
}

template <typename Callback>
void render_segment(
    brk::modal::Engine& engine,
    std::vector<float>& left,
    std::vector<float>& right,
    std::uint32_t begin,
    std::uint32_t end,
    const Callback& event_callback) {

    std::array<float, kBlock> block_left{};
    std::array<float, kBlock> block_right{};
    for (std::uint32_t offset = begin; offset < end; offset += kBlock) {
        event_callback(offset - begin, engine);
        const auto frames = std::min(kBlock, end - offset);
        engine.process(block_left.data(), block_right.data(), frames);
        std::copy_n(block_left.data(), frames, left.data() + offset);
        std::copy_n(block_right.data(), frames, right.data() + offset);
    }
}

} // namespace

int main(int argc, char** argv) {
    const std::string output = argc > 1 ? argv[1] : "brk-modal-p2-lifecycle.wav";
    constexpr std::uint32_t section = kRate * 4U;
    constexpr std::uint32_t total = section * 4U;
    std::vector<float> left(total);
    std::vector<float> right(total);

    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 0x50324c4946454359ULL)) return 1;

    engine.set_patch(brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate));
    render_segment(engine, left, right, 0U, section, [](std::uint32_t frame, brk::modal::Engine& synth) {
        if (frame % (kRate / 2U) == 0U) {
            const float velocity = 0.45F + 0.45F * static_cast<float>((frame / (kRate / 2U)) % 3U) / 2.0F;
            synth.note_on({10U, 60, velocity, 0.0F});
        }
    });

    engine.reset();
    engine.set_patch(brk::modal::make_factory_patch(brk::modal::FactoryPatch::GlassString));
    engine.set_sustain(true);
    render_segment(engine, left, right, section, section * 2U, [](std::uint32_t frame, brk::modal::Engine& synth) {
        if (frame == 0U) {
            synth.note_on({20U, 48, 0.55F, 0.0F});
            synth.note_on({21U, 55, 0.68F, 0.0F});
            synth.note_on({22U, 60, 0.80F, 0.0F});
            synth.note_on({23U, 64, 0.92F, 0.0F});
        }
        if (frame == kRate) {
            synth.note_off(20U); synth.note_off(21U); synth.note_off(22U); synth.note_off(23U);
        }
        if (frame == kRate * 5U / 2U) synth.set_sustain(false);
    });

    engine.reset();
    engine.set_patch(brk::modal::make_factory_patch(brk::modal::FactoryPatch::DeepMembrane));
    render_segment(engine, left, right, section * 2U, section * 3U, [](std::uint32_t frame, brk::modal::Engine& synth) {
        constexpr std::array<float, 6> velocities{0.16F, 0.28F, 0.42F, 0.58F, 0.76F, 0.96F};
        const std::uint32_t step = kRate * 2U / 3U;
        if (frame % step == 0U) {
            const auto index = std::min<std::size_t>(frame / step, velocities.size() - 1U);
            synth.note_on({static_cast<std::uint32_t>(30U + index), 43, velocities[index], 0.0F});
        }
    });

    engine.reset();
    render_segment(engine, left, right, section * 3U, total, [](std::uint32_t frame, brk::modal::Engine& synth) {
        constexpr std::uint32_t slot = kRate * 2U / 3U;
        const auto index = std::min<std::uint32_t>(frame / slot, 5U);
        if (frame % slot == 0U) {
            synth.set_patch(brk::modal::make_factory_patch(static_cast<brk::modal::FactoryPatch>(index)));
            synth.note_on({static_cast<std::uint32_t>(40U + index), static_cast<std::int16_t>(48 + index * 3), 0.82F, 0.0F});
        }
    });

    write_wav(output, left, right);
    float peak = 0.0F;
    for (std::size_t i = 0; i < left.size(); ++i) peak = std::max({peak, std::abs(left[i]), std::abs(right[i])});
    std::cout << output << "\npeak=" << peak << '\n';
    return 0;
}

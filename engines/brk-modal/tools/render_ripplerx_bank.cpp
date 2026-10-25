#include "brk_modal/ripplerx_programs.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
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
constexpr std::uint32_t kBlock = 128;
constexpr float kRunawayPeak = 8.0F;

struct HashResult {
    std::uint64_t hash = 0U;
    float peak = 0.0F;
};

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

void write_wav(const std::string& path, const std::vector<float>& left, const std::vector<float>& right) {
    const auto frames = static_cast<std::uint32_t>(std::min(left.size(), right.size()));
    const std::uint32_t data_bytes = frames * 4U;
    std::ofstream out(path, std::ios::binary);
    out.write("RIFF", 4);
    write_u32(out, 36U + data_bytes);
    out.write("WAVEfmt ", 8);
    write_u32(out, 16U);
    write_u16(out, 1U);
    write_u16(out, 2U);
    write_u32(out, kSampleRate);
    write_u32(out, kSampleRate * 4U);
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

HashResult render_hash(brk::modal::RipplerXProgram program) {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlock, 0x52585042414e4bULL)) return {};
    engine.set_patch(brk::modal::make_ripplerx_program(program));
    engine.note_on({1U, 52, 0.73F, 0.0F});
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    HashResult result{1469598103934665603ULL, 0.0F};
    bool audible = false;
    for (std::uint32_t offset = 0; offset < kSampleRate / 2U; offset += kBlock) {
        if (offset == kSampleRate / 4U) engine.note_off(1U);
        const auto frames = std::min(kBlock, kSampleRate / 2U - offset);
        engine.process(left.data(), right.data(), frames);
        for (std::uint32_t i = 0; i < frames; ++i) {
            const float channel_peak = std::max(std::abs(left[i]), std::abs(right[i]));
            result.peak = std::max(result.peak, channel_peak);
            const float sample = 0.5F * (left[i] + right[i]);
            if (!std::isfinite(sample) || !std::isfinite(channel_peak) || channel_peak > kRunawayPeak) return {};
            audible = audible || std::abs(sample) > 1.0e-7F;
            const auto quantized = static_cast<std::int32_t>(std::lrint(sample * 1000000.0F));
            result.hash ^= static_cast<std::uint32_t>(quantized);
            result.hash *= 1099511628211ULL;
        }
    }
    if (!audible) return {};
    return result;
}

} // namespace

int main(int argc, char** argv) {
    const std::string output = argc > 1 ? argv[1] : "brk-modal-p25-ripplerx-programs.wav";

    std::array<std::uint64_t, brk::modal::kRipplerXProgramCount> hashes{};
    float largest_program_peak = 0.0F;
    std::size_t largest_program_index = 0U;
    for (std::size_t i = 0; i < hashes.size(); ++i) {
        const auto result = render_hash(static_cast<brk::modal::RipplerXProgram>(i));
        hashes[i] = result.hash;
        if (hashes[i] == 0U) return 2;
        if (result.peak > largest_program_peak) {
            largest_program_peak = result.peak;
            largest_program_index = i;
        }
    }
    std::size_t distinct = 0;
    for (std::size_t i = 0; i < hashes.size(); ++i) {
        bool first = true;
        for (std::size_t j = 0; j < i; ++j) first = first && hashes[j] != hashes[i];
        if (first) ++distinct;
    }
    if (distinct < 20U) return 3;

    constexpr std::uint32_t section_frames = kSampleRate * 3U;
    constexpr std::size_t section_count = 7U;
    constexpr std::uint32_t total_frames = section_frames * section_count;
    const std::array<brk::modal::RipplerXProgram, section_count> programs{
        brk::modal::RipplerXProgram::Harpsi,
        brk::modal::RipplerXProgram::Gong,
        brk::modal::RipplerXProgram::Marimba,
        brk::modal::RipplerXProgram::Tabla,
        brk::modal::RipplerXProgram::Ride2,
        brk::modal::RipplerXProgram::Flute,
        brk::modal::RipplerXProgram::Kalimba,
    };
    const std::array<std::array<std::int16_t, 4>, section_count> notes{{
        {{48, 55, 60, 67}},
        {{43, 50, 55, 62}},
        {{48, 55, 60, 64}},
        {{38, 43, 38, 50}},
        {{45, 52, 57, 64}},
        {{60, 64, 67, 72}},
        {{48, 55, 60, 67}},
    }};

    std::vector<float> left(total_frames);
    std::vector<float> right(total_frames);
    std::array<float, kBlock> block_left{};
    std::array<float, kBlock> block_right{};
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlock, 0x52585050524556ULL)) return 4;

    for (std::uint32_t offset = 0; offset < total_frames; offset += kBlock) {
        const std::size_t section = offset / section_frames;
        const std::uint32_t local = offset % section_frames;
        if (local == 0U) {
            engine.reset();
            engine.set_patch(brk::modal::make_ripplerx_program(programs[section]));
            std::cout << section << ": " << brk::modal::ripplerx_program_name(programs[section]) << '\n';
        }
        for (std::size_t hit = 0; hit < 4U; ++hit) {
            const std::uint32_t at = static_cast<std::uint32_t>(hit) * kSampleRate / 2U;
            if (local == at) {
                const float velocity = 0.42F + 0.16F * static_cast<float>(hit);
                engine.note_on({static_cast<std::uint32_t>(section * 16U + hit + 1U), notes[section][hit], velocity, 0.0F});
            }
            if (local == at + kSampleRate / 3U) {
                engine.note_off(static_cast<std::uint32_t>(section * 16U + hit + 1U));
            }
        }
        const auto frames = std::min(kBlock, total_frames - offset);
        engine.process(block_left.data(), block_right.data(), frames);
        std::copy_n(block_left.data(), frames, left.data() + offset);
        std::copy_n(block_right.data(), frames, right.data() + offset);
    }

    float peak = 0.0F;
    std::uint64_t clipped_samples = 0U;
    for (std::size_t i = 0; i < left.size(); ++i) {
        if (!std::isfinite(left[i]) || !std::isfinite(right[i])) return 5;
        peak = std::max({peak, std::abs(left[i]), std::abs(right[i])});
        clipped_samples += static_cast<std::uint64_t>(std::abs(left[i]) > 1.0F);
        clipped_samples += static_cast<std::uint64_t>(std::abs(right[i]) > 1.0F);
    }
    if (!(peak > 0.0F && peak <= kRunawayPeak)) return 5;
    write_wav(output, left, right);

    std::cout << "distinct_program_hashes=" << distinct << '\n';
    std::cout << "largest_single_program_peak=" << largest_program_peak << '\n';
    std::cout << "largest_single_program="
              << brk::modal::ripplerx_program_name(
                     static_cast<brk::modal::RipplerXProgram>(largest_program_index))
              << '\n';
    std::cout << "preview_raw_peak=" << peak << '\n';
    std::cout << "preview_clipped_channel_samples=" << clipped_samples << '\n';
    return 0;
}

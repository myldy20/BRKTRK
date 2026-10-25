#include "brk_modal/brk_modal.hpp"
#include "brk_modal/ripplerx_programs.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
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

struct CaptureCase {
    std::string case_id;
    std::uint32_t program_index = 0U;
    std::uint64_t brk_seed = 0U;
    std::int16_t key = 60;
    float velocity = 0.75F;
    std::uint32_t note_on_frame = 0U;
    std::uint32_t note_off_frame = 38400U;
    std::uint32_t total_frames = 144000U;
    std::uint32_t sample_rate = 48000U;
    std::uint32_t block_size = 128U;
    std::string filename;
};

std::vector<std::string> split_csv_line(const std::string& line) {
    std::vector<std::string> fields;
    std::string field;
    bool quoted = false;
    for (std::size_t index = 0; index < line.size(); ++index) {
        const char character = line[index];
        if (character == '"') {
            if (quoted && index + 1U < line.size() && line[index + 1U] == '"') {
                field.push_back('"');
                ++index;
            } else {
                quoted = !quoted;
            }
        } else if (character == ',' && !quoted) {
            fields.push_back(field);
            field.clear();
        } else if (character != '\r') {
            field.push_back(character);
        }
    }
    fields.push_back(field);
    return fields;
}

std::size_t column_index(const std::vector<std::string>& header, const std::string& name) {
    const auto found = std::find(header.begin(), header.end(), name);
    if (found == header.end()) throw std::runtime_error("missing CSV column: " + name);
    return static_cast<std::size_t>(std::distance(header.begin(), found));
}

std::vector<CaptureCase> read_cases(const std::filesystem::path& path) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("cannot open ensemble plan: " + path.string());
    std::string line;
    if (!std::getline(input, line)) throw std::runtime_error("empty ensemble plan");
    const auto header = split_csv_line(line);
    const auto c_case = column_index(header, "case_id");
    const auto c_program = column_index(header, "program_index");
    const auto c_seed = column_index(header, "brk_seed_decimal");
    const auto c_key = column_index(header, "key");
    const auto c_velocity = column_index(header, "velocity");
    const auto c_on = column_index(header, "note_on_frame");
    const auto c_off = column_index(header, "note_off_frame");
    const auto c_total = column_index(header, "total_frames");
    const auto c_rate = column_index(header, "sample_rate");
    const auto c_block = column_index(header, "block_size");
    const auto c_filename = column_index(header, "brk_filename");

    std::vector<CaptureCase> result;
    while (std::getline(input, line)) {
        if (line.empty()) continue;
        const auto fields = split_csv_line(line);
        if (fields.size() != header.size()) throw std::runtime_error("invalid CSV row width");
        CaptureCase item;
        item.case_id = fields[c_case];
        item.program_index = static_cast<std::uint32_t>(std::stoul(fields[c_program]));
        item.brk_seed = std::stoull(fields[c_seed]);
        item.key = static_cast<std::int16_t>(std::stoi(fields[c_key]));
        item.velocity = std::stof(fields[c_velocity]);
        item.note_on_frame = static_cast<std::uint32_t>(std::stoul(fields[c_on]));
        item.note_off_frame = static_cast<std::uint32_t>(std::stoul(fields[c_off]));
        item.total_frames = static_cast<std::uint32_t>(std::stoul(fields[c_total]));
        item.sample_rate = static_cast<std::uint32_t>(std::stoul(fields[c_rate]));
        item.block_size = static_cast<std::uint32_t>(std::stoul(fields[c_block]));
        item.filename = fields[c_filename];
        if (item.program_index >= brk::modal::kRipplerXProgramCount) throw std::runtime_error("program index out of range");
        if (item.brk_seed == 0U || item.block_size == 0U || item.total_frames == 0U) {
            throw std::runtime_error("invalid ensemble dimensions or seed");
        }
        if (item.note_on_frame >= item.total_frames || item.note_off_frame > item.total_frames) {
            throw std::runtime_error("event frame out of range");
        }
        result.push_back(item);
    }
    if (result.empty()) throw std::runtime_error("ensemble plan has no cases");
    return result;
}

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

void write_wav(const std::filesystem::path& path,
               std::uint32_t sample_rate,
               const std::vector<float>& left,
               const std::vector<float>& right) {
    if (left.size() != right.size()) throw std::runtime_error("channel size mismatch");
    std::ofstream output(path, std::ios::binary);
    if (!output) throw std::runtime_error("cannot create WAV: " + path.string());
    const auto frames = static_cast<std::uint32_t>(left.size());
    const std::uint32_t data_bytes = frames * 8U;
    output.write("RIFF", 4);
    write_u32(output, 36U + data_bytes);
    output.write("WAVEfmt ", 8);
    write_u32(output, 16U);
    write_u16(output, 1U);
    write_u16(output, 2U);
    write_u32(output, sample_rate);
    write_u32(output, sample_rate * 8U);
    write_u16(output, 8U);
    write_u16(output, 32U);
    output.write("data", 4);
    write_u32(output, data_bytes);
    const auto quantize = [](float sample) {
        const double bounded = std::clamp(static_cast<double>(sample), -1.0, 1.0);
        return static_cast<std::int32_t>(std::llround(bounded * 2147483647.0));
    };
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        write_u32(output, static_cast<std::uint32_t>(quantize(left[frame])));
        write_u32(output, static_cast<std::uint32_t>(quantize(right[frame])));
    }
}

void render_case(const CaptureCase& item, const std::filesystem::path& output_dir) {
    brk::modal::Engine engine;
    if (!engine.prepare(item.sample_rate, item.block_size, item.brk_seed)) {
        throw std::runtime_error("engine prepare failed");
    }
    engine.set_patch(brk::modal::apply_quality_profile(
        brk::modal::make_ripplerx_program(static_cast<brk::modal::RipplerXProgram>(item.program_index)),
        brk::modal::QualityProfile::Full));

    std::vector<float> left(item.total_frames, 0.0F);
    std::vector<float> right(item.total_frames, 0.0F);
    std::vector<float> block_left(item.block_size, 0.0F);
    std::vector<float> block_right(item.block_size, 0.0F);
    bool note_started = false;
    bool note_released = false;
    std::uint32_t cursor = 0U;
    while (cursor < item.total_frames) {
        if (!note_started && cursor == item.note_on_frame) {
            engine.note_on({1U, item.key, item.velocity, 0.0F});
            note_started = true;
        }
        if (!note_released && cursor == item.note_off_frame) {
            engine.note_off(1U);
            note_released = true;
        }
        std::uint32_t count = std::min(item.block_size, item.total_frames - cursor);
        if (!note_started && item.note_on_frame > cursor) count = std::min(count, item.note_on_frame - cursor);
        if (!note_released && item.note_off_frame > cursor) count = std::min(count, item.note_off_frame - cursor);
        if (count == 0U) continue;
        engine.process(block_left.data(), block_right.data(), count);
        std::copy_n(block_left.data(), count, left.data() + cursor);
        std::copy_n(block_right.data(), count, right.data() + cursor);
        cursor += count;
    }

    float peak = 0.0F;
    for (std::size_t frame = 0U; frame < left.size(); ++frame) {
        if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])) {
            throw std::runtime_error("non-finite BRK ensemble capture");
        }
        peak = std::max({peak, std::abs(left[frame]), std::abs(right[frame])});
    }
    if (!(peak > 0.0F && peak <= 1.0F)) throw std::runtime_error("invalid BRK ensemble peak");
    write_wav(output_dir / item.filename, item.sample_rate, left, right);
    std::cout << item.case_id << ",brk_seed=" << item.brk_seed << ",peak=" << peak << '\n';
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 3) {
            std::cerr << "usage: brk_modal_p47a_noise_ensemble <cases.csv> <output-dir>\n";
            return 2;
        }
        const std::filesystem::path plan = argv[1];
        const std::filesystem::path output_dir = argv[2];
        std::filesystem::create_directories(output_dir);
        const auto cases = read_cases(plan);
        for (const auto& item : cases) render_case(item, output_dir);
        std::cout << "p47a_brk_capture_count=" << cases.size() << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_p47a_noise_ensemble: " << error.what() << '\n';
        return 1;
    }
}

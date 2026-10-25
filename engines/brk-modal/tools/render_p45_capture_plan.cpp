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
#include <numeric>
#include <sstream>
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
    std::uint32_t program_index = 0;
    std::int16_t key = 60;
    float velocity = 0.75F;
    std::uint32_t note_on_frame = 0;
    std::uint32_t note_off_frame = 38400;
    std::uint32_t total_frames = 144000;
    std::uint32_t sample_rate = 48000;
    std::uint32_t block_size = 128;
    std::string candidate_filename;
};

struct RenderedAudio {
    std::vector<float> left;
    std::vector<float> right;
    float peak = 0.0F;
};

struct AudioMetrics {
    double raw_rms_delta_db = 0.0;
    double matched_gain = 1.0;
    double matched_correlation = 1.0;
    double matched_nrmse = 0.0;
};

struct CpuMetrics {
    double p50_us = 0.0;
    double p95_us = 0.0;
    double p99_us = 0.0;
    double maximum_us = 0.0;
    double p99_deadline_fraction = 0.0;
    double checksum = 0.0;
};

std::vector<std::string> split_csv_line(const std::string& line) {
    std::vector<std::string> fields;
    std::string field;
    bool quoted = false;
    for (std::size_t i = 0; i < line.size(); ++i) {
        const char ch = line[i];
        if (ch == '"') {
            if (quoted && i + 1U < line.size() && line[i + 1U] == '"') {
                field.push_back('"');
                ++i;
            } else {
                quoted = !quoted;
            }
        } else if (ch == ',' && !quoted) {
            fields.push_back(field);
            field.clear();
        } else if (ch != '\r') {
            field.push_back(ch);
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
    if (!input) throw std::runtime_error("cannot open capture plan: " + path.string());
    std::string line;
    if (!std::getline(input, line)) throw std::runtime_error("empty capture plan");
    const auto header = split_csv_line(line);
    const auto c_case = column_index(header, "case_id");
    const auto c_program = column_index(header, "program_index");
    const auto c_key = column_index(header, "key");
    const auto c_velocity = column_index(header, "velocity");
    const auto c_on = column_index(header, "note_on_frame");
    const auto c_off = column_index(header, "note_off_frame");
    const auto c_total = column_index(header, "total_frames");
    const auto c_rate = column_index(header, "sample_rate");
    const auto c_block = column_index(header, "block_size");
    const auto c_filename = column_index(header, "candidate_filename");

    std::vector<CaptureCase> result;
    while (std::getline(input, line)) {
        if (line.empty()) continue;
        const auto fields = split_csv_line(line);
        if (fields.size() != header.size()) throw std::runtime_error("invalid CSV row width");
        CaptureCase item;
        item.case_id = fields[c_case];
        item.program_index = static_cast<std::uint32_t>(std::stoul(fields[c_program]));
        item.key = static_cast<std::int16_t>(std::stoi(fields[c_key]));
        item.velocity = std::stof(fields[c_velocity]);
        item.note_on_frame = static_cast<std::uint32_t>(std::stoul(fields[c_on]));
        item.note_off_frame = static_cast<std::uint32_t>(std::stoul(fields[c_off]));
        item.total_frames = static_cast<std::uint32_t>(std::stoul(fields[c_total]));
        item.sample_rate = static_cast<std::uint32_t>(std::stoul(fields[c_rate]));
        item.block_size = static_cast<std::uint32_t>(std::stoul(fields[c_block]));
        item.candidate_filename = fields[c_filename];
        if (item.program_index >= brk::modal::kRipplerXProgramCount) throw std::runtime_error("program index out of range");
        if (item.block_size == 0U || item.total_frames == 0U) throw std::runtime_error("invalid capture dimensions");
        if (item.note_on_frame >= item.total_frames || item.note_off_frame > item.total_frames) {
            throw std::runtime_error("event frame out of range");
        }
        result.push_back(item);
    }
    if (result.empty()) throw std::runtime_error("capture plan has no cases");
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

void write_wav(
    const std::filesystem::path& path,
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
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        write_u32(output, static_cast<std::uint32_t>(quantize(left[frame])));
        write_u32(output, static_cast<std::uint32_t>(quantize(right[frame])));
    }
}

RenderedAudio render_audio(const CaptureCase& item, brk::modal::QualityProfile profile) {
    brk::modal::Engine engine;
    const std::uint64_t seed = 0x5034354341500000ULL | static_cast<std::uint64_t>(item.program_index);
    if (!engine.prepare(item.sample_rate, item.block_size, seed)) throw std::runtime_error("engine prepare failed");
    const auto source = brk::modal::make_ripplerx_program(
        static_cast<brk::modal::RipplerXProgram>(item.program_index));
    engine.set_patch(brk::modal::apply_quality_profile(source, profile));

    RenderedAudio result;
    result.left.assign(item.total_frames, 0.0F);
    result.right.assign(item.total_frames, 0.0F);
    std::vector<float> block_left(item.block_size, 0.0F);
    std::vector<float> block_right(item.block_size, 0.0F);
    bool note_started = false;
    bool note_released = false;
    std::uint32_t cursor = 0;
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
        std::copy_n(block_left.data(), count, result.left.data() + cursor);
        std::copy_n(block_right.data(), count, result.right.data() + cursor);
        cursor += count;
    }

    for (std::size_t frame = 0; frame < result.left.size(); ++frame) {
        if (!std::isfinite(result.left[frame]) || !std::isfinite(result.right[frame])) {
            throw std::runtime_error("non-finite capture");
        }
        result.peak = std::max({result.peak, std::abs(result.left[frame]), std::abs(result.right[frame])});
    }
    if (!(result.peak > 0.0F && result.peak <= 1.0F)) throw std::runtime_error("invalid capture peak");
    return result;
}

void render_case(const CaptureCase& item, const std::filesystem::path& output_dir) {
    const auto audio = render_audio(item, brk::modal::QualityProfile::Full);
    write_wav(output_dir / item.candidate_filename, item.sample_rate, audio.left, audio.right);
    std::cout << item.case_id << ",peak=" << audio.peak << '\n';
}

AudioMetrics compare_audio(const RenderedAudio& reference, const RenderedAudio& candidate) {
    if (reference.left.size() != candidate.left.size()) throw std::runtime_error("quality audio size mismatch");
    long double reference_energy = 0.0L;
    long double candidate_energy = 0.0L;
    for (std::size_t frame = 0; frame < reference.left.size(); ++frame) {
        const long double ref = 0.5L * (reference.left[frame] + reference.right[frame]);
        const long double cand = 0.5L * (candidate.left[frame] + candidate.right[frame]);
        reference_energy += ref * ref;
        candidate_energy += cand * cand;
    }
    const long double epsilon = 1.0e-30L;
    const long double gain = std::sqrt((reference_energy + epsilon) / (candidate_energy + epsilon));
    long double dot = 0.0L;
    long double matched_energy = 0.0L;
    long double error_energy = 0.0L;
    for (std::size_t frame = 0; frame < reference.left.size(); ++frame) {
        const long double ref = 0.5L * (reference.left[frame] + reference.right[frame]);
        const long double cand = 0.5L * (candidate.left[frame] + candidate.right[frame]) * gain;
        dot += ref * cand;
        matched_energy += cand * cand;
        const long double error = ref - cand;
        error_energy += error * error;
    }

    AudioMetrics result;
    result.raw_rms_delta_db = 10.0 * std::log10(static_cast<double>((candidate_energy + epsilon) / (reference_energy + epsilon)));
    result.matched_gain = static_cast<double>(gain);
    result.matched_correlation = static_cast<double>(
        dot / std::sqrt((reference_energy + epsilon) * (matched_energy + epsilon)));
    result.matched_nrmse = std::sqrt(static_cast<double>(error_energy / (reference_energy + epsilon)));
    return result;
}

double percentile(const std::vector<double>& sorted, double fraction) {
    if (sorted.empty()) return 0.0;
    const double position = fraction * static_cast<double>(sorted.size() - 1U);
    const auto low = static_cast<std::size_t>(std::floor(position));
    const auto high = static_cast<std::size_t>(std::ceil(position));
    const double mix = position - static_cast<double>(low);
    return sorted[low] * (1.0 - mix) + sorted[high] * mix;
}

CpuMetrics benchmark_profile(
    brk::modal::RipplerXProgram program,
    brk::modal::QualityProfile profile) {
    constexpr std::uint32_t sample_rate = 48000U;
    constexpr std::uint32_t block_size = 128U;
    constexpr std::size_t warmup_blocks = 256U;
    constexpr std::size_t measured_blocks = 2048U;
    constexpr std::size_t requested_voices = 8U;
    const std::array<std::int16_t, requested_voices> notes{36, 43, 48, 52, 55, 60, 64, 67};

    brk::modal::Engine engine;
    const auto program_index = static_cast<std::uint32_t>(program);
    if (!engine.prepare(sample_rate, block_size, 0x50345155414c0000ULL | program_index)) {
        throw std::runtime_error("quality benchmark prepare failed");
    }
    const auto source = brk::modal::make_ripplerx_program(program);
    engine.set_patch(brk::modal::apply_quality_profile(source, profile));
    std::array<float, block_size> left{};
    std::array<float, block_size> right{};

    const auto process_block = [&](std::size_t block_index) {
        if (block_index == 0U || block_index % 64U == 0U) {
            for (std::size_t voice = 0; voice < requested_voices; ++voice) {
                const std::uint32_t note_id = static_cast<std::uint32_t>(voice + 1U);
                if (block_index != 0U) engine.note_off(note_id);
                engine.note_on({note_id, notes[voice], 0.75F, 0.0F});
            }
        }
        engine.process(left.data(), right.data(), block_size);
    };

    for (std::size_t block = 0; block < warmup_blocks; ++block) process_block(block);
    std::vector<double> timings;
    timings.reserve(measured_blocks);
    long double checksum = 0.0L;
    for (std::size_t block = 0; block < measured_blocks; ++block) {
        const auto start = std::chrono::steady_clock::now();
        process_block(block);
        const auto finish = std::chrono::steady_clock::now();
        timings.push_back(std::chrono::duration<double, std::micro>(finish - start).count());
        checksum += left[block % block_size];
        checksum += right[(block * 7U) % block_size];
    }
    std::sort(timings.begin(), timings.end());
    const double deadline_us = static_cast<double>(block_size) * 1.0e6 / static_cast<double>(sample_rate);

    CpuMetrics result;
    result.p50_us = percentile(timings, 0.50);
    result.p95_us = percentile(timings, 0.95);
    result.p99_us = percentile(timings, 0.99);
    result.maximum_us = timings.back();
    result.p99_deadline_fraction = result.p99_us / deadline_us;
    result.checksum = static_cast<double>(checksum);
    return result;
}

std::string profile_slug(brk::modal::QualityProfile profile) {
    switch (profile) {
    case brk::modal::QualityProfile::Full: return "full";
    case brk::modal::QualityProfile::Balanced: return "balanced";
    case brk::modal::QualityProfile::Economy: return "economy";
    case brk::modal::QualityProfile::Draft: return "draft";
    }
    return "full";
}

void render_quality_evidence(
    const std::vector<CaptureCase>& cases,
    const std::filesystem::path& evidence_root) {
    const std::array<std::uint32_t, 6> selected_programs{12U, 14U, 22U, 23U, 25U, 27U};
    const std::array<brk::modal::QualityProfile, 4> profiles{
        brk::modal::QualityProfile::Full,
        brk::modal::QualityProfile::Balanced,
        brk::modal::QualityProfile::Economy,
        brk::modal::QualityProfile::Draft,
    };
    const std::filesystem::path quality_dir = evidence_root / "quality";
    std::filesystem::create_directories(quality_dir);
    std::ofstream report(evidence_root / "quality-profile-report.csv");
    if (!report) throw std::runtime_error("cannot create quality profile report");
    report << std::setprecision(12);
    report << "program_index,program_name,case_id,profile,modal_cap,polyphony_cap,actual_polyphony,work_units,"
              "raw_rms_delta_db,matched_gain,matched_correlation,matched_nrmse,p50_us,p95_us,p99_us,max_us,p99_deadline_fraction,checksum\n";

    for (const auto program_index : selected_programs) {
        const auto found = std::find_if(cases.begin(), cases.end(), [program_index](const CaptureCase& item) {
            return item.program_index == program_index
                && item.case_id.find("_mid_v075") != std::string::npos;
        });
        if (found == cases.end()) throw std::runtime_error("missing selected quality case");
        const CaptureCase& item = *found;
        const auto program = static_cast<brk::modal::RipplerXProgram>(program_index);
        const auto source_patch = brk::modal::make_ripplerx_program(program);
        const RenderedAudio full_audio = render_audio(item, brk::modal::QualityProfile::Full);

        for (const auto profile : profiles) {
            const auto profile_audio = profile == brk::modal::QualityProfile::Full
                ? full_audio
                : render_audio(item, profile);
            const std::string slug = profile_slug(profile);
            write_wav(
                quality_dir / (item.case_id + "_" + slug + ".wav"),
                item.sample_rate,
                profile_audio.left,
                profile_audio.right);
            const AudioMetrics audio = compare_audio(full_audio, profile_audio);
            const CpuMetrics cpu = benchmark_profile(program, profile);
            const auto patch = brk::modal::apply_quality_profile(source_patch, profile);
            const auto spec = brk::modal::quality_profile_spec(profile);
            report << program_index << ','
                   << brk::modal::ripplerx_program_name(program) << ','
                   << item.case_id << ','
                   << brk::modal::quality_profile_name(profile) << ','
                   << static_cast<unsigned int>(spec.modal_cap) << ','
                   << static_cast<unsigned int>(spec.polyphony_cap) << ','
                   << static_cast<unsigned int>(patch.polyphony) << ','
                   << brk::modal::estimated_modal_work_units(patch) << ','
                   << audio.raw_rms_delta_db << ','
                   << audio.matched_gain << ','
                   << audio.matched_correlation << ','
                   << audio.matched_nrmse << ','
                   << cpu.p50_us << ','
                   << cpu.p95_us << ','
                   << cpu.p99_us << ','
                   << cpu.maximum_us << ','
                   << cpu.p99_deadline_fraction << ','
                   << cpu.checksum << '\n';
            std::cout << "quality," << brk::modal::ripplerx_program_name(program)
                      << ',' << brk::modal::quality_profile_name(profile)
                      << ",work=" << brk::modal::estimated_modal_work_units(patch)
                      << ",corr=" << audio.matched_correlation
                      << ",nrmse=" << audio.matched_nrmse
                      << ",p99_us=" << cpu.p99_us << '\n';
        }
    }
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 3) {
            std::cerr << "usage: brk_modal_p45_capture <cases.csv> <output-dir>\n";
            return 2;
        }
        const std::filesystem::path plan = argv[1];
        const std::filesystem::path output_dir = argv[2];
        std::filesystem::create_directories(output_dir);
        const auto cases = read_cases(plan);
        for (const auto& item : cases) render_case(item, output_dir);
        render_quality_evidence(cases, output_dir.parent_path());
        std::cout << "capture_count=" << cases.size() << '\n';
        std::cout << "quality_capture_count=24\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_p45_capture: " << error.what() << '\n';
        return 1;
    }
}

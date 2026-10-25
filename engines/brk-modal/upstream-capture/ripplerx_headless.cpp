#include <JuceHeader.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

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
    std::uint32_t rng_seed = 0U;
    bool explicit_rng_seed = false;
    std::string reference_filename;
};

struct BenchmarkResult {
    std::string id;
    std::uint32_t program_index = 0;
    std::size_t voices = 0;
    double p50_us = 0.0;
    double p95_us = 0.0;
    double p99_us = 0.0;
    double maximum_us = 0.0;
    double p99_deadline_fraction = 0.0;
    double checksum = 0.0;
};

struct Arguments {
    std::filesystem::path plan;
    std::filesystem::path output_dir;
    std::filesystem::path benchmark;
    std::filesystem::path ensemble_plan;
    std::filesystem::path ensemble_output_dir;
    bool quick = false;
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
        } else {
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
    const auto c_filename = column_index(header, "reference_filename");

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
        item.reference_filename = fields[c_filename];
        if (item.program_index >= 28U) throw std::runtime_error("program index out of range");
        if (item.block_size == 0U || item.total_frames == 0U) throw std::runtime_error("invalid capture dimensions");
        result.push_back(item);
    }
    if (result.empty()) throw std::runtime_error("capture plan has no cases");
    return result;
}

std::vector<CaptureCase> read_ensemble_cases(const std::filesystem::path& path) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("cannot open ensemble plan: " + path.string());
    std::string line;
    if (!std::getline(input, line)) throw std::runtime_error("empty ensemble plan");
    const auto header = split_csv_line(line);
    const auto c_case = column_index(header, "case_id");
    const auto c_program = column_index(header, "program_index");
    const auto c_seed = column_index(header, "seed_decimal");
    const auto c_key = column_index(header, "key");
    const auto c_velocity = column_index(header, "velocity");
    const auto c_on = column_index(header, "note_on_frame");
    const auto c_off = column_index(header, "note_off_frame");
    const auto c_total = column_index(header, "total_frames");
    const auto c_rate = column_index(header, "sample_rate");
    const auto c_block = column_index(header, "block_size");
    const auto c_filename = column_index(header, "upstream_filename");

    std::vector<CaptureCase> result;
    while (std::getline(input, line)) {
        if (line.empty()) continue;
        const auto fields = split_csv_line(line);
        if (fields.size() != header.size()) throw std::runtime_error("invalid ensemble CSV row width");
        CaptureCase item;
        item.case_id = fields[c_case];
        item.program_index = static_cast<std::uint32_t>(std::stoul(fields[c_program]));
        item.rng_seed = static_cast<std::uint32_t>(std::stoul(fields[c_seed]));
        item.explicit_rng_seed = true;
        item.key = static_cast<std::int16_t>(std::stoi(fields[c_key]));
        item.velocity = std::stof(fields[c_velocity]);
        item.note_on_frame = static_cast<std::uint32_t>(std::stoul(fields[c_on]));
        item.note_off_frame = static_cast<std::uint32_t>(std::stoul(fields[c_off]));
        item.total_frames = static_cast<std::uint32_t>(std::stoul(fields[c_total]));
        item.sample_rate = static_cast<std::uint32_t>(std::stoul(fields[c_rate]));
        item.block_size = static_cast<std::uint32_t>(std::stoul(fields[c_block]));
        item.reference_filename = fields[c_filename];
        if (item.program_index >= 28U) throw std::runtime_error("ensemble program index out of range");
        if (item.rng_seed == 0U || item.block_size == 0U || item.total_frames == 0U) {
            throw std::runtime_error("invalid ensemble dimensions or seed");
        }
        if (item.note_on_frame >= item.total_frames || item.note_off_frame > item.total_frames) {
            throw std::runtime_error("ensemble event frame out of range");
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

std::unique_ptr<juce::AudioProcessor> create_processor(
    std::uint32_t sample_rate,
    std::uint32_t block_size,
    std::uint32_t program_index) {
    std::unique_ptr<juce::AudioProcessor> processor(createPluginFilter());
    if (!processor) throw std::runtime_error("createPluginFilter returned null");
    processor->setNonRealtime(true);
    processor->setRateAndBufferSizeDetails(static_cast<double>(sample_rate), static_cast<int>(block_size));
    processor->setCurrentProgram(static_cast<int>(program_index));
    processor->prepareToPlay(static_cast<double>(sample_rate), static_cast<int>(block_size));
    if (processor->getTotalNumOutputChannels() < 2) throw std::runtime_error("upstream processor is not stereo");
    return processor;
}

void render_case(const CaptureCase& item, const std::filesystem::path& output_dir) {
    const std::uint32_t seed = item.explicit_rng_seed
        ? item.rng_seed
        : static_cast<std::uint32_t>(0x50343500U + item.program_index);
    // P4.7A requires this call immediately before constructing the real pinned
    // RipplerX AudioProcessor so each ensemble take has an explicit std::rand lane.
    std::srand(static_cast<unsigned int>(seed));
    auto processor = create_processor(item.sample_rate, item.block_size, item.program_index);
    const int channels = std::max(2, std::max(processor->getTotalNumInputChannels(), processor->getTotalNumOutputChannels()));
    juce::AudioBuffer<float> buffer(channels, static_cast<int>(item.block_size));
    juce::MidiBuffer midi;
    std::vector<float> left(item.total_frames, 0.0F);
    std::vector<float> right(item.total_frames, 0.0F);

    for (std::uint32_t cursor = 0; cursor < item.total_frames; cursor += item.block_size) {
        const std::uint32_t count = std::min(item.block_size, item.total_frames - cursor);
        buffer.setSize(channels, static_cast<int>(count), false, false, true);
        buffer.clear();
        midi.clear();
        if (item.note_on_frame >= cursor && item.note_on_frame < cursor + count) {
            midi.addEvent(
                juce::MidiMessage::noteOn(1, static_cast<int>(item.key), item.velocity),
                static_cast<int>(item.note_on_frame - cursor));
        }
        if (item.note_off_frame >= cursor && item.note_off_frame < cursor + count) {
            midi.addEvent(
                juce::MidiMessage::noteOff(1, static_cast<int>(item.key)),
                static_cast<int>(item.note_off_frame - cursor));
        }
        processor->processBlock(buffer, midi);
        const float* source_left = buffer.getReadPointer(0);
        const float* source_right = buffer.getReadPointer(1);
        std::copy_n(source_left, count, left.data() + cursor);
        std::copy_n(source_right, count, right.data() + cursor);
    }
    processor->releaseResources();

    float peak = 0.0F;
    for (std::size_t frame = 0; frame < left.size(); ++frame) {
        if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])) throw std::runtime_error("non-finite upstream capture");
        peak = std::max({peak, std::abs(left[frame]), std::abs(right[frame])});
    }
    if (!(peak > 0.0F)) throw std::runtime_error("silent upstream capture: " + item.case_id);
    write_wav(output_dir / item.reference_filename, item.sample_rate, left, right);
    std::cout << item.case_id << ",rng_seed=" << seed << ",peak=" << peak << '\n';
}

double percentile(const std::vector<double>& sorted, double fraction) {
    if (sorted.empty()) return 0.0;
    const double position = fraction * static_cast<double>(sorted.size() - 1U);
    const auto low = static_cast<std::size_t>(std::floor(position));
    const auto high = static_cast<std::size_t>(std::ceil(position));
    const double mix = position - static_cast<double>(low);
    return sorted[low] * (1.0 - mix) + sorted[high] * mix;
}

BenchmarkResult benchmark_case(
    std::uint32_t program_index,
    std::size_t voices,
    std::size_t warmup_blocks,
    std::size_t measured_blocks) {
    constexpr std::uint32_t sample_rate = 48000;
    constexpr std::uint32_t block_size = 128;
    std::srand(static_cast<unsigned int>(0x50344200U + program_index));
    auto processor = create_processor(sample_rate, block_size, program_index);
    const int channels = std::max(2, std::max(processor->getTotalNumInputChannels(), processor->getTotalNumOutputChannels()));
    juce::AudioBuffer<float> buffer(channels, static_cast<int>(block_size));
    juce::MidiBuffer midi;
    const std::array<int, 8> notes{36, 43, 48, 52, 55, 60, 64, 67};

    const auto process_one = [&](std::size_t block_index, bool timed, std::vector<double>* timings, long double* checksum) {
        buffer.clear();
        midi.clear();
        if (block_index == 0U || block_index % 64U == 0U) {
            for (std::size_t voice = 0; voice < voices; ++voice) {
                if (block_index != 0U) midi.addEvent(juce::MidiMessage::noteOff(1, notes[voice]), 0);
                midi.addEvent(juce::MidiMessage::noteOn(1, notes[voice], 0.75F), 0);
            }
        }
        const auto start = std::chrono::steady_clock::now();
        processor->processBlock(buffer, midi);
        const auto finish = std::chrono::steady_clock::now();
        if (timed && timings != nullptr && checksum != nullptr) {
            timings->push_back(std::chrono::duration<double, std::micro>(finish - start).count());
            *checksum += static_cast<long double>(buffer.getSample(0, static_cast<int>(block_index % block_size)));
            *checksum += static_cast<long double>(buffer.getSample(1, static_cast<int>((block_index * 7U) % block_size)));
        }
    };

    for (std::size_t block = 0; block < warmup_blocks; ++block) process_one(block, false, nullptr, nullptr);
    std::vector<double> timings;
    timings.reserve(measured_blocks);
    long double checksum = 0.0;
    for (std::size_t block = 0; block < measured_blocks; ++block) {
        process_one(block, true, &timings, &checksum);
    }
    processor->releaseResources();
    std::sort(timings.begin(), timings.end());
    const double deadline_us = static_cast<double>(block_size) * 1.0e6 / static_cast<double>(sample_rate);
    BenchmarkResult result;
    result.id = "factory_" + std::to_string(program_index) + "_voices_" + std::to_string(voices);
    result.program_index = program_index;
    result.voices = voices;
    result.p50_us = percentile(timings, 0.50);
    result.p95_us = percentile(timings, 0.95);
    result.p99_us = percentile(timings, 0.99);
    result.maximum_us = timings.back();
    result.p99_deadline_fraction = result.p99_us / deadline_us;
    result.checksum = static_cast<double>(checksum);
    return result;
}

void write_benchmark(const std::filesystem::path& path, bool quick) {
    const std::array<std::uint32_t, 5> programs{0U, 12U, 22U, 25U, 27U};
    const std::array<std::size_t, 3> voice_counts{1U, 4U, 8U};
    const std::size_t warmup_blocks = quick ? 64U : 512U;
    const std::size_t measured_blocks = quick ? 256U : 4096U;
    std::vector<BenchmarkResult> results;
    for (const auto program : programs) {
        for (const auto voices : voice_counts) {
            auto result = benchmark_case(program, voices, warmup_blocks, measured_blocks);
            std::cout << result.id << ": p99_us=" << result.p99_us
                      << " deadline_fraction=" << result.p99_deadline_fraction << '\n';
            results.push_back(result);
        }
    }

    std::ofstream output(path);
    if (!output) throw std::runtime_error("cannot create upstream benchmark report");
    output << std::setprecision(12);
    output << "{\n";
    output << "  \"schema\": \"brk-modal-p45-benchmark-v1\",\n";
    output << "  \"engine\": \"ripplerx-1.5.18\",\n";
    output << "  \"mode\": \"" << (quick ? "ci-quick" : "target-full") << "\",\n";
    output << "  \"sampleRate\": 48000,\n";
    output << "  \"blockSize\": 128,\n";
    output << "  \"deadlineMicroseconds\": 2666.66666667,\n";
    output << "  \"cases\": [\n";
    for (std::size_t index = 0; index < results.size(); ++index) {
        const auto& result = results[index];
        output << "    {\n";
        output << "      \"id\": \"" << result.id << "\",\n";
        output << "      \"lane\": \"matched-factory\",\n";
        output << "      \"programIndex\": " << result.program_index << ",\n";
        output << "      \"voices\": " << result.voices << ",\n";
        output << "      \"p50Microseconds\": " << result.p50_us << ",\n";
        output << "      \"p95Microseconds\": " << result.p95_us << ",\n";
        output << "      \"p99Microseconds\": " << result.p99_us << ",\n";
        output << "      \"maxMicroseconds\": " << result.maximum_us << ",\n";
        output << "      \"p99DeadlineFraction\": " << result.p99_deadline_fraction << ",\n";
        output << "      \"checksum\": " << result.checksum << "\n";
        output << "    }" << (index + 1U == results.size() ? "\n" : ",\n");
    }
    output << "  ]\n";
    output << "}\n";
}

Arguments parse_arguments(int argc, char** argv) {
    Arguments result;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        const auto require_value = [&](const std::string& option) -> std::string {
            if (index + 1 >= argc) throw std::runtime_error("missing value for " + option);
            ++index;
            return argv[index];
        };
        if (argument == "--plan") result.plan = require_value(argument);
        else if (argument == "--output-dir") result.output_dir = require_value(argument);
        else if (argument == "--benchmark") result.benchmark = require_value(argument);
        else if (argument == "--ensemble-plan") result.ensemble_plan = require_value(argument);
        else if (argument == "--ensemble-output-dir") result.ensemble_output_dir = require_value(argument);
        else if (argument == "--quick") result.quick = true;
        else throw std::runtime_error("unknown argument: " + argument);
    }
    if (result.plan.empty() || result.output_dir.empty() || result.benchmark.empty()) {
        throw std::runtime_error(
            "usage: brk_ripplerx_headless --plan cases.csv --output-dir reference "
            "--benchmark report.json [--ensemble-plan cases.csv --ensemble-output-dir reference] [--quick]");
    }
    if (result.ensemble_plan.empty() != result.ensemble_output_dir.empty()) {
        throw std::runtime_error("--ensemble-plan and --ensemble-output-dir must be supplied together");
    }
    return result;
}

} // namespace

int main(int argc, char** argv) {
    try {
        const juce::ScopedJuceInitialiser_GUI juce_initialiser;
        const auto arguments = parse_arguments(argc, argv);
        std::filesystem::create_directories(arguments.output_dir);
        const auto cases = read_cases(arguments.plan);
        for (const auto& item : cases) render_case(item, arguments.output_dir);
        std::size_t ensemble_count = 0U;
        if (!arguments.ensemble_plan.empty()) {
            std::filesystem::create_directories(arguments.ensemble_output_dir);
            const auto ensemble_cases = read_ensemble_cases(arguments.ensemble_plan);
            for (const auto& item : ensemble_cases) render_case(item, arguments.ensemble_output_dir);
            ensemble_count = ensemble_cases.size();
        }
        write_benchmark(arguments.benchmark, arguments.quick);
        std::cout << "upstream_capture_count=" << cases.size() << '\n';
        std::cout << "p47a_upstream_capture_count=" << ensemble_count << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_ripplerx_headless: " << error.what() << '\n';
        return 1;
    }
}

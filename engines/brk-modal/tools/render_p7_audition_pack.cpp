#include "brk_modal/auto_quality.hpp"
#include "brk_modal/brk_modal.hpp"
#include "brk_modal/ripplerx_programs.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#ifndef BRK_MODAL_PROGRAM_BANK_INCLUDE
#error "BRK_MODAL_PROGRAM_BANK_INCLUDE must name the generated RipplerX bank .inc file"
#endif

namespace brk::modal {
#include BRK_MODAL_PROGRAM_BANK_INCLUDE
} // namespace brk::modal

namespace fs = std::filesystem;

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kBlock = 128U;
constexpr float kHeadroomPeak = 0.95F;

struct Audio {
    std::vector<float> left;
    std::vector<float> right;
    float peak = 0.0F;
    double rms = 0.0;
};

struct AuditionPreset {
    std::string id;
    std::string display_name;
    std::string origin;
    brk::modal::Patch patch;
};

void write_u16(std::ofstream& out, std::uint16_t value) {
    const std::array<char, 2> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
    };
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

void write_wav(const fs::path& path, const Audio& audio, float gain) {
    const auto frames = static_cast<std::uint32_t>(std::min(audio.left.size(), audio.right.size()));
    const std::uint32_t data_bytes = frames * 4U;
    std::ofstream out(path, std::ios::binary);
    if (!out) throw std::runtime_error("cannot open WAV output");
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
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        const auto encode = [gain](float sample) {
            const float scaled = std::clamp(sample * gain, -1.0F, 1.0F);
            return static_cast<std::int16_t>(std::lrint(scaled * 32767.0F));
        };
        write_u16(out, static_cast<std::uint16_t>(encode(audio.left[frame])));
        write_u16(out, static_cast<std::uint16_t>(encode(audio.right[frame])));
    }
}

Audio render_patch(const brk::modal::Patch& source, brk::modal::QualityProfile profile,
                   std::uint64_t seed) {
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlock, seed)) throw std::runtime_error("prepare failed");
    engine.set_modal_kernel(brk::modal::ModalKernel::Scalar);
    engine.set_tail_policy(brk::modal::TailPolicy::Disabled);
    engine.set_patch(brk::modal::apply_auto_quality_profile(source, profile));

    constexpr std::uint32_t total_frames = kSampleRate * 4U;
    Audio audio;
    audio.left.resize(total_frames);
    audio.right.resize(total_frames);
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};

    const std::array<std::uint32_t, 8> note_frames{
        0U, 12000U, 24000U, 36000U, 48000U, 60000U, 72000U, 84000U,
    };
    const std::array<std::int16_t, 8> keys{43, 50, 55, 59, 62, 67, 71, 74};
    const std::array<float, 8> velocities{0.58F, 0.72F, 0.86F, 0.66F, 0.92F, 0.76F, 0.64F, 0.82F};
    std::size_t next_note = 0U;
    std::uint32_t next_note_id = 1U;

    double sum_squares = 0.0;
    std::size_t sample_count = 0U;
    for (std::uint32_t offset = 0U; offset < total_frames; offset += kBlock) {
        while (next_note < note_frames.size() && note_frames[next_note] == offset) {
            engine.note_on({next_note_id, keys[next_note], velocities[next_note], 0.0F});
            if (next_note >= 3U) engine.note_off(next_note_id - 3U);
            ++next_note_id;
            ++next_note;
        }
        const std::uint32_t frames = std::min(kBlock, total_frames - offset);
        engine.process(left.data(), right.data(), frames);
        for (std::uint32_t frame = 0U; frame < frames; ++frame) {
            const float l = std::isfinite(left[frame]) ? left[frame] : 0.0F;
            const float r = std::isfinite(right[frame]) ? right[frame] : 0.0F;
            audio.left[offset + frame] = l;
            audio.right[offset + frame] = r;
            audio.peak = std::max(audio.peak, std::max(std::abs(l), std::abs(r)));
            sum_squares += static_cast<double>(l) * l + static_cast<double>(r) * r;
            sample_count += 2U;
        }
    }
    audio.rms = std::sqrt(sum_squares / static_cast<double>(std::max<std::size_t>(1U, sample_count)));
    return audio;
}

std::pair<double, float> difference(const Audio& reference, float reference_gain,
                                    const Audio& candidate, float candidate_gain) {
    const std::size_t frames = std::min(reference.left.size(), candidate.left.size());
    double sum_squares = 0.0;
    float maximum = 0.0F;
    std::size_t samples = 0U;
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const std::array<float, 2> errors{
            reference.left[frame] * reference_gain - candidate.left[frame] * candidate_gain,
            reference.right[frame] * reference_gain - candidate.right[frame] * candidate_gain,
        };
        for (const float error : errors) {
            maximum = std::max(maximum, std::abs(error));
            sum_squares += static_cast<double>(error) * error;
            ++samples;
        }
    }
    return {std::sqrt(sum_squares / static_cast<double>(std::max<std::size_t>(1U, samples))), maximum};
}

std::string json_escape(std::string_view input) {
    std::string output;
    for (const char c : input) {
        if (c == '"' || c == '\\') output.push_back('\\');
        output.push_back(c);
    }
    return output;
}

} // namespace

int main(int argc, char** argv) {
    const fs::path output = argc > 1 ? fs::path(argv[1]) : fs::path("p7-audition-pack");
    fs::create_directories(output);

    const std::array<AuditionPreset, 6> presets{{
        {"reference-marimba", "Reference / Marimba", "RipplerX 1.5.18", brk::modal::make_ripplerx_program(brk::modal::RipplerXProgram::Marimba)},
        {"reference-ride2", "Reference / Ride2", "RipplerX 1.5.18", brk::modal::make_ripplerx_program(brk::modal::RipplerXProgram::Ride2)},
        {"reference-crash", "Reference / Crash", "RipplerX 1.5.18", brk::modal::make_ripplerx_program(brk::modal::RipplerXProgram::Crash)},
        {"brk-glass-string", "BRK / Glass String", "Myldy design", brk::modal::make_factory_patch(brk::modal::FactoryPatch::GlassString)},
        {"brk-deep-membrane", "BRK / Deep Membrane", "Myldy design", brk::modal::make_factory_patch(brk::modal::FactoryPatch::DeepMembrane)},
        {"brk-ritual-bell", "BRK / Ritual Bell", "Myldy design", brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell)},
    }};
    const std::array<brk::modal::QualityProfile, 4> profiles{
        brk::modal::QualityProfile::Full,
        brk::modal::QualityProfile::Balanced,
        brk::modal::QualityProfile::Economy,
        brk::modal::QualityProfile::Draft,
    };

    std::ofstream report(output / "metrics.csv");
    report << "preset,origin,profile,work_units,modal_retention,raw_rms,raw_peak,level_gain_db,diff_rms_vs_full,diff_max_vs_full\n";

    std::ofstream manifest(output / "manifest.json");
    manifest << "{\n  \"schema\": \"brk-modal-p7-audition-v1\",\n"
             << "  \"sampleRate\": 48000,\n  \"levelMatched\": true,\n  \"presets\": [\n";

    for (std::size_t preset_index = 0U; preset_index < presets.size(); ++preset_index) {
        const auto& preset = presets[preset_index];
        std::array<Audio, 4> renders;
        std::array<float, 4> gains{};
        double target_rms = std::numeric_limits<double>::infinity();
        for (std::size_t profile_index = 0U; profile_index < profiles.size(); ++profile_index) {
            renders[profile_index] = render_patch(
                preset.patch, profiles[profile_index],
                0x5037415544494f00ULL + static_cast<std::uint64_t>(preset_index));
            if (renders[profile_index].rms > 1.0e-12) {
                target_rms = std::min(target_rms, renders[profile_index].rms);
            }
        }
        if (!std::isfinite(target_rms)) return 2;

        for (std::size_t profile_index = 0U; profile_index < profiles.size(); ++profile_index) {
            const auto& audio = renders[profile_index];
            float gain = audio.rms > 1.0e-12 ? static_cast<float>(target_rms / audio.rms) : 1.0F;
            if (audio.peak > 0.0F) gain = std::min(gain, kHeadroomPeak / audio.peak);
            gains[profile_index] = gain;
        }

        for (std::size_t profile_index = 0U; profile_index < profiles.size(); ++profile_index) {
            const auto profile = profiles[profile_index];
            std::string profile_name = brk::modal::quality_profile_name(profile);
            std::transform(profile_name.begin(), profile_name.end(), profile_name.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            const fs::path filename = preset.id + "__" + profile_name + ".wav";
            write_wav(output / filename, renders[profile_index], gains[profile_index]);
            const auto diff = difference(renders[0], gains[0], renders[profile_index], gains[profile_index]);
            const auto quality = brk::modal::describe_auto_quality_application(preset.patch, profile);
            const double gain_db = 20.0 * std::log10(std::max(1.0e-12F, gains[profile_index]));
            report << preset.id << ',' << preset.origin << ',' << profile_name << ','
                   << quality.applied_work_units << ',' << quality.modal_retention_ratio << ','
                   << renders[profile_index].rms << ',' << renders[profile_index].peak << ','
                   << gain_db << ',' << diff.first << ',' << diff.second << '\n';
        }

        manifest << "    {\"id\": \"" << json_escape(preset.id)
                 << "\", \"name\": \"" << json_escape(preset.display_name)
                 << "\", \"origin\": \"" << json_escape(preset.origin) << "\"}";
        manifest << (preset_index + 1U == presets.size() ? "\n" : ",\n");
    }
    manifest << "  ],\n  \"profiles\": [\"full\", \"balanced\", \"economy\", \"draft\"],\n"
             << "  \"note\": \"Each preset uses the same deterministic phrase; all four profiles are RMS level-matched downward before PCM16 export. Auto is adaptive and therefore documented separately rather than misrepresented as a fifth static render.\"\n}\n";

    std::ofstream readme(output / "README.txt");
    readme << "BRK Modal P7 audition pack\n\n"
           << "Listen within each preset group, not across different presets.\n"
           << "Files are deterministic 48 kHz / 16-bit stereo WAVs. Full, Balanced, Economy and Draft use the same phrase and seed.\n"
           << "All four versions are RMS level-matched DOWNWARD to the quietest render for that preset, with 0.95 peak headroom.\n"
           << "That removes loudness as much as practical from the quality judgement.\n\n"
           << "Suggested order: Full vs Balanced first; then Balanced vs Economy; Draft last.\n"
           << "Pay attention to metallic/inharmonic tails, stereo width, transient texture, and dense high partials.\n\n"
           << "Auto is not a fifth sound preset. It changes runtime profile from measured deadline headroom and currently operates within Full↔Balanced by default.\n"
           << "A static Auto WAV would therefore be misleading; use Full/Balanced as the audible endpoints of the default Auto policy.\n\n"
           << "metrics.csv reports estimated work units, modal retention and level-matched residual differences against Full.\n";

    std::cout << "p7_audition_presets=6\n";
    std::cout << "p7_audition_profiles=4\n";
    std::cout << "p7_audition_wavs=24\n";
    std::cout << "p7_audition_sample_rate=48000\n";
    std::cout << "p7_audition_level_match=rms-downward\n";
    return 0;
}

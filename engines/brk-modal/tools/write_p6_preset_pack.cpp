// Copyright © 2026 Myldy design / Ilya Tolstoukhov
// SPDX-License-Identifier: GPL-3.0-only

#include "brk_modal/brk_modal.hpp"
#include "brk_modal/ripplerx_programs.hpp"
#include "brk_modal/state_v1.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#ifndef BRK_MODAL_PROGRAM_BANK_INCLUDE
#error "BRK_MODAL_PROGRAM_BANK_INCLUDE must name the generated RipplerX bank .inc file"
#endif

// The 28-program Reference bank stays out of the production DSP library. P6
// compiles it only into this packaging tool from the pinned upstream source.
namespace brk::modal {
#include BRK_MODAL_PROGRAM_BANK_INCLUDE
} // namespace brk::modal

namespace fs = std::filesystem;
using brk::modal::CouplingProfile;
using brk::modal::FactoryPatch;
using brk::modal::Patch;
using brk::modal::RipplerXProgram;

namespace {

constexpr const char* kRipplerXUpstreamVersion = "1.5.18";

struct PresetRecord {
    std::string id;
    std::string name;
    std::string bank;
    std::string origin;
    std::string profile;
    std::string state_file;
    std::string source_name;
    std::string source_version;
};

std::string slugify(std::string_view text) {
    std::string result;
    bool dash = false;
    for (const unsigned char raw : text) {
        if (std::isalnum(raw) != 0) {
            if (dash && !result.empty()) result.push_back('-');
            result.push_back(static_cast<char>(std::tolower(raw)));
            dash = false;
        } else {
            dash = !result.empty();
        }
    }
    while (!result.empty() && result.back() == '-') result.pop_back();
    return result.empty() ? "preset" : result;
}

std::string json_escape(std::string_view text) {
    std::string result;
    result.reserve(text.size() + 8U);
    for (const char value : text) {
        switch (value) {
        case '\\': result += "\\\\"; break;
        case '"': result += "\\\""; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default: result.push_back(value); break;
        }
    }
    return result;
}

const char* profile_name(const Patch& patch) noexcept {
    switch (patch.coupling_profile) {
    case CouplingProfile::Stable: return "stable";
    case CouplingProfile::Reference: return "reference";
    case CouplingProfile::Wild: return "wild";
    }
    return "stable";
}

const char* bank_name(std::string_view profile) noexcept {
    if (profile == "reference") return "Reference";
    if (profile == "wild") return "Wild";
    return "Stable";
}

bool write_state(const fs::path& destination, const Patch& patch) {
    std::array<std::uint8_t, brk::modal::kStateV1Size> bytes{};
    if (!brk::modal::write_state_v1(patch, bytes.data(), bytes.size())) return false;

    Patch roundtrip{};
    if (brk::modal::read_state_v1(roundtrip, bytes.data(), bytes.size())
        != brk::modal::StateReadResult::Ok) return false;

    std::ofstream stream(destination, std::ios::binary | std::ios::trunc);
    if (!stream) return false;
    stream.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
    return stream.good();
}

void append_record(std::vector<PresetRecord>& records,
                   const fs::path& output_dir,
                   const std::string& id,
                   const std::string& name,
                   const std::string& origin,
                   const std::string& profile,
                   const std::string& source_name,
                   const std::string& source_version,
                   const Patch& patch) {
    const std::string state_file = id + ".brkstate";
    if (!write_state(output_dir / state_file, patch)) {
        throw std::runtime_error("failed to write preset state: " + state_file);
    }
    records.push_back({
        id,
        name,
        bank_name(profile),
        origin,
        profile,
        state_file,
        source_name,
        source_version,
    });
}

void write_index(const fs::path& destination, const std::vector<PresetRecord>& records) {
    std::ofstream stream(destination, std::ios::trunc);
    if (!stream) throw std::runtime_error("failed to open preset index");

    stream << "{\n"
           << "  \"schema\": \"brk-preset-index-v1\",\n"
           << "  \"moduleId\": \"design.myldy.brk-modal\",\n"
           << "  \"engineId\": \"brk-modal\",\n"
           << "  \"stateSchemaVersion\": 65536,\n"
           << "  \"stateBytes\": " << brk::modal::kStateV1Size << ",\n"
           << "  \"presetCount\": " << records.size() << ",\n"
           << "  \"presets\": [\n";

    for (std::size_t index = 0; index < records.size(); ++index) {
        const auto& record = records[index];
        stream << "    {\n"
               << "      \"id\": \"" << json_escape(record.id) << "\",\n"
               << "      \"name\": \"" << json_escape(record.name) << "\",\n"
               << "      \"bank\": \"" << json_escape(record.bank) << "\",\n"
               << "      \"origin\": \"" << json_escape(record.origin) << "\",\n"
               << "      \"profile\": \"" << json_escape(record.profile) << "\",\n"
               << "      \"readOnly\": true,\n"
               << "      \"stateFile\": \"" << json_escape(record.state_file) << "\",\n"
               << "      \"source\": {\n"
               << "        \"name\": \"" << json_escape(record.source_name) << "\",\n"
               << "        \"version\": \"" << json_escape(record.source_version) << "\"\n"
               << "      }\n"
               << "    }" << (index + 1U == records.size() ? "\n" : ",\n");
    }

    stream << "  ]\n"
           << "}\n";
    if (!stream.good()) throw std::runtime_error("failed to write preset index");
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: brk_modal_p6_preset_pack <output-directory>\n";
        return 2;
    }

    try {
        const fs::path output_dir = argv[1];
        std::error_code error;
        fs::remove_all(output_dir, error);
        error.clear();
        if (!fs::create_directories(output_dir, error) && error) {
            throw std::runtime_error("failed to create preset output directory");
        }

        std::vector<PresetRecord> records;
        records.reserve(brk::modal::kRipplerXProgramCount + 6U);

        for (std::size_t index = 0; index < brk::modal::kRipplerXProgramCount; ++index) {
            const auto program = static_cast<RipplerXProgram>(index);
            const char* raw_name = brk::modal::ripplerx_program_name(program);
            if (raw_name == nullptr || *raw_name == '\0') {
                throw std::runtime_error("RipplerX preset has no name");
            }
            const std::string name(raw_name);
            append_record(
                records,
                output_dir,
                "ripplerx-" + slugify(name),
                name,
                "upstream",
                "reference",
                "RipplerX",
                kRipplerXUpstreamVersion,
                brk::modal::make_ripplerx_program(program));
        }

        constexpr std::size_t kBrkFactoryCount = 6U;
        for (std::size_t index = 0; index < kBrkFactoryCount; ++index) {
            const auto factory = static_cast<FactoryPatch>(index);
            const char* raw_name = brk::modal::factory_patch_name(factory);
            if (raw_name == nullptr || *raw_name == '\0') {
                throw std::runtime_error("BRK preset has no name");
            }
            const Patch patch = brk::modal::make_factory_patch(factory);
            const std::string name(raw_name);
            const std::string profile(profile_name(patch));
            append_record(
                records,
                output_dir,
                "brk-" + slugify(name),
                name,
                "brk",
                profile,
                "BRK Modal",
                "1.1.0",
                patch);
        }

        if (records.size() != 34U) {
            throw std::runtime_error("P6 preset pack must contain exactly 34 presets");
        }

        std::size_t reference_count = 0U;
        std::size_t brk_count = 0U;
        for (const auto& record : records) {
            reference_count += record.origin == "upstream" ? 1U : 0U;
            brk_count += record.origin == "brk" ? 1U : 0U;
        }
        if (reference_count != 28U || brk_count != 6U) {
            throw std::runtime_error("unexpected P6 bank counts");
        }

        write_index(output_dir / "index.json", records);

        std::cout << "p6_preset_count=" << records.size() << "\n"
                  << "p6_reference_presets=" << reference_count << "\n"
                  << "p6_brk_presets=" << brk_count << "\n"
                  << "p6_preset_state_bytes=" << brk::modal::kStateV1Size << "\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "P6 preset pack failure: " << error.what() << "\n";
        return 1;
    }
}

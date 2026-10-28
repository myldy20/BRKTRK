#include "brk_synth_abi.h"
#include "brk_modal/parameter_ids.hpp"

#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>

namespace {

bool identities_are_unique() {
    for (std::size_t i = 0; i < brk::modal::kParameterCount; ++i) {
        const auto& a = brk::modal::kParameterIdentities[i];
        if (a.key == nullptr || a.key[0] == '\0') return false;
        for (std::size_t j = i + 1; j < brk::modal::kParameterCount; ++j) {
            const auto& b = brk::modal::kParameterIdentities[j];
            if (a.id == b.id || std::strcmp(a.key, b.key) == 0) return false;
        }
    }
    return true;
}

template <typename T>
void append(std::ofstream& output, const T& value) {
    output.write(reinterpret_cast<const char*>(&value), static_cast<std::streamsize>(sizeof(T)));
}

bool write_fixture(const std::string& path) {
    brk_note_event note{};
    note.header.size = static_cast<std::uint16_t>(sizeof(note));
    note.header.type = BRK_EVENT_NOTE_ON;
    note.header.frame_offset = 7U;
    note.header.flags = 0x01020304U;
    note.note_id = 0x11223344U;
    note.key = 60;
    note.channel = -1;
    note.velocity = 0.75F;
    note.tuning_semitones = -0.25F;

    brk_param_value_event parameter{};
    parameter.header.size = static_cast<std::uint16_t>(sizeof(parameter));
    parameter.header.type = BRK_EVENT_PARAM_VALUE;
    parameter.header.frame_offset = 11U;
    parameter.parameter_id = static_cast<std::uint32_t>(brk::modal::ParameterId::ADecaySeconds);
    parameter.normalized_value = 0.5F;
    parameter.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;

    brk_sustain_event sustain{};
    sustain.header.size = static_cast<std::uint16_t>(sizeof(sustain));
    sustain.header.type = BRK_EVENT_SUSTAIN;
    sustain.header.frame_offset = 13U;
    sustain.down = 1U;

    std::ofstream output(path, std::ios::binary);
    if (!output) return false;
    append(output, note);
    append(output, parameter);
    append(output, sustain);
    return output.good();
}

} // namespace

int main(int argc, char** argv) {
    static_assert(sizeof(brk_create_info) == 48U);
    static_assert(sizeof(brk_prepare_info) == 72U);
    static_assert(sizeof(brk_transport_context) == 64U);
    static_assert(sizeof(brk_process_info) == 64U);
    static_assert(sizeof(brk_state_blob_header_v1) == 56U);

    if (BRK_SYNTH_ABI_VERSION != 0x00010000U) return 1;
    if (brk::modal::kParameterCount != 89U) return 2;
    if (!identities_are_unique()) return 3;

    for (const auto& identity : brk::modal::kParameterIdentities) {
        brk::modal::ParameterId parsed{};
        if (!brk::modal::parameter_id_from_key(identity.key, parsed)) return 4;
        if (parsed != identity.id) return 5;
        const char* key = brk::modal::parameter_key(identity.id);
        if (key == nullptr || std::strcmp(key, identity.key) != 0) return 6;
    }

    if (argc > 1 && !write_fixture(argv[1])) return 7;

    std::cout << "abi_version=" << BRK_SYNTH_ABI_VERSION << '\n';
    std::cout << "parameter_count=" << brk::modal::kParameterCount << '\n';
    std::cout << "note_event_size=" << sizeof(brk_note_event) << '\n';
    std::cout << "state_header_size=" << sizeof(brk_state_blob_header_v1) << '\n';
    return 0;
}

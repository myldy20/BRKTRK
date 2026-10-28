#include "brk_modal_event_executor.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

namespace {

std::uint32_t xorshift32(std::uint32_t& state) noexcept {
    state ^= state << 13U;
    state ^= state >> 17U;
    state ^= state << 5U;
    return state;
}

template <typename T>
void append(std::vector<std::uint8_t>& bytes, const T& value) {
    const auto* source = reinterpret_cast<const std::uint8_t*>(&value);
    bytes.insert(bytes.end(), source, source + sizeof(T));
}

brk_event_header header(std::uint16_t type, std::uint16_t size, std::uint32_t frame) {
    brk_event_header result{};
    result.size = size;
    result.type = type;
    result.frame_offset = frame;
    return result;
}

std::vector<std::uint8_t> canonical_packet() {
    std::vector<std::uint8_t> bytes;

    brk_param_value_event gain{};
    gain.header = header(BRK_EVENT_PARAM_VALUE, sizeof(gain), 0U);
    gain.parameter_id = static_cast<std::uint32_t>(brk::modal::ParameterId::OutputGainDb);
    gain.normalized_value = 0.5F;
    gain.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    append(bytes, gain);

    brk_note_event on{};
    on.header = header(BRK_EVENT_NOTE_ON, sizeof(on), 0U);
    on.note_id = 1U;
    on.key = 60;
    on.channel = -1;
    on.velocity = 0.75F;
    append(bytes, on);

    brk_note_event off{};
    off.header = header(BRK_EVENT_NOTE_OFF, sizeof(off), 32U);
    off.note_id = 1U;
    off.channel = -1;
    append(bytes, off);

    return bytes;
}

bool finite_output(const std::array<float, 64>& left,
                   const std::array<float, 64>& right) {
    return std::all_of(left.begin(), left.end(), [](float value) { return std::isfinite(value); })
        && std::all_of(right.begin(), right.end(), [](float value) { return std::isfinite(value); });
}

} // namespace

int main() {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    const std::vector<std::uint8_t> seed_packet = canonical_packet();
    if (validate_packed_events(seed_packet.data(), static_cast<std::uint32_t>(seed_packet.size()),
                               3U, 64U) != BRK_OK) return 1;

    constexpr std::uint32_t kCases = 4096U;
    std::uint32_t rng = 0x50384146U;
    std::uint32_t accepted = 0U;
    std::uint32_t rejected = 0U;

    for (std::uint32_t case_index = 0U; case_index < kCases; ++case_index) {
        std::vector<std::uint8_t> bytes;
        if ((case_index & 1U) == 0U) {
            bytes = seed_packet;
            const std::uint32_t mutations = 1U + (xorshift32(rng) % 8U);
            for (std::uint32_t mutation = 0U; mutation < mutations && !bytes.empty(); ++mutation) {
                const std::size_t offset = xorshift32(rng) % bytes.size();
                bytes[offset] ^= static_cast<std::uint8_t>(1U << (xorshift32(rng) & 7U));
            }
        } else {
            const std::size_t size = xorshift32(rng) % 257U;
            bytes.resize(size);
            for (auto& byte : bytes) byte = static_cast<std::uint8_t>(xorshift32(rng));
        }

        std::uint32_t byte_size = static_cast<std::uint32_t>(bytes.size());
        if (!bytes.empty() && (xorshift32(rng) & 3U) == 0U) {
            byte_size = xorshift32(rng) % (byte_size + 1U);
        }
        const std::uint32_t event_count = xorshift32(rng) % 9U;
        const std::uint32_t frame_count = 1U + (xorshift32(rng) % 64U);
        const std::uint8_t* pointer = byte_size == 0U ? nullptr : bytes.data();

        const std::int32_t validation = validate_packed_events(
            pointer, byte_size, event_count, frame_count);
        if (validation != BRK_OK) {
            ++rejected;
            continue;
        }

        ++accepted;
        Engine engine;
        if (!engine.prepare(48000.0, 64U, 0x5038410000000000ULL + case_index)) return 2;
        std::array<float, 64> left{};
        std::array<float, 64> right{};
        const std::int32_t result = process_packed_events(
            engine, left.data(), right.data(), frame_count,
            pointer, byte_size, event_count);
        if (result != BRK_OK || !finite_output(left, right)) return 3;
    }

    // Dedicated edge cases for null/zero/truncated headers and absurd count.
    if (validate_packed_events(nullptr, 0U, 1U, 64U) == BRK_OK) return 4;
    const std::array<std::uint8_t, sizeof(brk_event_header) - 1U> short_header{};
    if (validate_packed_events(short_header.data(), static_cast<std::uint32_t>(short_header.size()),
                               1U, 64U) == BRK_OK) return 5;
    if (validate_packed_events(seed_packet.data(), static_cast<std::uint32_t>(seed_packet.size()),
                               0xffffffffU, 64U) == BRK_OK) return 6;

    std::cout << "p8a_event_fuzz_cases=" << kCases << '\n';
    std::cout << "p8a_event_fuzz_accepted=" << accepted << '\n';
    std::cout << "p8a_event_fuzz_rejected=" << rejected << '\n';
    return 0;
}

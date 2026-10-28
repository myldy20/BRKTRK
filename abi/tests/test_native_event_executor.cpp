#include "brk_modal_event_executor.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <vector>

namespace {

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

brk_note_event note(std::uint16_t type, std::uint32_t frame, std::uint32_t note_id,
                    std::int16_t key = 0, float velocity = 0.0F, float tuning = 0.0F) {
    brk_note_event result{};
    result.header = header(type, sizeof(result), frame);
    result.note_id = note_id;
    result.key = key;
    result.channel = -1;
    result.velocity = velocity;
    result.tuning_semitones = tuning;
    return result;
}

brk_param_value_event parameter(std::uint32_t frame, brk::modal::ParameterId id, float value) {
    brk_param_value_event result{};
    result.header = header(BRK_EVENT_PARAM_VALUE, sizeof(result), frame);
    result.parameter_id = static_cast<std::uint32_t>(id);
    result.normalized_value = value;
    result.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    return result;
}

brk_param_ramp_event ramp(std::uint32_t frame, brk::modal::ParameterId id,
                          float start, float end, std::uint32_t duration) {
    brk_param_ramp_event result{};
    result.header = header(BRK_EVENT_PARAM_RAMP, sizeof(result), frame);
    result.parameter_id = static_cast<std::uint32_t>(id);
    result.start_normalized = start;
    result.end_normalized = end;
    result.duration_frames = duration;
    result.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    return result;
}

brk_sustain_event sustain(std::uint32_t frame, bool down) {
    brk_sustain_event result{};
    result.header = header(BRK_EVENT_SUSTAIN, sizeof(result), frame);
    result.down = down ? 1U : 0U;
    return result;
}

bool buffers_equal(const std::array<float, 64>& a, const std::array<float, 64>& b) {
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (a[i] != b[i]) {
            std::cerr << "sample mismatch at " << i << ": " << a[i] << " vs " << b[i] << '\n';
            return false;
        }
    }
    return true;
}

void render_direct(brk::modal::Engine& engine, std::array<float, 64>& left,
                   std::array<float, 64>& right) {
    using namespace brk::modal;
    Patch patch = engine.patch();
    for (std::uint32_t frame = 0; frame < 64U; ++frame) {
        if (frame == 7U) engine.set_sustain(true);
        if (frame == 11U) engine.note_off(1U);
        if (frame == 25U) engine.set_sustain(false);
        if (frame == 31U) engine.choke(2U);
        if (frame == 37U) engine.all_notes_off();
        if (frame == 41U) engine.reset();

        bool patch_dirty = false;
        if (frame == 0U) {
            set_parameter_normalized(patch, ParameterId::ADecaySeconds, 0.4F);
            patch_dirty = true;
        }
        if (frame >= 13U && frame <= 21U) {
            const float proportion = static_cast<float>(frame - 13U) / 8.0F;
            set_parameter_normalized(patch, ParameterId::OutputGainDb, 0.2F + 0.6F * proportion);
            patch_dirty = true;
        }
        if (patch_dirty) engine.set_patch(patch);

        if (frame == 0U) engine.note_on({1U, 52, 0.72F, 0.0F});
        if (frame == 21U) engine.note_on({2U, 59, 0.61F, 0.125F});
        if (frame == 47U) engine.note_on({3U, 64, 0.83F, -0.25F});
        engine.process(left.data() + frame, right.data() + frame, 1U);
    }
}

} // namespace

int main() {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    std::vector<std::uint8_t> events;
    append(events, parameter(0U, ParameterId::ADecaySeconds, 0.4F));
    append(events, note(BRK_EVENT_NOTE_ON, 0U, 1U, 52, 0.72F, 0.0F));
    append(events, sustain(7U, true));
    append(events, note(BRK_EVENT_NOTE_OFF, 11U, 1U));
    append(events, ramp(13U, ParameterId::OutputGainDb, 0.2F, 0.8F, 9U));
    append(events, note(BRK_EVENT_NOTE_ON, 21U, 2U, 59, 0.61F, 0.125F));
    append(events, sustain(25U, false));
    append(events, note(BRK_EVENT_NOTE_CHOKE, 31U, 2U));
    append(events, header(BRK_EVENT_ALL_NOTES_OFF, sizeof(brk_event_header), 37U));
    append(events, header(BRK_EVENT_RESET, sizeof(brk_event_header), 41U));
    append(events, note(BRK_EVENT_RETRIGGER, 47U, 3U, 64, 0.83F, -0.25F));

    if (validate_packed_events(events.data(), static_cast<std::uint32_t>(events.size()), 11U, 64U) != BRK_OK) return 1;

    Engine packed;
    Engine direct;
    constexpr std::uint64_t seed = 0x5033444556454e54ULL;
    if (!packed.prepare(48000.0, 64U, seed) || !direct.prepare(48000.0, 64U, seed)) return 2;
    const auto initial = make_factory_patch(FactoryPatch::RitualBell);
    packed.set_patch(initial);
    direct.set_patch(initial);

    std::array<float, 64> packed_left{};
    std::array<float, 64> packed_right{};
    std::array<float, 64> direct_left{};
    std::array<float, 64> direct_right{};
    const auto result = process_packed_events(
        packed, packed_left.data(), packed_right.data(), 64U,
        events.data(), static_cast<std::uint32_t>(events.size()), 11U);
    if (result != BRK_OK) return 3;
    render_direct(direct, direct_left, direct_right);
    if (!buffers_equal(packed_left, direct_left) || !buffers_equal(packed_right, direct_right)) return 4;

    float packed_gain = 0.0F;
    float direct_gain = 0.0F;
    if (!get_parameter_normalized(packed.patch(), ParameterId::OutputGainDb, packed_gain)
        || !get_parameter_normalized(direct.patch(), ParameterId::OutputGainDb, direct_gain)
        || std::abs(packed_gain - 0.8F) > 1.0e-5F || packed_gain != direct_gain) return 5;

    // A one-frame block is valid and writes a complete finite sample.
    Engine one_frame;
    if (!one_frame.prepare(48000.0, 1U, seed)) return 6;
    std::array<float, 1> one_left{123.0F};
    std::array<float, 1> one_right{123.0F};
    if (process_packed_events(one_frame, one_left.data(), one_right.data(), 1U, nullptr, 0U, 0U) != BRK_OK
        || !std::isfinite(one_left[0]) || !std::isfinite(one_right[0])) return 7;

    // Same-sample events must follow the canonical priority order: parameter before note-on.
    std::vector<std::uint8_t> unsorted;
    append(unsorted, note(BRK_EVENT_NOTE_ON, 0U, 8U, 60, 0.5F));
    append(unsorted, parameter(0U, ParameterId::ADecaySeconds, 0.5F));
    if (validate_packed_events(unsorted.data(), static_cast<std::uint32_t>(unsorted.size()), 2U, 8U)
        != BRK_ERROR_BAD_EVENT) return 8;

    // Overlapping automation for one parameter is deliberately rejected.
    std::vector<std::uint8_t> overlap;
    append(overlap, ramp(1U, ParameterId::StereoWidth, 0.0F, 1.0F, 6U));
    append(overlap, ramp(4U, ParameterId::StereoWidth, 1.0F, 0.0F, 4U));
    if (validate_packed_events(overlap.data(), static_cast<std::uint32_t>(overlap.size()), 2U, 8U)
        != BRK_ERROR_BAD_EVENT) return 9;

    std::vector<std::uint8_t> value_inside_ramp;
    append(value_inside_ramp, ramp(1U, ParameterId::StereoWidth, 0.0F, 1.0F, 6U));
    append(value_inside_ramp, parameter(4U, ParameterId::StereoWidth, 0.5F));
    if (validate_packed_events(value_inside_ramp.data(), static_cast<std::uint32_t>(value_inside_ramp.size()), 2U, 8U)
        != BRK_ERROR_BAD_EVENT) return 10;

    // Validation failure must not mutate voices, patch or output buffers.
    Engine protected_engine;
    if (!protected_engine.prepare(48000.0, 16U, seed)) return 11;
    protected_engine.set_patch(initial);
    protected_engine.note_on({99U, 48, 0.7F, 0.0F});
    const auto voices_before = protected_engine.active_voice_count();
    const auto patch_before = protected_engine.patch();
    std::array<float, 16> protected_left{};
    std::array<float, 16> protected_right{};
    protected_left.fill(42.0F);
    protected_right.fill(-42.0F);
    auto malformed = note(BRK_EVENT_NOTE_ON, 0U, 100U, 60, 0.5F);
    malformed.header.size = 13U;
    const auto bad_result = process_packed_events(
        protected_engine, protected_left.data(), protected_right.data(), 16U,
        reinterpret_cast<const std::uint8_t*>(&malformed), sizeof(malformed), 1U);
    if (bad_result != BRK_ERROR_BAD_EVENT || protected_engine.active_voice_count() != voices_before) return 12;
    float before = 0.0F;
    float after = 0.0F;
    if (!get_parameter_normalized(patch_before, ParameterId::ADecaySeconds, before)
        || !get_parameter_normalized(protected_engine.patch(), ParameterId::ADecaySeconds, after)
        || before != after) return 13;
    if (!std::all_of(protected_left.begin(), protected_left.end(), [](float value) { return value == 42.0F; })
        || !std::all_of(protected_right.begin(), protected_right.end(), [](float value) { return value == -42.0F; })) return 14;

    // Count/size mismatch and non-finite parameters are rejected before execution.
    if (validate_packed_events(events.data(), static_cast<std::uint32_t>(events.size()), 10U, 64U)
        != BRK_ERROR_BAD_SIZE) return 15;
    auto nan_parameter = parameter(0U, ParameterId::ADecaySeconds,
                                   std::numeric_limits<float>::quiet_NaN());
    if (validate_packed_events(reinterpret_cast<const std::uint8_t*>(&nan_parameter),
                               sizeof(nan_parameter), 1U, 8U) != BRK_ERROR_BAD_PARAMETER) return 16;

    std::cout << "packed_event_bytes=" << events.size() << '\n';
    std::cout << "packed_event_count=11\n";
    std::cout << "direct_packed_samples=128\n";
    std::cout << "sample_accurate_ramp_frames=9\n";
    std::cout << "malformed_rejection_cases=5\n";
    return 0;
}

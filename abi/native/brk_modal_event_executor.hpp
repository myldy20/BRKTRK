#pragma once

#include "brk_synth_abi.h"
#include "brk_modal/parameter_descriptors.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace brk::modal::abi {

inline constexpr std::size_t kMaxActiveRamps = 64U;

enum class EventPriority : std::uint8_t {
    Reset = 0,
    AllNotesOff = 1,
    Choke = 2,
    NoteOff = 3,
    Sustain = 4,
    ParameterValue = 5,
    ParameterRamp = 6,
    NoteOn = 7,
    Retrigger = 8,
};

namespace event_detail {

template <typename T>
inline T load(const std::uint8_t* bytes) noexcept {
    T value{};
    std::memcpy(&value, bytes, sizeof(T));
    return value;
}

inline EventPriority priority(std::uint16_t type) noexcept {
    switch (type) {
    case BRK_EVENT_RESET: return EventPriority::Reset;
    case BRK_EVENT_ALL_NOTES_OFF: return EventPriority::AllNotesOff;
    case BRK_EVENT_NOTE_CHOKE: return EventPriority::Choke;
    case BRK_EVENT_NOTE_OFF: return EventPriority::NoteOff;
    case BRK_EVENT_SUSTAIN: return EventPriority::Sustain;
    case BRK_EVENT_PARAM_VALUE: return EventPriority::ParameterValue;
    case BRK_EVENT_PARAM_RAMP: return EventPriority::ParameterRamp;
    case BRK_EVENT_NOTE_ON: return EventPriority::NoteOn;
    case BRK_EVENT_RETRIGGER: return EventPriority::Retrigger;
    default: return static_cast<EventPriority>(255U);
    }
}

inline std::uint16_t expected_size(std::uint16_t type) noexcept {
    switch (type) {
    case BRK_EVENT_NOTE_ON:
    case BRK_EVENT_NOTE_OFF:
    case BRK_EVENT_NOTE_CHOKE:
    case BRK_EVENT_RETRIGGER:
        return static_cast<std::uint16_t>(sizeof(brk_note_event));
    case BRK_EVENT_PARAM_VALUE:
        return static_cast<std::uint16_t>(sizeof(brk_param_value_event));
    case BRK_EVENT_PARAM_RAMP:
        return static_cast<std::uint16_t>(sizeof(brk_param_ramp_event));
    case BRK_EVENT_SUSTAIN:
        return static_cast<std::uint16_t>(sizeof(brk_sustain_event));
    case BRK_EVENT_ALL_NOTES_OFF:
    case BRK_EVENT_RESET:
        return static_cast<std::uint16_t>(sizeof(brk_event_header));
    default:
        return 0U;
    }
}

struct EventView {
    const std::uint8_t* bytes = nullptr;
    brk_event_header header{};
};

inline bool read_event(const std::uint8_t* bytes, std::size_t byte_size, std::size_t offset,
                       EventView& event) noexcept {
    if (bytes == nullptr || offset > byte_size || byte_size - offset < sizeof(brk_event_header)) return false;
    event.bytes = bytes + offset;
    event.header = load<brk_event_header>(event.bytes);
    return event.header.size >= sizeof(brk_event_header)
        && static_cast<std::size_t>(event.header.size) <= byte_size - offset;
}

inline bool normalized(float value) noexcept {
    return std::isfinite(value) && value >= 0.0F && value <= 1.0F;
}

inline bool ranges_overlap(std::uint32_t first_start, std::uint32_t first_duration,
                           std::uint32_t second_start, std::uint32_t second_duration) noexcept {
    const std::uint64_t first_end = static_cast<std::uint64_t>(first_start) + first_duration;
    const std::uint64_t second_end = static_cast<std::uint64_t>(second_start) + second_duration;
    return static_cast<std::uint64_t>(first_start) < second_end
        && static_cast<std::uint64_t>(second_start) < first_end;
}

struct RampState {
    ParameterId id{};
    float start = 0.0F;
    float end = 0.0F;
    std::uint32_t duration = 0U;
    std::uint32_t position = 0U;
    bool active = false;

    float value() const noexcept {
        if (duration <= 1U) return end;
        const float proportion = static_cast<float>(position) / static_cast<float>(duration - 1U);
        return start + (end - start) * proportion;
    }
};

inline bool is_early_lifecycle(EventPriority value) noexcept {
    return value <= EventPriority::Sustain;
}

inline bool is_parameter(EventPriority value) noexcept {
    return value == EventPriority::ParameterValue || value == EventPriority::ParameterRamp;
}

} // namespace event_detail

inline std::int32_t validate_packed_events(const std::uint8_t* event_bytes,
                                           std::uint32_t event_bytes_size,
                                           std::uint32_t event_count,
                                           std::uint32_t frame_count) noexcept {
    if (frame_count == 0U) return BRK_ERROR_INVALID_ARGUMENT;
    if (event_count == 0U) return event_bytes_size == 0U ? BRK_OK : BRK_ERROR_BAD_SIZE;
    if (event_bytes == nullptr || event_bytes_size == 0U) return BRK_ERROR_INVALID_ARGUMENT;

    std::size_t offset = 0U;
    std::uint32_t previous_frame = 0U;
    EventPriority previous_priority = EventPriority::Reset;
    bool first = true;
    std::size_t ramp_count = 0U;

    for (std::uint32_t index = 0U; index < event_count; ++index) {
        event_detail::EventView event{};
        if (!event_detail::read_event(event_bytes, event_bytes_size, offset, event)) return BRK_ERROR_BAD_SIZE;
        const auto expected = event_detail::expected_size(event.header.type);
        const auto current_priority = event_detail::priority(event.header.type);
        if (expected == 0U || event.header.size != expected) return BRK_ERROR_BAD_EVENT;
        if (event.header.flags != 0U || event.header.frame_offset >= frame_count) return BRK_ERROR_BAD_EVENT;
        if (!first && (event.header.frame_offset < previous_frame
            || (event.header.frame_offset == previous_frame && current_priority < previous_priority))) {
            return BRK_ERROR_BAD_EVENT;
        }
        first = false;
        previous_frame = event.header.frame_offset;
        previous_priority = current_priority;

        switch (event.header.type) {
        case BRK_EVENT_NOTE_ON:
        case BRK_EVENT_RETRIGGER: {
            const auto note = event_detail::load<brk_note_event>(event.bytes);
            if (note.note_id == BRK_SYNTH_GLOBAL_NOTE_ID || note.key < 0 || note.key > 127
                || !event_detail::normalized(note.velocity) || !std::isfinite(note.tuning_semitones)) {
                return BRK_ERROR_BAD_EVENT;
            }
            break;
        }
        case BRK_EVENT_NOTE_OFF:
        case BRK_EVENT_NOTE_CHOKE: {
            const auto note = event_detail::load<brk_note_event>(event.bytes);
            if (note.note_id == BRK_SYNTH_GLOBAL_NOTE_ID) return BRK_ERROR_BAD_EVENT;
            break;
        }
        case BRK_EVENT_PARAM_VALUE: {
            const auto parameter = event_detail::load<brk_param_value_event>(event.bytes);
            if (parameter.note_id != BRK_SYNTH_GLOBAL_NOTE_ID
                || parameter_descriptor(static_cast<ParameterId>(parameter.parameter_id)) == nullptr
                || !event_detail::normalized(parameter.normalized_value)) return BRK_ERROR_BAD_PARAMETER;
            break;
        }
        case BRK_EVENT_PARAM_RAMP: {
            const auto ramp = event_detail::load<brk_param_ramp_event>(event.bytes);
            if (ramp.note_id != BRK_SYNTH_GLOBAL_NOTE_ID
                || parameter_descriptor(static_cast<ParameterId>(ramp.parameter_id)) == nullptr
                || !event_detail::normalized(ramp.start_normalized)
                || !event_detail::normalized(ramp.end_normalized)
                || ramp.duration_frames == 0U
                || static_cast<std::uint64_t>(ramp.header.frame_offset) + ramp.duration_frames > frame_count) {
                return BRK_ERROR_BAD_PARAMETER;
            }
            if (++ramp_count > kMaxActiveRamps) return BRK_ERROR_BAD_EVENT;
            break;
        }
        case BRK_EVENT_SUSTAIN: {
            const auto sustain = event_detail::load<brk_sustain_event>(event.bytes);
            if (sustain.down > 1U || sustain.reserved0 != 0U) return BRK_ERROR_BAD_EVENT;
            break;
        }
        case BRK_EVENT_ALL_NOTES_OFF:
        case BRK_EVENT_RESET:
            break;
        default:
            return BRK_ERROR_BAD_EVENT;
        }
        offset += event.header.size;
    }
    if (offset != event_bytes_size) return BRK_ERROR_BAD_SIZE;

    // Reject ambiguous automation: ramps may not overlap each other or Parameter Value events
    // for the same permanent parameter ID.
    std::size_t first_offset = 0U;
    for (std::uint32_t first_index = 0U; first_index < event_count; ++first_index) {
        event_detail::EventView first_event{};
        if (!event_detail::read_event(event_bytes, event_bytes_size, first_offset, first_event)) return BRK_ERROR_BAD_SIZE;
        if (first_event.header.type == BRK_EVENT_PARAM_RAMP) {
            const auto first_ramp = event_detail::load<brk_param_ramp_event>(first_event.bytes);
            std::size_t second_offset = first_offset + first_event.header.size;
            for (std::uint32_t second_index = first_index + 1U; second_index < event_count; ++second_index) {
                event_detail::EventView second_event{};
                if (!event_detail::read_event(event_bytes, event_bytes_size, second_offset, second_event)) return BRK_ERROR_BAD_SIZE;
                if (second_event.header.type == BRK_EVENT_PARAM_RAMP) {
                    const auto second_ramp = event_detail::load<brk_param_ramp_event>(second_event.bytes);
                    if (first_ramp.parameter_id == second_ramp.parameter_id
                        && event_detail::ranges_overlap(first_ramp.header.frame_offset, first_ramp.duration_frames,
                                                        second_ramp.header.frame_offset, second_ramp.duration_frames)) {
                        return BRK_ERROR_BAD_EVENT;
                    }
                } else if (second_event.header.type == BRK_EVENT_PARAM_VALUE) {
                    const auto value = event_detail::load<brk_param_value_event>(second_event.bytes);
                    if (first_ramp.parameter_id == value.parameter_id
                        && value.header.frame_offset >= first_ramp.header.frame_offset
                        && static_cast<std::uint64_t>(value.header.frame_offset)
                            < static_cast<std::uint64_t>(first_ramp.header.frame_offset) + first_ramp.duration_frames) {
                        return BRK_ERROR_BAD_EVENT;
                    }
                }
                second_offset += second_event.header.size;
            }
        }
        first_offset += first_event.header.size;
    }
    return BRK_OK;
}

inline std::int32_t process_packed_events(Engine& engine,
                                          float* output_left,
                                          float* output_right,
                                          std::uint32_t frame_count,
                                          const std::uint8_t* event_bytes,
                                          std::uint32_t event_bytes_size,
                                          std::uint32_t event_count) noexcept {
    if (output_left == nullptr || output_right == nullptr || frame_count == 0U
        || frame_count > engine.max_block_frames()) return BRK_ERROR_INVALID_ARGUMENT;
    const auto validation = validate_packed_events(event_bytes, event_bytes_size, event_count, frame_count);
    if (validation != BRK_OK) return validation;

    std::array<event_detail::RampState, kMaxActiveRamps> ramps{};
    std::size_t event_offset = 0U;
    std::uint32_t event_index = 0U;
    Patch working_patch = engine.patch();

    for (std::uint32_t frame = 0U; frame < frame_count; ++frame) {
        // Early lifecycle operations happen before parameter automation at the same sample.
        while (event_index < event_count) {
            event_detail::EventView event{};
            if (!event_detail::read_event(event_bytes, event_bytes_size, event_offset, event)) return BRK_ERROR_INTERNAL;
            const auto current_priority = event_detail::priority(event.header.type);
            if (event.header.frame_offset != frame || !event_detail::is_early_lifecycle(current_priority)) break;
            switch (event.header.type) {
            case BRK_EVENT_RESET:
                engine.reset();
                break;
            case BRK_EVENT_ALL_NOTES_OFF:
                engine.all_notes_off();
                break;
            case BRK_EVENT_NOTE_CHOKE: {
                const auto note = event_detail::load<brk_note_event>(event.bytes);
                engine.choke(note.note_id);
                break;
            }
            case BRK_EVENT_NOTE_OFF: {
                const auto note = event_detail::load<brk_note_event>(event.bytes);
                engine.note_off(note.note_id);
                break;
            }
            case BRK_EVENT_SUSTAIN: {
                const auto sustain = event_detail::load<brk_sustain_event>(event.bytes);
                engine.set_sustain(sustain.down != 0U);
                break;
            }
            default:
                return BRK_ERROR_INTERNAL;
            }
            event_offset += event.header.size;
            ++event_index;
        }

        bool patch_dirty = false;
        for (auto& ramp : ramps) {
            if (!ramp.active) continue;
            if (!set_parameter_normalized(working_patch, ramp.id, ramp.value())) return BRK_ERROR_INTERNAL;
            patch_dirty = true;
        }

        while (event_index < event_count) {
            event_detail::EventView event{};
            if (!event_detail::read_event(event_bytes, event_bytes_size, event_offset, event)) return BRK_ERROR_INTERNAL;
            const auto current_priority = event_detail::priority(event.header.type);
            if (event.header.frame_offset != frame || !event_detail::is_parameter(current_priority)) break;
            if (event.header.type == BRK_EVENT_PARAM_VALUE) {
                const auto parameter = event_detail::load<brk_param_value_event>(event.bytes);
                if (!set_parameter_normalized(
                        working_patch, static_cast<ParameterId>(parameter.parameter_id), parameter.normalized_value)) {
                    return BRK_ERROR_INTERNAL;
                }
                patch_dirty = true;
            } else {
                const auto source = event_detail::load<brk_param_ramp_event>(event.bytes);
                auto* slot = static_cast<event_detail::RampState*>(nullptr);
                for (auto& ramp : ramps) {
                    if (!ramp.active) {
                        slot = &ramp;
                        break;
                    }
                }
                if (slot == nullptr) return BRK_ERROR_INTERNAL;
                *slot = {static_cast<ParameterId>(source.parameter_id), source.start_normalized,
                         source.end_normalized, source.duration_frames, 0U, true};
                if (!set_parameter_normalized(working_patch, slot->id, slot->value())) return BRK_ERROR_INTERNAL;
                patch_dirty = true;
            }
            event_offset += event.header.size;
            ++event_index;
        }

        if (patch_dirty) engine.set_patch(working_patch);

        while (event_index < event_count) {
            event_detail::EventView event{};
            if (!event_detail::read_event(event_bytes, event_bytes_size, event_offset, event)) return BRK_ERROR_INTERNAL;
            if (event.header.frame_offset != frame) break;
            if (event.header.type != BRK_EVENT_NOTE_ON && event.header.type != BRK_EVENT_RETRIGGER) {
                return BRK_ERROR_INTERNAL;
            }
            const auto note = event_detail::load<brk_note_event>(event.bytes);
            engine.note_on({note.note_id, note.key, note.velocity, note.tuning_semitones});
            event_offset += event.header.size;
            ++event_index;
        }

        engine.process(output_left + frame, output_right + frame, 1U);

        for (auto& ramp : ramps) {
            if (!ramp.active) continue;
            ++ramp.position;
            if (ramp.position >= ramp.duration) ramp.active = false;
        }
    }

    return event_index == event_count && event_offset == event_bytes_size ? BRK_OK : BRK_ERROR_INTERNAL;
}

} // namespace brk::modal::abi

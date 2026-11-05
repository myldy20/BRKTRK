#pragma once

#include "brk_synth_abi.h"
#include "brk_bogie/bogie_engine.hpp"
#include "brk_bogie/parameter_registry.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace brk::bogie::abi {

inline constexpr std::size_t kMaxPersistentRamps = kParameterCount;

enum class EventPriority : std::uint8_t {
  Reset = 0,
  AllNotesOff,
  Choke,
  NoteOff,
  Sustain,
  ParameterValue,
  ParameterRamp,
  NoteOn,
  Retrigger,
};

namespace detail {

template <class T>
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
    case BRK_EVENT_RETRIGGER: return static_cast<std::uint16_t>(sizeof(brk_note_event));
    case BRK_EVENT_PARAM_VALUE: return static_cast<std::uint16_t>(sizeof(brk_param_value_event));
    case BRK_EVENT_PARAM_RAMP: return static_cast<std::uint16_t>(sizeof(brk_param_ramp_event));
    case BRK_EVENT_SUSTAIN: return static_cast<std::uint16_t>(sizeof(brk_sustain_event));
    case BRK_EVENT_ALL_NOTES_OFF:
    case BRK_EVENT_RESET: return static_cast<std::uint16_t>(sizeof(brk_event_header));
    default: return 0U;
  }
}

struct EventView {
  const std::uint8_t* bytes = nullptr;
  brk_event_header header{};
};

inline bool read(
    const std::uint8_t* bytes, std::size_t byte_size,
    std::size_t offset, EventView& view) noexcept {
  if (bytes == nullptr || offset > byte_size
      || byte_size - offset < sizeof(brk_event_header)) return false;
  view.bytes = bytes + offset;
  view.header = load<brk_event_header>(view.bytes);
  return view.header.size >= sizeof(brk_event_header)
      && static_cast<std::size_t>(view.header.size) <= byte_size - offset;
}

inline bool normalized(float value) noexcept {
  return std::isfinite(value) && value >= 0.0F && value <= 1.0F;
}

inline std::size_t descriptor_index(ParamId id) noexcept {
  for (std::size_t i = 0; i < kParameterCount; ++i) {
    if (kParameterDescriptors[i].id == id) return i;
  }
  return kParameterCount;
}

inline bool ranges_overlap(
    std::uint32_t a_start, std::uint32_t a_duration,
    std::uint32_t b_start, std::uint32_t b_duration) noexcept {
  const std::uint64_t a_end = static_cast<std::uint64_t>(a_start) + a_duration;
  const std::uint64_t b_end = static_cast<std::uint64_t>(b_start) + b_duration;
  return static_cast<std::uint64_t>(a_start) < b_end
      && static_cast<std::uint64_t>(b_start) < a_end;
}

}  // namespace detail

class PersistentEventExecutor {
 public:
  void clear() noexcept {
    for (auto& ramp : ramps_) ramp = {};
  }

  [[nodiscard]] std::size_t active_ramp_count() const noexcept {
    std::size_t count = 0U;
    for (const auto& ramp : ramps_) count += ramp.active ? 1U : 0U;
    return count;
  }

  std::int32_t validate(
      const std::uint8_t* bytes, std::uint32_t byte_size,
      std::uint32_t count, std::uint32_t frames) const noexcept {
    if (frames == 0U) return BRK_ERROR_INVALID_ARGUMENT;
    if (count == 0U) return byte_size == 0U ? BRK_OK : BRK_ERROR_BAD_SIZE;
    if (bytes == nullptr || byte_size == 0U) return BRK_ERROR_INVALID_ARGUMENT;

    std::size_t offset = 0U;
    std::uint32_t previous_frame = 0U;
    EventPriority previous_priority = EventPriority::Reset;
    bool first = true;
    std::size_t new_ramps = 0U;

    for (std::uint32_t i = 0; i < count; ++i) {
      detail::EventView event{};
      if (!detail::read(bytes, byte_size, offset, event)) return BRK_ERROR_BAD_SIZE;
      const auto expected = detail::expected_size(event.header.type);
      const auto current_priority = detail::priority(event.header.type);
      if (expected == 0U || event.header.size != expected) return BRK_ERROR_BAD_EVENT;
      if (event.header.flags != 0U || event.header.frame_offset >= frames) {
        return BRK_ERROR_BAD_EVENT;
      }
      if (!first && (event.header.frame_offset < previous_frame
          || (event.header.frame_offset == previous_frame
              && current_priority < previous_priority))) return BRK_ERROR_BAD_EVENT;
      first = false;
      previous_frame = event.header.frame_offset;
      previous_priority = current_priority;

      switch (event.header.type) {
        case BRK_EVENT_NOTE_ON: {
          const auto note = detail::load<brk_note_event>(event.bytes);
          if (note.note_id == BRK_SYNTH_GLOBAL_NOTE_ID
              || note.key < 0 || note.key > 127
              || !detail::normalized(note.velocity)
              || !std::isfinite(note.tuning_semitones)) return BRK_ERROR_BAD_EVENT;
          break;
        }
        case BRK_EVENT_RETRIGGER:
        case BRK_EVENT_NOTE_OFF:
        case BRK_EVENT_NOTE_CHOKE: {
          const auto note = detail::load<brk_note_event>(event.bytes);
          if (note.note_id == BRK_SYNTH_GLOBAL_NOTE_ID) return BRK_ERROR_BAD_EVENT;
          break;
        }
        case BRK_EVENT_PARAM_VALUE: {
          const auto value = detail::load<brk_param_value_event>(event.bytes);
          const auto id = static_cast<ParamId>(value.parameter_id);
          if (value.note_id != BRK_SYNTH_GLOBAL_NOTE_ID
              || detail::descriptor_index(id) == kParameterCount
              || !detail::normalized(value.normalized_value)) return BRK_ERROR_BAD_PARAMETER;
          for (const auto& active : ramps_) {
            if (active.active && active.id == id
                && event.header.frame_offset < active.remaining()) return BRK_ERROR_BAD_EVENT;
          }
          break;
        }
        case BRK_EVENT_PARAM_RAMP: {
          const auto ramp = detail::load<brk_param_ramp_event>(event.bytes);
          const auto id = static_cast<ParamId>(ramp.parameter_id);
          if (ramp.note_id != BRK_SYNTH_GLOBAL_NOTE_ID
              || detail::descriptor_index(id) == kParameterCount
              || !detail::normalized(ramp.start_normalized)
              || !detail::normalized(ramp.end_normalized)
              || ramp.duration_frames == 0U) return BRK_ERROR_BAD_PARAMETER;
          for (const auto& active : ramps_) {
            if (active.active && active.id == id
                && event.header.frame_offset < active.remaining()) return BRK_ERROR_BAD_EVENT;
          }
          if (active_ramp_count() + ++new_ramps > kMaxPersistentRamps) return BRK_ERROR_BAD_EVENT;
          break;
        }
        case BRK_EVENT_SUSTAIN:
          return BRK_ERROR_UNSUPPORTED;
        case BRK_EVENT_ALL_NOTES_OFF:
        case BRK_EVENT_RESET:
          break;
        default:
          return BRK_ERROR_BAD_EVENT;
      }
      offset += event.header.size;
    }
    if (offset != byte_size) return BRK_ERROR_BAD_SIZE;

    std::size_t first_offset = 0U;
    for (std::uint32_t i = 0; i < count; ++i) {
      detail::EventView first_event{};
      if (!detail::read(bytes, byte_size, first_offset, first_event)) return BRK_ERROR_BAD_SIZE;
      if (first_event.header.type == BRK_EVENT_PARAM_RAMP) {
        const auto first_ramp = detail::load<brk_param_ramp_event>(first_event.bytes);
        std::size_t second_offset = first_offset + first_event.header.size;
        for (std::uint32_t j = i + 1U; j < count; ++j) {
          detail::EventView second_event{};
          if (!detail::read(bytes, byte_size, second_offset, second_event)) return BRK_ERROR_BAD_SIZE;
          if (second_event.header.type == BRK_EVENT_PARAM_RAMP) {
            const auto second_ramp = detail::load<brk_param_ramp_event>(second_event.bytes);
            if (first_ramp.parameter_id == second_ramp.parameter_id
                && detail::ranges_overlap(
                    first_ramp.header.frame_offset, first_ramp.duration_frames,
                    second_ramp.header.frame_offset, second_ramp.duration_frames)) {
              return BRK_ERROR_BAD_EVENT;
            }
          } else if (second_event.header.type == BRK_EVENT_PARAM_VALUE) {
            const auto value = detail::load<brk_param_value_event>(second_event.bytes);
            if (first_ramp.parameter_id == value.parameter_id
                && value.header.frame_offset >= first_ramp.header.frame_offset
                && static_cast<std::uint64_t>(value.header.frame_offset)
                    < static_cast<std::uint64_t>(first_ramp.header.frame_offset)
                        + first_ramp.duration_frames) return BRK_ERROR_BAD_EVENT;
          }
          second_offset += second_event.header.size;
        }
      }
      first_offset += first_event.header.size;
    }
    return BRK_OK;
  }

  std::int32_t process(
      BogieEngine& engine, float* left, float* right, std::uint32_t frames,
      const std::uint8_t* bytes, std::uint32_t byte_size,
      std::uint32_t count) noexcept {
    if (left == nullptr || right == nullptr || frames == 0U
        || frames > engine.max_block_frames()) return BRK_ERROR_INVALID_ARGUMENT;
    const auto checked = validate(bytes, byte_size, count, frames);
    if (checked != BRK_OK) return checked;

    if (count == 0U && active_ramp_count() == 0U) {
      engine.process(left, right, frames);
      return BRK_OK;
    }

    std::size_t offset = 0U;
    std::uint32_t event_index = 0U;
    Patch working = engine.patch();

    for (std::uint32_t frame = 0; frame < frames; ++frame) {
      while (event_index < count) {
        detail::EventView event{};
        if (!detail::read(bytes, byte_size, offset, event)) return BRK_ERROR_INTERNAL;
        if (event.header.frame_offset != frame
            || detail::priority(event.header.type) > EventPriority::NoteOff) break;
        switch (event.header.type) {
          case BRK_EVENT_RESET: engine.reset(); clear(); break;
          case BRK_EVENT_ALL_NOTES_OFF: engine.all_notes_off(); break;
          case BRK_EVENT_NOTE_CHOKE:
            engine.choke(detail::load<brk_note_event>(event.bytes).note_id);
            break;
          case BRK_EVENT_NOTE_OFF:
            engine.note_off(detail::load<brk_note_event>(event.bytes).note_id);
            break;
          default: return BRK_ERROR_INTERNAL;
        }
        offset += event.header.size;
        ++event_index;
      }

      bool dirty = false;
      for (auto& ramp : ramps_) {
        if (!ramp.active) continue;
        if (!set_parameter_normalized(working, ramp.id, ramp.value())) return BRK_ERROR_INTERNAL;
        dirty = true;
      }

      while (event_index < count) {
        detail::EventView event{};
        if (!detail::read(bytes, byte_size, offset, event)) return BRK_ERROR_INTERNAL;
        if (event.header.frame_offset != frame) break;
        if (event.header.type == BRK_EVENT_PARAM_VALUE) {
          const auto value = detail::load<brk_param_value_event>(event.bytes);
          if (!set_parameter_normalized(
                  working, static_cast<ParamId>(value.parameter_id),
                  value.normalized_value)) return BRK_ERROR_INTERNAL;
          dirty = true;
        } else if (event.header.type == BRK_EVENT_PARAM_RAMP) {
          const auto source = detail::load<brk_param_ramp_event>(event.bytes);
          auto* slot = first_free_ramp();
          if (slot == nullptr) return BRK_ERROR_INTERNAL;
          *slot = {
              static_cast<ParamId>(source.parameter_id),
              source.start_normalized,
              source.end_normalized,
              source.duration_frames,
              0U,
              true};
          if (!set_parameter_normalized(working, slot->id, slot->value())) {
            return BRK_ERROR_INTERNAL;
          }
          dirty = true;
        } else {
          break;
        }
        offset += event.header.size;
        ++event_index;
      }
      if (dirty) engine.set_patch(working);

      while (event_index < count) {
        detail::EventView event{};
        if (!detail::read(bytes, byte_size, offset, event)) return BRK_ERROR_INTERNAL;
        if (event.header.frame_offset != frame) break;
        if (event.header.type == BRK_EVENT_NOTE_ON) {
          const auto note = detail::load<brk_note_event>(event.bytes);
          engine.note_on(note.note_id, note.key, note.velocity, note.tuning_semitones);
        } else if (event.header.type == BRK_EVENT_RETRIGGER) {
          engine.retrigger(detail::load<brk_note_event>(event.bytes).note_id);
        } else {
          return BRK_ERROR_INTERNAL;
        }
        offset += event.header.size;
        ++event_index;
      }

      engine.process(left + frame, right + frame, 1U);
      advance_ramps();
    }

    return event_index == count && offset == byte_size ? BRK_OK : BRK_ERROR_INTERNAL;
  }

 private:
  struct Ramp {
    ParamId id{};
    float start = 0.0F;
    float end = 0.0F;
    std::uint32_t duration = 0U;
    std::uint32_t position = 0U;
    bool active = false;

    [[nodiscard]] float value() const noexcept {
      if (duration <= 1U) return end;
      const float t = static_cast<float>(position)
          / static_cast<float>(duration - 1U);
      return start + (end - start) * t;
    }

    [[nodiscard]] std::uint32_t remaining() const noexcept {
      return active && position < duration ? duration - position : 0U;
    }
  };

  std::array<Ramp, kMaxPersistentRamps> ramps_{};

  Ramp* first_free_ramp() noexcept {
    for (auto& ramp : ramps_) {
      if (!ramp.active) return &ramp;
    }
    return nullptr;
  }

  void advance_ramps() noexcept {
    for (auto& ramp : ramps_) {
      if (!ramp.active) continue;
      ++ramp.position;
      if (ramp.position >= ramp.duration) ramp.active = false;
    }
  }
};

}  // namespace brk::bogie::abi

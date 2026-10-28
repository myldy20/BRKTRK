#pragma once

#include "brk_modal_event_executor.hpp"
#include "brk_modal/state_v1.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <new>

namespace brk::modal::abi {

inline constexpr std::size_t kMaxModuleInstances = 8U;
inline constexpr std::size_t kMaxPersistentRamps = 64U;
inline constexpr std::uint32_t kStateSchemaVersionV1 =
    (static_cast<std::uint32_t>(kStateSchemaMajor) << 16U) | kStateSchemaMinor;
inline constexpr std::uint32_t kRealtimeMemoryEstimateBytes = 768U * 1024U;

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

    std::int32_t process(Engine& engine,
                         float* output_left,
                         float* output_right,
                         std::uint32_t frame_count,
                         const std::uint8_t* event_bytes,
                         std::uint32_t event_bytes_size,
                         std::uint32_t event_count) noexcept {
        if (output_left == nullptr || output_right == nullptr || frame_count == 0U
            || frame_count > engine.max_block_frames()) return BRK_ERROR_INVALID_ARGUMENT;
        const auto validation = validate(event_bytes, event_bytes_size, event_count, frame_count);
        if (validation != BRK_OK) return validation;

        // The common realtime case has neither block-local events nor an active
        // parameter ramp. Preserve the engine's native block processing instead
        // of forcing one Engine::process(..., 1) call per sample. Event-bearing
        // blocks and ramp continuation keep the existing sample-accurate path.
        if (event_count == 0U && active_ramp_count() == 0U) {
            engine.process(output_left, output_right, frame_count);
            return BRK_OK;
        }

        std::size_t event_offset = 0U;
        std::uint32_t event_index = 0U;
        Patch working_patch = engine.patch();

        for (std::uint32_t frame = 0U; frame < frame_count; ++frame) {
            while (event_index < event_count) {
                event_detail::EventView event{};
                if (!event_detail::read_event(event_bytes, event_bytes_size, event_offset, event)) {
                    return BRK_ERROR_INTERNAL;
                }
                const auto current_priority = event_detail::priority(event.header.type);
                if (event.header.frame_offset != frame || !event_detail::is_early_lifecycle(current_priority)) break;
                switch (event.header.type) {
                case BRK_EVENT_RESET:
                    engine.reset();
                    clear();
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
            bool live_performance_only = true;
            bool a_decay_dirty = false;
            bool a_material_dirty = false;
            bool a_tone_dirty = false;
            bool b_decay_dirty = false;
            bool b_material_dirty = false;
            bool b_tone_dirty = false;
            bool width_dirty = false;
            bool resonator_gain_dirty = false;
            bool output_gain_dirty = false;
            const auto classify_parameter = [&](ParameterId id) noexcept {
                switch (id) {
                case ParameterId::ADecaySeconds: a_decay_dirty = true; break;
                case ParameterId::AMaterial: a_material_dirty = true; break;
                case ParameterId::ATone: a_tone_dirty = true; break;
                case ParameterId::BDecaySeconds: b_decay_dirty = true; break;
                case ParameterId::BMaterial: b_material_dirty = true; break;
                case ParameterId::BTone: b_tone_dirty = true; break;
                case ParameterId::StereoWidth: width_dirty = true; break;
                case ParameterId::ResonatorGainDb: resonator_gain_dirty = true; break;
                case ParameterId::OutputGainDb: output_gain_dirty = true; break;
                default: live_performance_only = false; break;
                }
            };
            for (auto& ramp : ramps_) {
                if (!ramp.active) continue;
                if (!set_parameter_normalized(working_patch, ramp.id, ramp.value())) {
                    return BRK_ERROR_INTERNAL;
                }
                classify_parameter(ramp.id);
                patch_dirty = true;
            }

            while (event_index < event_count) {
                event_detail::EventView event{};
                if (!event_detail::read_event(event_bytes, event_bytes_size, event_offset, event)) {
                    return BRK_ERROR_INTERNAL;
                }
                const auto current_priority = event_detail::priority(event.header.type);
                if (event.header.frame_offset != frame || !event_detail::is_parameter(current_priority)) break;
                if (event.header.type == BRK_EVENT_PARAM_VALUE) {
                    const auto parameter = event_detail::load<brk_param_value_event>(event.bytes);
                    const auto id = static_cast<ParameterId>(parameter.parameter_id);
                    if (!set_parameter_normalized(
                            working_patch, id, parameter.normalized_value)) {
                        return BRK_ERROR_INTERNAL;
                    }
                    classify_parameter(id);
                    patch_dirty = true;
                } else {
                    const auto source = event_detail::load<brk_param_ramp_event>(event.bytes);
                    auto* slot = first_free_ramp();
                    if (slot == nullptr) return BRK_ERROR_INTERNAL;
                    *slot = {static_cast<ParameterId>(source.parameter_id), source.start_normalized,
                             source.end_normalized, source.duration_frames, 0U, true};
                    if (!set_parameter_normalized(working_patch, slot->id, slot->value())) {
                        return BRK_ERROR_INTERNAL;
                    }
                    classify_parameter(slot->id);
                    patch_dirty = true;
                }
                event_offset += event.header.size;
                ++event_index;
            }

            if (patch_dirty) {
                if (live_performance_only) {
                    if (a_decay_dirty || a_material_dirty || a_tone_dirty
                        || b_decay_dirty || b_material_dirty || b_tone_dirty || width_dirty) {
                        engine.set_live_performance_patch(
                            working_patch,
                            a_decay_dirty, a_material_dirty, a_tone_dirty,
                            b_decay_dirty, b_material_dirty, b_tone_dirty,
                            width_dirty);
                    }
                    if (resonator_gain_dirty || output_gain_dirty) {
                        engine.set_live_gain_patch(
                            working_patch, resonator_gain_dirty, output_gain_dirty);
                    }
                } else {
                    // Non-modulatable changes are validated to frame zero, so any
                    // expensive patch work is coalesced to at most one set_patch()
                    // call for the block rather than silently running per sample.
                    engine.set_patch(working_patch);
                }
            }

            while (event_index < event_count) {
                event_detail::EventView event{};
                if (!event_detail::read_event(event_bytes, event_bytes_size, event_offset, event)) {
                    return BRK_ERROR_INTERNAL;
                }
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
            advance_ramps();
        }

        return event_index == event_count && event_offset == event_bytes_size
            ? BRK_OK : BRK_ERROR_INTERNAL;
    }

private:
    struct Ramp {
        ParameterId id{};
        float start = 0.0F;
        float end = 0.0F;
        std::uint32_t duration = 0U;
        std::uint32_t position = 0U;
        bool active = false;

        [[nodiscard]] float value() const noexcept {
            if (duration <= 1U) return end;
            const float proportion = static_cast<float>(position)
                / static_cast<float>(duration - 1U);
            return start + (end - start) * proportion;
        }

        [[nodiscard]] std::uint32_t remaining() const noexcept {
            return active && position < duration ? duration - position : 0U;
        }
    };

    std::array<Ramp, kMaxPersistentRamps> ramps_{};

    Ramp* first_free_ramp() noexcept {
        for (auto& ramp : ramps_) if (!ramp.active) return &ramp;
        return nullptr;
    }

    void advance_ramps() noexcept {
        for (auto& ramp : ramps_) {
            if (!ramp.active) continue;
            ++ramp.position;
            if (ramp.position >= ramp.duration) ramp.active = false;
        }
    }

    [[nodiscard]] std::int32_t validate(const std::uint8_t* event_bytes,
                                        std::uint32_t event_bytes_size,
                                        std::uint32_t event_count,
                                        std::uint32_t frame_count) const noexcept {
        if (frame_count == 0U) return BRK_ERROR_INVALID_ARGUMENT;
        if (event_count == 0U) return event_bytes_size == 0U ? BRK_OK : BRK_ERROR_BAD_SIZE;
        if (event_bytes == nullptr || event_bytes_size == 0U) return BRK_ERROR_INVALID_ARGUMENT;

        std::size_t offset = 0U;
        std::uint32_t previous_frame = 0U;
        EventPriority previous_priority = EventPriority::Reset;
        bool first = true;
        std::size_t new_ramp_count = 0U;

        for (std::uint32_t index = 0U; index < event_count; ++index) {
            event_detail::EventView event{};
            if (!event_detail::read_event(event_bytes, event_bytes_size, offset, event)) {
                return BRK_ERROR_BAD_SIZE;
            }
            const auto expected = event_detail::expected_size(event.header.type);
            const auto current_priority = event_detail::priority(event.header.type);
            if (expected == 0U || event.header.size != expected) return BRK_ERROR_BAD_EVENT;
            if (event.header.flags != 0U || event.header.frame_offset >= frame_count) {
                return BRK_ERROR_BAD_EVENT;
            }
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
                    || !event_detail::normalized(note.velocity)
                    || !std::isfinite(note.tuning_semitones)) return BRK_ERROR_BAD_EVENT;
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
                const auto id = static_cast<ParameterId>(parameter.parameter_id);
                const auto* descriptor = parameter_descriptor(id);
                if (parameter.note_id != BRK_SYNTH_GLOBAL_NOTE_ID
                    || descriptor == nullptr
                    || !event_detail::normalized(parameter.normalized_value)) {
                    return BRK_ERROR_BAD_PARAMETER;
                }
                if (!parameter_supports_block_value(*descriptor)) return BRK_ERROR_BAD_PARAMETER;
                if (!parameter_supports_sample_accurate_events(*descriptor)
                    && event.header.frame_offset != 0U) return BRK_ERROR_BAD_EVENT;
                for (const auto& active : ramps_) {
                    if (active.active && static_cast<std::uint32_t>(active.id) == parameter.parameter_id
                        && event.header.frame_offset < active.remaining()) return BRK_ERROR_BAD_EVENT;
                }
                break;
            }
            case BRK_EVENT_PARAM_RAMP: {
                const auto ramp = event_detail::load<brk_param_ramp_event>(event.bytes);
                const auto id = static_cast<ParameterId>(ramp.parameter_id);
                const auto* descriptor = parameter_descriptor(id);
                if (ramp.note_id != BRK_SYNTH_GLOBAL_NOTE_ID
                    || descriptor == nullptr
                    || !event_detail::normalized(ramp.start_normalized)
                    || !event_detail::normalized(ramp.end_normalized)
                    || ramp.duration_frames == 0U) return BRK_ERROR_BAD_PARAMETER;
                if (!parameter_supports_sample_accurate_events(*descriptor)) {
                    return BRK_ERROR_BAD_EVENT;
                }
                for (const auto& active : ramps_) {
                    if (active.active && static_cast<std::uint32_t>(active.id) == ramp.parameter_id
                        && event.header.frame_offset < active.remaining()) return BRK_ERROR_BAD_EVENT;
                }
                if (active_ramp_count() + ++new_ramp_count > kMaxPersistentRamps) {
                    return BRK_ERROR_BAD_EVENT;
                }
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

        std::size_t first_offset = 0U;
        for (std::uint32_t first_index = 0U; first_index < event_count; ++first_index) {
            event_detail::EventView first_event{};
            if (!event_detail::read_event(event_bytes, event_bytes_size, first_offset, first_event)) {
                return BRK_ERROR_BAD_SIZE;
            }
            if (first_event.header.type == BRK_EVENT_PARAM_RAMP) {
                const auto first_ramp = event_detail::load<brk_param_ramp_event>(first_event.bytes);
                std::size_t second_offset = first_offset + first_event.header.size;
                for (std::uint32_t second_index = first_index + 1U;
                     second_index < event_count; ++second_index) {
                    event_detail::EventView second_event{};
                    if (!event_detail::read_event(event_bytes, event_bytes_size, second_offset, second_event)) {
                        return BRK_ERROR_BAD_SIZE;
                    }
                    if (second_event.header.type == BRK_EVENT_PARAM_RAMP) {
                        const auto second_ramp = event_detail::load<brk_param_ramp_event>(second_event.bytes);
                        if (first_ramp.parameter_id == second_ramp.parameter_id
                            && event_detail::ranges_overlap(
                                first_ramp.header.frame_offset, first_ramp.duration_frames,
                                second_ramp.header.frame_offset, second_ramp.duration_frames)) {
                            return BRK_ERROR_BAD_EVENT;
                        }
                    } else if (second_event.header.type == BRK_EVENT_PARAM_VALUE) {
                        const auto value = event_detail::load<brk_param_value_event>(second_event.bytes);
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
};

class ModuleRuntime {
public:
    std::int32_t create(std::uint32_t engine_index) noexcept {
        if (engine_index != 0U) return BRK_ERROR_INVALID_ARGUMENT;
        for (std::size_t i = 0U; i < slots_.size(); ++i) {
            auto& slot = slots_[i];
            if (slot.engine) continue;
            slot.engine.reset(new (std::nothrow) Engine());
            if (!slot.engine) return BRK_ERROR_OUT_OF_MEMORY;
            slot.prepared = false;
            slot.active = false;
            slot.max_events_per_block = 0U;
            slot.executor.clear();
            return static_cast<std::int32_t>(encode_handle(i, slot.generation));
        }
        return BRK_ERROR_OUT_OF_MEMORY;
    }

    std::int32_t prepare(brk_instance_handle handle, const brk_prepare_info& info) noexcept {
        auto* slot = resolve(handle);
        if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
        if (slot->active) return BRK_ERROR_ALREADY_ACTIVE;
        if (info.struct_size < sizeof(brk_prepare_info) || info.flags != 0U
            || !std::isfinite(info.sample_rate) || info.sample_rate < 8000.0
            || info.sample_rate > 384000.0 || info.max_block_frames == 0U
            || info.max_events_per_block == 0U || info.output_channel_count != 2U) {
            return BRK_ERROR_INVALID_ARGUMENT;
        }
        if (info.realtime_memory_limit_bytes != 0U
            && info.realtime_memory_limit_bytes < kRealtimeMemoryEstimateBytes) {
            return BRK_ERROR_OUT_OF_MEMORY;
        }
        const std::uint64_t seed = static_cast<std::uint64_t>(info.deterministic_seed_lo)
            | (static_cast<std::uint64_t>(info.deterministic_seed_hi) << 32U);
        if (!slot->engine->prepare(info.sample_rate, info.max_block_frames, seed)) {
            return BRK_ERROR_INVALID_ARGUMENT;
        }
        slot->max_events_per_block = info.max_events_per_block;
        slot->executor.clear();
        slot->prepared = true;
        return BRK_OK;
    }

    std::int32_t activate(brk_instance_handle handle) noexcept {
        auto* slot = resolve(handle);
        if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
        if (!slot->prepared) return BRK_ERROR_NOT_PREPARED;
        if (slot->active) return BRK_ERROR_ALREADY_ACTIVE;
        slot->active = true;
        return BRK_OK;
    }

    std::int32_t deactivate(brk_instance_handle handle) noexcept {
        auto* slot = resolve(handle);
        if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
        if (!slot->active) return BRK_ERROR_NOT_ACTIVE;
        slot->engine->reset();
        slot->executor.clear();
        slot->active = false;
        return BRK_OK;
    }

    std::int32_t reset(brk_instance_handle handle) noexcept {
        auto* slot = resolve(handle);
        if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
        if (!slot->prepared) return BRK_ERROR_NOT_PREPARED;
        slot->engine->reset();
        slot->executor.clear();
        return BRK_OK;
    }

    std::int32_t destroy(brk_instance_handle handle) noexcept {
        const auto index = decode_index(handle);
        if (index >= slots_.size()) return BRK_ERROR_INVALID_ARGUMENT;
        auto& slot = slots_[index];
        if (!slot.engine || slot.generation != decode_generation(handle)) {
            return BRK_ERROR_INVALID_ARGUMENT;
        }
        if (slot.active) return BRK_ERROR_ALREADY_ACTIVE;
        slot.engine.reset();
        slot.prepared = false;
        slot.max_events_per_block = 0U;
        slot.executor.clear();
        slot.generation = next_generation(slot.generation);
        return BRK_OK;
    }

    std::int32_t process(brk_instance_handle handle,
                         float* output_left,
                         float* output_right,
                         std::uint32_t frame_count,
                         const std::uint8_t* event_bytes,
                         std::uint32_t event_bytes_size,
                         std::uint32_t event_count) noexcept {
        auto* slot = resolve(handle);
        if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
        if (!slot->prepared) return BRK_ERROR_NOT_PREPARED;
        if (!slot->active) return BRK_ERROR_NOT_ACTIVE;
        if (event_count > slot->max_events_per_block) return BRK_ERROR_BAD_EVENT;
        return slot->executor.process(*slot->engine, output_left, output_right, frame_count,
                                      event_bytes, event_bytes_size, event_count);
    }

    [[nodiscard]] std::uint32_t state_size(brk_instance_handle handle) noexcept {
        return resolve(handle) == nullptr ? 0U : static_cast<std::uint32_t>(kStateV1Size);
    }

    std::int32_t state_write(brk_instance_handle handle,
                             std::uint8_t* dst,
                             std::size_t capacity) noexcept {
        auto* slot = resolve(handle);
        if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
        if (dst == nullptr || capacity < kStateV1Size) return BRK_ERROR_BAD_SIZE;
        return write_state_v1(slot->engine->patch(), dst, capacity) ? BRK_OK : BRK_ERROR_INTERNAL;
    }

    std::int32_t state_read(brk_instance_handle handle,
                            const std::uint8_t* src,
                            std::size_t size,
                            std::uint32_t schema_version) noexcept {
        auto* slot = resolve(handle);
        if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
        if (slot->active) return BRK_ERROR_ALREADY_ACTIVE;
        if (schema_version != kStateSchemaVersionV1) return BRK_ERROR_UNSUPPORTED;
        Patch candidate = slot->engine->patch();
        const auto result = read_state_v1(candidate, src, size);
        if (result != StateReadResult::Ok) {
            return result == StateReadResult::BadSize ? BRK_ERROR_BAD_SIZE : BRK_ERROR_INVALID_STATE;
        }
        slot->engine->set_patch(candidate);
        slot->executor.clear();
        return BRK_OK;
    }

    [[nodiscard]] Engine* engine(brk_instance_handle handle) noexcept {
        auto* slot = resolve(handle);
        return slot == nullptr ? nullptr : slot->engine.get();
    }

    [[nodiscard]] std::size_t active_ramp_count(brk_instance_handle handle) noexcept {
        auto* slot = resolve(handle);
        return slot == nullptr ? 0U : slot->executor.active_ramp_count();
    }

    void clear() noexcept {
        for (auto& slot : slots_) {
            slot.engine.reset();
            slot.prepared = false;
            slot.active = false;
            slot.max_events_per_block = 0U;
            slot.executor.clear();
            slot.generation = next_generation(slot.generation);
        }
    }

private:
    struct Slot {
        std::unique_ptr<Engine> engine{};
        PersistentEventExecutor executor{};
        std::uint32_t generation = 1U;
        std::uint32_t max_events_per_block = 0U;
        bool prepared = false;
        bool active = false;
    };

    std::array<Slot, kMaxModuleInstances> slots_{};

    static constexpr std::uint32_t kIndexMask = 0xffU;
    static constexpr std::uint32_t kGenerationMask = 0x007fffffU;

    static brk_instance_handle encode_handle(std::size_t index, std::uint32_t generation) noexcept {
        return ((generation & kGenerationMask) << 8U)
            | static_cast<std::uint32_t>(index + 1U);
    }

    static std::size_t decode_index(brk_instance_handle handle) noexcept {
        const auto encoded = handle & kIndexMask;
        return encoded == 0U ? kMaxModuleInstances : static_cast<std::size_t>(encoded - 1U);
    }

    static std::uint32_t decode_generation(brk_instance_handle handle) noexcept {
        return (handle >> 8U) & kGenerationMask;
    }

    static std::uint32_t next_generation(std::uint32_t generation) noexcept {
        generation = (generation + 1U) & kGenerationMask;
        return generation == 0U ? 1U : generation;
    }

    Slot* resolve(brk_instance_handle handle) noexcept {
        const auto index = decode_index(handle);
        if (index >= slots_.size()) return nullptr;
        auto& slot = slots_[index];
        return slot.engine && slot.generation == decode_generation(handle) ? &slot : nullptr;
    }
};

ModuleRuntime& module_runtime() noexcept;
void bind_native_linear_memory(void* base, std::size_t size) noexcept;
void reset_module_runtime_for_tests() noexcept;

} // namespace brk::modal::abi
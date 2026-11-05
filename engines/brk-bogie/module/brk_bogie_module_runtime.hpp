#pragma once

#include "brk_synth_abi.h"
#include "brk_bogie/abi_events.hpp"
#include "brk_bogie/state_v1.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace brk::bogie::module {

inline constexpr std::size_t kMaxModuleInstances = 8U;
inline constexpr std::uint32_t kRealtimeMemoryEstimateBytes = 64U * 1024U;

class ModuleRuntime {
 public:
  std::int32_t create(std::uint32_t engine_index) noexcept {
    if (engine_index != 0U) return BRK_ERROR_INVALID_ARGUMENT;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
      auto& slot = slots_[i];
      if (slot.occupied) continue;
      const auto generation = slot.generation;
      slot = Slot{};
      slot.generation = generation;
      slot.occupied = true;
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

    slot->engine = BogieEngine{};
    if (!slot->engine.prepare(info.sample_rate, info.max_block_frames)) {
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
    slot->engine.reset();
    slot->executor.clear();
    slot->active = false;
    return BRK_OK;
  }

  std::int32_t reset(brk_instance_handle handle) noexcept {
    auto* slot = resolve(handle);
    if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    if (!slot->prepared) return BRK_ERROR_NOT_PREPARED;
    slot->engine.reset();
    slot->executor.clear();
    return BRK_OK;
  }

  std::int32_t destroy(brk_instance_handle handle) noexcept {
    const auto index = decode_index(handle);
    if (index >= slots_.size()) return BRK_ERROR_INVALID_ARGUMENT;
    auto& slot = slots_[index];
    if (!slot.occupied || slot.generation != decode_generation(handle)) {
      return BRK_ERROR_INVALID_ARGUMENT;
    }
    if (slot.active) return BRK_ERROR_ALREADY_ACTIVE;
    const auto next = next_generation(slot.generation);
    slot = Slot{};
    slot.generation = next;
    return BRK_OK;
  }

  std::int32_t process(
      brk_instance_handle handle, float* left, float* right,
      std::uint32_t frames, const std::uint8_t* events,
      std::uint32_t event_bytes, std::uint32_t event_count) noexcept {
    auto* slot = resolve(handle);
    if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    if (!slot->prepared) return BRK_ERROR_NOT_PREPARED;
    if (!slot->active) return BRK_ERROR_NOT_ACTIVE;
    if (event_count > slot->max_events_per_block) return BRK_ERROR_BAD_EVENT;
    return slot->executor.process(
        slot->engine, left, right, frames, events, event_bytes, event_count);
  }

  [[nodiscard]] std::uint32_t state_size(brk_instance_handle handle) noexcept {
    return resolve(handle) == nullptr
        ? 0U
        : static_cast<std::uint32_t>(kStateV1Size);
  }

  std::int32_t state_write(
      brk_instance_handle handle, std::uint8_t* dst, std::size_t capacity) noexcept {
    auto* slot = resolve(handle);
    if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    if (slot->active) return BRK_ERROR_ALREADY_ACTIVE;
    if (dst == nullptr || capacity < kStateV1Size) return BRK_ERROR_BAD_SIZE;
    return write_state_v1(slot->engine.patch(), dst, capacity)
        ? BRK_OK
        : BRK_ERROR_INTERNAL;
  }

  std::int32_t state_read(
      brk_instance_handle handle, const std::uint8_t* src,
      std::size_t size, std::uint32_t schema_version) noexcept {
    auto* slot = resolve(handle);
    if (slot == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    if (slot->active) return BRK_ERROR_ALREADY_ACTIVE;
    if (schema_version != kStateSchemaVersion) return BRK_ERROR_UNSUPPORTED;
    Patch candidate = slot->engine.patch();
    const auto result = read_state_v1(candidate, src, size);
    if (result != StateReadResult::Ok) {
      return result == StateReadResult::BadSize
          ? BRK_ERROR_BAD_SIZE
          : BRK_ERROR_INVALID_STATE;
    }
    slot->engine.set_patch(candidate);
    slot->engine.reset();
    slot->executor.clear();
    return BRK_OK;
  }

  [[nodiscard]] BogieEngine* engine(brk_instance_handle handle) noexcept {
    auto* slot = resolve(handle);
    return slot == nullptr ? nullptr : &slot->engine;
  }

  [[nodiscard]] std::size_t active_ramp_count(brk_instance_handle handle) noexcept {
    auto* slot = resolve(handle);
    return slot == nullptr ? 0U : slot->executor.active_ramp_count();
  }

  void clear() noexcept {
    for (auto& slot : slots_) {
      const auto next = next_generation(slot.generation);
      slot = Slot{};
      slot.generation = next;
    }
  }

 private:
  struct Slot {
    BogieEngine engine{};
    abi::PersistentEventExecutor executor{};
    std::uint32_t generation = 1U;
    std::uint32_t max_events_per_block = 0U;
    bool occupied = false;
    bool prepared = false;
    bool active = false;
  };

  std::array<Slot, kMaxModuleInstances> slots_{};

  static constexpr std::uint32_t kIndexMask = 0xffU;
  static constexpr std::uint32_t kGenerationMask = 0x007fffffU;

  static brk_instance_handle encode_handle(
      std::size_t index, std::uint32_t generation) noexcept {
    return ((generation & kGenerationMask) << 8U)
        | static_cast<std::uint32_t>(index + 1U);
  }

  static std::size_t decode_index(brk_instance_handle handle) noexcept {
    const auto encoded = handle & kIndexMask;
    return encoded == 0U
        ? kMaxModuleInstances
        : static_cast<std::size_t>(encoded - 1U);
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
    return slot.occupied && slot.generation == decode_generation(handle)
        ? &slot
        : nullptr;
  }
};

ModuleRuntime& module_runtime() noexcept;
void bind_native_linear_memory(void* base, std::size_t size) noexcept;
void reset_module_runtime_for_tests() noexcept;

}  // namespace brk::bogie::module

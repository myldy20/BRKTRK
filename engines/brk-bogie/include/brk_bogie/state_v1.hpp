#pragma once

#include "brk_bogie/parameter_registry.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace brk::bogie {

inline constexpr std::uint32_t kStateMagic = 0x534b5242U;
inline constexpr std::uint16_t kStateSchemaMajor = 1U;
inline constexpr std::uint16_t kStateSchemaMinor = 0U;
inline constexpr std::uint32_t kStateSchemaVersion = 0x00010000U;
inline constexpr std::size_t kStateHeaderSize = 56U;
inline constexpr std::size_t kStateParameterRecordSize = 8U;
inline constexpr const char* kStateEngineId = "brk-bogie";
inline constexpr std::size_t kStateV1Size =
    kStateHeaderSize + kParameterCount * kStateParameterRecordSize;

constexpr std::uint32_t fnv1a32(const char* text) noexcept {
  std::uint32_t hash = 2166136261U;
  while (text != nullptr && *text != '\0') {
    hash ^= static_cast<std::uint8_t>(*text++);
    hash *= 16777619U;
  }
  return hash;
}

inline constexpr std::uint32_t kStateEngineIdHash = fnv1a32(kStateEngineId);

enum class StateReadResult : std::uint8_t {
  Ok = 0,
  InvalidArgument,
  BadSize,
  BadMagic,
  BadSchema,
  BadEngine,
  BadCrc,
  BadParameter,
  NonCanonical,
};

namespace state_detail {
inline void write_u16(std::uint8_t* dst, std::uint16_t value) noexcept {
  dst[0] = static_cast<std::uint8_t>(value);
  dst[1] = static_cast<std::uint8_t>(value >> 8U);
}
inline void write_u32(std::uint8_t* dst, std::uint32_t value) noexcept {
  for (unsigned i = 0; i < 4U; ++i) dst[i] = static_cast<std::uint8_t>(value >> (8U * i));
}
inline std::uint16_t read_u16(const std::uint8_t* src) noexcept {
  return static_cast<std::uint16_t>(src[0])
      | static_cast<std::uint16_t>(static_cast<std::uint16_t>(src[1]) << 8U);
}
inline std::uint32_t read_u32(const std::uint8_t* src) noexcept {
  return static_cast<std::uint32_t>(src[0])
      | (static_cast<std::uint32_t>(src[1]) << 8U)
      | (static_cast<std::uint32_t>(src[2]) << 16U)
      | (static_cast<std::uint32_t>(src[3]) << 24U);
}
inline void write_f32(std::uint8_t* dst, float value) noexcept {
  std::uint32_t bits = 0U;
  std::memcpy(&bits, &value, sizeof(bits));
  write_u32(dst, bits);
}
inline float read_f32(const std::uint8_t* src) noexcept {
  const auto bits = read_u32(src);
  float value = 0.0F;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}
inline std::uint32_t crc32(const std::uint8_t* data, std::size_t size) noexcept {
  std::uint32_t crc = 0xffffffffU;
  for (std::size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (unsigned bit = 0; bit < 8U; ++bit) {
      const std::uint32_t mask = 0U - (crc & 1U);
      crc = (crc >> 1U) ^ (0xedb88320U & mask);
    }
  }
  return ~crc;
}
}  // namespace state_detail

static_assert(kStateV1Size == 120U, "BRK BOGIE state v1 size changed");

inline bool write_state_v1(const Patch& patch, std::uint8_t* dst, std::size_t capacity) noexcept {
  if (dst == nullptr || capacity < kStateV1Size) return false;
  if (static_cast<std::uint32_t>(patch.model) >= kModelCount) return false;

  std::fill(dst, dst + kStateV1Size, 0U);
  auto* payload = dst + kStateHeaderSize;
  for (std::size_t i = 0; i < kParameterCount; ++i) {
    const auto* descriptor = parameter_descriptor_at(i);
    float normalized = 0.0F;
    if (descriptor == nullptr || !get_parameter_normalized(patch, descriptor->id, normalized)
        || !std::isfinite(normalized) || normalized < 0.0F || normalized > 1.0F) return false;
    auto* record = payload + i * kStateParameterRecordSize;
    state_detail::write_u32(record, static_cast<std::uint32_t>(descriptor->id));
    state_detail::write_f32(record + 4U, normalized);
  }

  state_detail::write_u32(dst + 0U, kStateMagic);
  state_detail::write_u16(dst + 4U, kStateSchemaMajor);
  state_detail::write_u16(dst + 6U, kStateSchemaMinor);
  state_detail::write_u32(dst + 8U, static_cast<std::uint32_t>(kStateHeaderSize));
  state_detail::write_u32(dst + 12U, static_cast<std::uint32_t>(kStateV1Size));
  state_detail::write_u32(dst + 16U, kStateEngineIdHash);
  state_detail::write_u32(dst + 20U, static_cast<std::uint32_t>(kParameterCount));
  state_detail::write_u32(
      dst + 24U,
      state_detail::crc32(payload, kStateV1Size - kStateHeaderSize));
  return true;
}

inline StateReadResult read_state_v1(
    Patch& patch, const std::uint8_t* src, std::size_t size) noexcept {
  if (src == nullptr) return StateReadResult::InvalidArgument;
  if (size != kStateV1Size) return StateReadResult::BadSize;
  if (state_detail::read_u32(src + 0U) != kStateMagic) return StateReadResult::BadMagic;
  if (state_detail::read_u16(src + 4U) != kStateSchemaMajor
      || state_detail::read_u16(src + 6U) != kStateSchemaMinor) return StateReadResult::BadSchema;
  if (state_detail::read_u32(src + 8U) != kStateHeaderSize
      || state_detail::read_u32(src + 12U) != kStateV1Size
      || state_detail::read_u32(src + 20U) != kParameterCount) return StateReadResult::BadSize;
  if (state_detail::read_u32(src + 16U) != kStateEngineIdHash) return StateReadResult::BadEngine;
  if (state_detail::read_u32(src + 28U) != 0U) return StateReadResult::NonCanonical;
  for (std::size_t i = 32U; i < kStateHeaderSize; ++i) {
    if (src[i] != 0U) return StateReadResult::NonCanonical;
  }

  const auto* payload = src + kStateHeaderSize;
  if (state_detail::crc32(payload, kStateV1Size - kStateHeaderSize)
      != state_detail::read_u32(src + 24U)) return StateReadResult::BadCrc;

  Patch candidate = patch;
  for (std::size_t i = 0; i < kParameterCount; ++i) {
    const auto* descriptor = parameter_descriptor_at(i);
    const auto* record = payload + i * kStateParameterRecordSize;
    const auto id = static_cast<ParamId>(state_detail::read_u32(record));
    const float normalized = state_detail::read_f32(record + 4U);
    if (descriptor == nullptr || id != descriptor->id) return StateReadResult::NonCanonical;
    if (!std::isfinite(normalized) || normalized < 0.0F || normalized > 1.0F) {
      return StateReadResult::BadParameter;
    }
    if (!set_parameter_normalized(candidate, id, normalized)) return StateReadResult::BadParameter;
  }

  if (static_cast<std::uint32_t>(candidate.model) >= kModelCount) {
    return StateReadResult::BadParameter;
  }
  patch = candidate;
  return StateReadResult::Ok;
}

}  // namespace brk::bogie

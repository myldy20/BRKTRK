#pragma once

#include "brk_bogie/bogie_engine.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace brk::bogie {

enum class ParameterKind : std::uint8_t { Continuous = 0, Enum };
enum class AutomationRate : std::uint8_t { Sample = 0, Control };
enum class SmoothingOwner : std::uint8_t { None = 0, Host };

struct ParameterDescriptor {
  ParamId id;
  const char* key;
  const char* display_name;
  const char* unit;
  const char* group_key;
  ParameterKind kind;
  AutomationRate automation_rate;
  SmoothingOwner smoothing_owner;
  float normalized_default;
  float plain_min;
  float plain_max;
  std::uint32_t enum_value_count;
  bool modulation_destination;
};

inline constexpr std::array<const char*, kModelCount> kModelLabels{{
    "Kick", "Snare", "Hat", "Clap", "Tom", "Rim",
    "FM", "Noise", "Cowbell", "Cymbal", "Shaker", "Clave",
}};

inline constexpr std::array<ParameterDescriptor, 8> kParameterDescriptors{{
    {ParamId::Model, "model", "Model", "", "source", ParameterKind::Enum,
     AutomationRate::Control, SmoothingOwner::None, 0.0F, 0.0F, 11.0F, 12U, false},
    {ParamId::Decay, "decay", "Decay", "norm", "shape", ParameterKind::Continuous,
     AutomationRate::Sample, SmoothingOwner::Host, 0.5F, 0.0F, 1.0F, 0U, true},
    {ParamId::Tone, "tone", "Tone", "norm", "shape", ParameterKind::Continuous,
     AutomationRate::Sample, SmoothingOwner::Host, 0.5F, 0.0F, 1.0F, 0U, true},
    {ParamId::Sweep, "sweep", "Sweep", "norm", "shape", ParameterKind::Continuous,
     AutomationRate::Sample, SmoothingOwner::Host, 0.25F, 0.0F, 1.0F, 0U, true},
    {ParamId::Noise, "noise", "Noise", "norm", "shape", ParameterKind::Continuous,
     AutomationRate::Sample, SmoothingOwner::Host, 0.25F, 0.0F, 1.0F, 0U, true},
    {ParamId::Fm, "fm", "FM", "norm", "shape", ParameterKind::Continuous,
     AutomationRate::Sample, SmoothingOwner::Host, 0.25F, 0.0F, 1.0F, 0U, true},
    {ParamId::Drive, "drive", "Drive", "norm", "output", ParameterKind::Continuous,
     AutomationRate::Sample, SmoothingOwner::Host, 0.125F, 0.0F, 1.0F, 0U, true},
    {ParamId::Level, "level", "Level", "norm", "output", ParameterKind::Continuous,
     AutomationRate::Sample, SmoothingOwner::Host, 0.8F, 0.0F, 1.0F, 0U, true},
}};

inline constexpr std::size_t kParameterCount = kParameterDescriptors.size();

inline constexpr const ParameterDescriptor* parameter_descriptor_at(std::size_t index) noexcept {
  return index < kParameterDescriptors.size() ? &kParameterDescriptors[index] : nullptr;
}

inline constexpr const ParameterDescriptor* parameter_descriptor(ParamId id) noexcept {
  for (const auto& descriptor : kParameterDescriptors) {
    if (descriptor.id == id) return &descriptor;
  }
  return nullptr;
}

inline const ParameterDescriptor* parameter_descriptor_from_key(const char* key) noexcept {
  if (key == nullptr) return nullptr;
  for (const auto& descriptor : kParameterDescriptors) {
    if (std::strcmp(descriptor.key, key) == 0) return &descriptor;
  }
  return nullptr;
}

inline constexpr const char* parameter_enum_label(ParamId id, std::uint32_t index) noexcept {
  if (id != ParamId::Model || index >= kModelLabels.size()) return nullptr;
  return kModelLabels[index];
}

inline float clamp_normalized(float value) noexcept {
  return std::isfinite(value) ? std::clamp(value, 0.0F, 1.0F) : 0.0F;
}

inline std::uint32_t discrete_index(float normalized, std::uint32_t count) noexcept {
  if (count <= 1U) return 0U;
  const auto index = static_cast<std::uint32_t>(
      std::lround(clamp_normalized(normalized) * static_cast<float>(count - 1U)));
  return std::min(index, count - 1U);
}

inline float discrete_normalized(std::uint32_t index, std::uint32_t count) noexcept {
  return count <= 1U
      ? 0.0F
      : static_cast<float>(std::min(index, count - 1U)) / static_cast<float>(count - 1U);
}

inline bool get_parameter_normalized(const Patch& patch, ParamId id, float& value) noexcept {
  switch (id) {
    case ParamId::Model:
      value = discrete_normalized(static_cast<std::uint32_t>(patch.model), kModelCount);
      return true;
    case ParamId::Decay: value = patch.decay; return true;
    case ParamId::Tone: value = patch.tone; return true;
    case ParamId::Sweep: value = patch.sweep; return true;
    case ParamId::Noise: value = patch.noise; return true;
    case ParamId::Fm: value = patch.fm; return true;
    case ParamId::Drive: value = patch.drive; return true;
    case ParamId::Level: value = patch.level; return true;
  }
  return false;
}

inline bool set_parameter_normalized(Patch& patch, ParamId id, float value) noexcept {
  const float normalized = clamp_normalized(value);
  switch (id) {
    case ParamId::Model:
      patch.model = static_cast<Model>(discrete_index(normalized, kModelCount));
      return true;
    case ParamId::Decay: patch.decay = normalized; return true;
    case ParamId::Tone: patch.tone = normalized; return true;
    case ParamId::Sweep: patch.sweep = normalized; return true;
    case ParamId::Noise: patch.noise = normalized; return true;
    case ParamId::Fm: patch.fm = normalized; return true;
    case ParamId::Drive: patch.drive = normalized; return true;
    case ParamId::Level: patch.level = normalized; return true;
  }
  return false;
}

}  // namespace brk::bogie

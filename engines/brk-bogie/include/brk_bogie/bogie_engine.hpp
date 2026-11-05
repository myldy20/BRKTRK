#pragma once

#include "bogie_core.h"

#include <array>
#include <cstdint>

namespace brk::bogie {

inline constexpr std::uint32_t kVoiceCount = 8;
inline constexpr std::uint32_t kModelCount = 12;
inline constexpr std::uint32_t kMaxBlockFrames = 2048;

using Model = ::bogie::Model;

enum class ParamId : std::uint32_t {
  Model = 0x0100u,
  Decay = 0x0101u,
  Tone = 0x0102u,
  Sweep = 0x0103u,
  Noise = 0x0104u,
  Fm = 0x0105u,
  Drive = 0x0200u,
  Level = 0x0201u,
};

struct Patch {
  Model model = Model::Kick;
  float decay = 0.5f;
  float tone = 0.5f;
  float sweep = 0.25f;
  float noise = 0.25f;
  float fm = 0.25f;
  float drive = 0.125f;
  float level = 0.8f;
};

class BogieEngine {
 public:
  bool prepare(double sample_rate, std::uint32_t max_block_frames) noexcept;
  void reset() noexcept;
  void set_patch(const Patch& patch) noexcept;
  bool set_parameter(ParamId id, float normalized_value) noexcept;
  const Patch& patch() const noexcept { return patch_; }

  void note_on(std::uint32_t note_id, std::int16_t key, float velocity,
               float tuning_semitones = 0.0f) noexcept;
  void note_off(std::uint32_t note_id) noexcept;
  void choke(std::uint32_t note_id) noexcept;
  void retrigger(std::uint32_t note_id) noexcept;
  void all_notes_off() noexcept;
  void process(float* left, float* right, std::uint32_t frames) noexcept;

  [[nodiscard]] std::uint32_t active_voice_count() const noexcept;
  [[nodiscard]] std::uint32_t max_block_frames() const noexcept { return max_block_frames_; }
  [[nodiscard]] double sample_rate() const noexcept { return sample_rate_; }

 private:
  struct VoiceSlot {
    ::bogie::Core core{};
    std::uint32_t note_id = 0;
    std::uint64_t age = 0;
    float velocity = 0.0f;
    std::int16_t key = 60;
    float tuning_semitones = 0.0f;
  };

  VoiceSlot& select_voice() noexcept;
  void configure_voice(VoiceSlot& slot, std::int16_t key, float velocity,
                       float tuning_semitones) noexcept;

  std::array<VoiceSlot, kVoiceCount> voices_{};
  Patch patch_{};
  double sample_rate_ = 48000.0;
  std::uint32_t max_block_frames_ = 128;
  std::uint64_t age_counter_ = 0;
};

}  // namespace brk::bogie

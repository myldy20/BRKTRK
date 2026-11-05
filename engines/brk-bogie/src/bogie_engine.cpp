#include "brk_bogie/bogie_engine.hpp"
#include "brk_bogie/parameter_registry.hpp"

#include <algorithm>
#include <cmath>

namespace brk::bogie {
namespace {

float clamp01(float value) noexcept {
  if (!std::isfinite(value)) return 0.0f;
  return std::clamp(value, 0.0f, 1.0f);
}

::bogie::Parameters donor_parameters(const Patch& patch) noexcept {
  ::bogie::Parameters result;
  result.model = patch.model;
  result.decay = clamp01(patch.decay);
  result.tone = clamp01(patch.tone);
  result.sweep = clamp01(patch.sweep);
  result.noise = clamp01(patch.noise);
  result.fm = clamp01(patch.fm);
  result.drive = clamp01(patch.drive);
  return result;
}

}  // namespace

bool BogieEngine::prepare(double sample_rate, std::uint32_t max_block_frames) noexcept {
  if (!std::isfinite(sample_rate) || sample_rate < 8000.0 || sample_rate > 384000.0
      || max_block_frames == 0U || max_block_frames > kMaxBlockFrames) return false;
  sample_rate_ = sample_rate;
  max_block_frames_ = max_block_frames;
  for (auto& slot : voices_) slot.core.init(static_cast<float>(sample_rate_));
  reset();
  return true;
}

void BogieEngine::reset() noexcept {
  age_counter_ = 0;
  for (auto& slot : voices_) {
    slot.core = ::bogie::Core{};
    slot.core.init(static_cast<float>(sample_rate_));
    slot.note_id = 0;
    slot.age = 0;
    slot.velocity = 0.0f;
    slot.key = 60;
    slot.tuning_semitones = 0.0f;
  }
}

void BogieEngine::set_patch(const Patch& patch) noexcept {
  patch_ = patch;
  if (static_cast<unsigned>(patch_.model) >= kModelCount) patch_.model = Model::Kick;
  patch_.decay = clamp01(patch_.decay);
  patch_.tone = clamp01(patch_.tone);
  patch_.sweep = clamp01(patch_.sweep);
  patch_.noise = clamp01(patch_.noise);
  patch_.fm = clamp01(patch_.fm);
  patch_.drive = clamp01(patch_.drive);
  patch_.level = clamp01(patch_.level);

  const auto parameters = donor_parameters(patch_);
  for (auto& slot : voices_) {
    if (slot.core.active()) slot.core.setParameters(parameters);
  }
}

bool BogieEngine::set_parameter(ParamId id, float normalized_value) noexcept {
  Patch next = patch_;
  if (!set_parameter_normalized(next, id, normalized_value)) return false;
  set_patch(next);
  return true;
}

BogieEngine::VoiceSlot& BogieEngine::select_voice() noexcept {
  for (auto& slot : voices_) if (!slot.core.active()) return slot;
  auto* oldest = &voices_[0];
  for (auto& slot : voices_) if (slot.age < oldest->age) oldest = &slot;
  oldest->core = ::bogie::Core{};
  oldest->core.init(static_cast<float>(sample_rate_));
  oldest->note_id = 0;
  oldest->velocity = 0.0f;
  oldest->key = 60;
  oldest->tuning_semitones = 0.0f;
  return *oldest;
}

void BogieEngine::configure_voice(VoiceSlot& slot, std::int16_t key, float velocity,
                                  float tuning_semitones) noexcept {
  slot.core.setParameters(donor_parameters(patch_));
  const float semitones = static_cast<float>(key) - 69.0f + tuning_semitones;
  const float frequency = 440.0f * std::pow(2.0f, semitones / 12.0f);
  slot.core.setFrequency(frequency);
  slot.velocity = clamp01(velocity);
  slot.key = key;
  slot.tuning_semitones = tuning_semitones;
}

void BogieEngine::note_on(std::uint32_t note_id, std::int16_t key, float velocity,
                          float tuning_semitones) noexcept {
  if (key < 0 || key > 127 || !std::isfinite(velocity)
      || !std::isfinite(tuning_semitones)) return;
  auto& slot = select_voice();
  slot.note_id = note_id;
  slot.age = ++age_counter_;
  configure_voice(slot, key, velocity, tuning_semitones);
  slot.core.trigger();
}

void BogieEngine::note_off(std::uint32_t) noexcept {
  // Bogie is trigger/one-shot by design. NOTE_OFF does not truncate a drum hit.
}

void BogieEngine::choke(std::uint32_t note_id) noexcept {
  for (auto& slot : voices_) {
    if (slot.note_id == note_id && slot.core.active()) {
      slot.core = ::bogie::Core{};
      slot.core.init(static_cast<float>(sample_rate_));
      slot.note_id = 0;
      slot.velocity = 0.0f;
      slot.key = 60;
      slot.tuning_semitones = 0.0f;
    }
  }
}

void BogieEngine::retrigger(std::uint32_t note_id) noexcept {
  for (auto& slot : voices_) {
    if (slot.note_id != note_id || !slot.core.active()) continue;
    configure_voice(slot, slot.key, slot.velocity, slot.tuning_semitones);
    slot.age = ++age_counter_;
    slot.core.trigger();
  }
}

void BogieEngine::all_notes_off() noexcept {
  for (auto& slot : voices_) {
    slot.core = ::bogie::Core{};
    slot.core.init(static_cast<float>(sample_rate_));
    slot.note_id = 0;
    slot.velocity = 0.0f;
    slot.key = 60;
    slot.tuning_semitones = 0.0f;
  }
}

void BogieEngine::process(float* left, float* right, std::uint32_t frames) noexcept {
  if (left == nullptr || right == nullptr || frames == 0U || frames > max_block_frames_) return;
  std::fill(left, left + frames, 0.0f);
  std::fill(right, right + frames, 0.0f);

  for (auto& slot : voices_) {
    if (!slot.core.active()) continue;
    for (std::uint32_t i = 0; i < frames; ++i) {
      const float sample = slot.core.process() * slot.velocity * patch_.level;
      left[i] += sample;
      right[i] += sample;
    }
    if (!slot.core.active()) {
      slot.note_id = 0;
      slot.velocity = 0.0f;
      slot.key = 60;
      slot.tuning_semitones = 0.0f;
    }
  }

  for (std::uint32_t i = 0; i < frames; ++i) {
    if (!std::isfinite(left[i])) left[i] = 0.0f;
    if (!std::isfinite(right[i])) right[i] = 0.0f;
    left[i] = std::clamp(left[i], -1.0f, 1.0f);
    right[i] = std::clamp(right[i], -1.0f, 1.0f);
  }
}

std::uint32_t BogieEngine::active_voice_count() const noexcept {
  std::uint32_t count = 0;
  for (const auto& slot : voices_) if (slot.core.active()) ++count;
  return count;
}

}  // namespace brk::bogie

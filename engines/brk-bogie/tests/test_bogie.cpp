#include "brk_bogie/bogie_engine.hpp"
#include "brk_bogie/parameter_registry.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <vector>

using brk::bogie::BogieEngine;
using brk::bogie::Model;
using brk::bogie::ParamId;
using brk::bogie::Patch;

static void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << "\n";
    std::exit(1);
  }
}

static std::vector<float> render(Model model, float velocity = 1.0f, std::uint32_t block = 127) {
  BogieEngine engine;
  require(engine.prepare(48000.0, 256), "prepare");
  Patch patch;
  patch.model = model;
  patch.decay = 0.55f;
  patch.tone = 0.58f;
  patch.sweep = 0.42f;
  patch.noise = 0.52f;
  patch.fm = 0.37f;
  patch.drive = 0.20f;
  patch.level = 0.72f;
  engine.set_patch(patch);
  engine.note_on(1, 48, velocity, 0.0f);

  std::vector<float> output(4096, 0.0f);
  std::array<float, 256> left{}, right{};
  std::size_t cursor = 0;
  while (cursor < output.size()) {
    const auto frames = static_cast<std::uint32_t>(
        std::min<std::size_t>(block, output.size() - cursor));
    engine.process(left.data(), right.data(), frames);
    for (std::uint32_t i = 0; i < frames; ++i) {
      require(std::isfinite(left[i]), "finite left");
      require(std::isfinite(right[i]), "finite right");
      require(left[i] == right[i], "mirrored stereo");
      output[cursor + i] = left[i];
    }
    cursor += frames;
  }
  return output;
}

static double energy(const std::vector<float>& values) {
  double sum = 0.0;
  for (float value : values) sum += static_cast<double>(value) * value;
  return sum;
}

int main() {
  require(brk::bogie::kParameterCount == 8U, "all eight Bogie parameters are registered");
  for (std::size_t i = 0; i < brk::bogie::kParameterCount; ++i) {
    const auto* descriptor = brk::bogie::parameter_descriptor_at(i);
    require(descriptor != nullptr, "parameter descriptor exists");
    require(descriptor->key != nullptr && descriptor->key[0] != '\0', "parameter key exists");
    require(descriptor->display_name != nullptr && descriptor->display_name[0] != '\0',
            "parameter display name exists");
  }

  for (unsigned i = 0; i < brk::bogie::kModelCount; ++i) {
    const auto a = render(static_cast<Model>(i));
    const auto b = render(static_cast<Model>(i));
    require(a == b, "deterministic render");
    require(energy(a) > 1.0e-6, "non-silent model");
    require(brk::bogie::parameter_enum_label(ParamId::Model, i) != nullptr, "model UI label exists");
  }

  const auto loud = render(Model::Kick, 1.0f);
  const auto soft = render(Model::Kick, 0.25f);
  require(energy(loud) > energy(soft) * 2.0, "velocity changes energy");

  const auto chunked = render(Model::Cymbal, 0.8f, 1);
  const auto normal = render(Model::Cymbal, 0.8f, 128);
  require(chunked == normal, "block-size invariant render");

  BogieEngine engine;
  require(engine.prepare(48000.0, 128), "lifecycle prepare");
  engine.note_on(1, 48, 1.0f);
  engine.note_on(2, 52, 1.0f);
  require(engine.active_voice_count() == 2U, "two active voices");
  engine.choke(1);
  require(engine.active_voice_count() == 1U, "choke by note id");
  engine.all_notes_off();
  require(engine.active_voice_count() == 0U, "all notes off");

  BogieEngine parameter_engine;
  require(parameter_engine.prepare(48000.0, 128), "parameter prepare");
  require(parameter_engine.set_parameter(ParamId::Model, 1.0f), "set model");
  require(parameter_engine.patch().model == Model::Clave, "normalized model maps to Clave");
  require(parameter_engine.set_parameter(ParamId::Level, 1.0f), "set level");
  parameter_engine.note_on(7, 48, 1.0f);
  std::array<float, 128> before{}, before_r{}, after{}, after_r{};
  parameter_engine.process(before.data(), before_r.data(), 128);
  require(energy(std::vector<float>(before.begin(), before.end())) > 1.0e-8,
          "voice sounds before live level edit");
  require(parameter_engine.set_parameter(ParamId::Level, 0.0f), "live level edit");
  parameter_engine.process(after.data(), after_r.data(), 128);
  require(energy(std::vector<float>(after.begin(), after.end())) == 0.0,
          "live level edit affects active voice");

  BogieEngine reset_engine;
  require(reset_engine.prepare(48000.0, 128), "reset prepare");
  reset_engine.note_on(0, 48, 1.0f);
  std::array<float, 128> reset_a{}, reset_a_right{}, reset_b{}, reset_b_right{};
  reset_engine.process(reset_a.data(), reset_a_right.data(), 128);
  reset_engine.reset();
  reset_engine.note_on(0, 48, 1.0f);
  reset_engine.process(reset_b.data(), reset_b_right.data(), 128);
  require(reset_a == reset_b, "reset restores deterministic donor state");

  std::cout << "brk_bogie_p1_core=PASS\n";
  return 0;
}

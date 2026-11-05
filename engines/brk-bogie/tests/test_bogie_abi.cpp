#include "brk_synth_abi.h"
#include "brk_bogie/parameter_registry.hpp"
#include "brk_bogie/state_v1.hpp"
#include "brk_bogie_module_runtime.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

static void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << "\n";
    std::exit(1);
  }
}

template <class T>
static void store(std::vector<std::uint8_t>& memory, std::uint32_t offset, const T& value) {
  require(static_cast<std::size_t>(offset) + sizeof(T) <= memory.size(), "store in bounds");
  std::memcpy(memory.data() + offset, &value, sizeof(T));
}

template <class T>
static T load(const std::vector<std::uint8_t>& memory, std::uint32_t offset) {
  require(static_cast<std::size_t>(offset) + sizeof(T) <= memory.size(), "load in bounds");
  T value{};
  std::memcpy(&value, memory.data() + offset, sizeof(T));
  return value;
}

static std::string read_string(
    const std::vector<std::uint8_t>& memory, brk_string_ref ref) {
  require(static_cast<std::size_t>(ref.offset) + ref.byte_size <= memory.size(),
          "string in bounds");
  return std::string(
      reinterpret_cast<const char*>(memory.data() + ref.offset),
      ref.byte_size);
}

static double output_energy(
    const std::vector<std::uint8_t>& memory,
    std::uint32_t data_offset,
    std::uint32_t frames,
    std::uint32_t stride) {
  const auto* samples = reinterpret_cast<const float*>(memory.data() + data_offset);
  double result = 0.0;
  for (std::uint32_t i = 0; i < frames; ++i) {
    require(std::isfinite(samples[i]), "left finite");
    require(std::isfinite(samples[stride + i]), "right finite");
    require(samples[i] == samples[stride + i], "mirrored stereo");
    result += static_cast<double>(samples[i]) * samples[i];
  }
  return result;
}

int main() {
  using namespace brk::bogie;

  std::vector<std::uint8_t> memory(64U * 1024U, 0U);
  brk::bogie::module::reset_module_runtime_for_tests();
  brk::bogie::module::bind_native_linear_memory(memory.data(), memory.size());

  require(brk_abi_version() == BRK_SYNTH_ABI_VERSION, "ABI version");

  constexpr std::uint32_t kModuleOffset = 256U;
  const auto module_required = brk_module_descriptor(kModuleOffset, 0U);
  require(module_required > sizeof(brk_module_descriptor_v1), "module descriptor sizing");
  require(brk_module_descriptor(kModuleOffset, module_required) == module_required,
          "module descriptor write");
  const auto module = load<brk_module_descriptor_v1>(memory, kModuleOffset);
  require(module.engine_count == 1U, "one engine");
  require(read_string(memory, module.module_id) == "design.myldy.brk-bogie", "module id");

  constexpr std::uint32_t kEngineOffset = 768U;
  const auto engine_required = brk_engine_descriptor(0U, kEngineOffset, 0U);
  require(engine_required > sizeof(brk_engine_descriptor_v1), "engine descriptor sizing");
  require(brk_engine_descriptor(0U, kEngineOffset, engine_required) == engine_required,
          "engine descriptor write");
  const auto engine = load<brk_engine_descriptor_v1>(memory, kEngineOffset);
  require(engine.parameter_count == kParameterCount, "ABI exposes all eight parameters");
  require(engine.state_schema_version == kStateSchemaVersion, "state schema");
  require(engine.max_polyphony == kVoiceCount, "polyphony");
  require(read_string(memory, engine.engine_id) == "brk-bogie", "engine id");

  for (std::uint32_t i = 0; i < kParameterCount; ++i) {
    const std::uint32_t offset = 1280U + i * 256U;
    const auto required = brk_parameter_descriptor(0U, i, offset, 0U);
    require(required > sizeof(brk_parameter_descriptor_v1), "parameter descriptor sizing");
    require(brk_parameter_descriptor(0U, i, offset, required) == required,
            "parameter descriptor write");
    const auto descriptor = load<brk_parameter_descriptor_v1>(memory, offset);
    const auto* source = parameter_descriptor_at(i);
    require(source != nullptr, "source descriptor");
    require(descriptor.parameter_id == static_cast<std::uint32_t>(source->id),
            "parameter id");
    require(read_string(memory, descriptor.key) == source->key, "parameter key");
    require((descriptor.flags & BRK_PARAMETER_AUTOMATABLE) != 0U, "automatable");
    require((descriptor.flags & BRK_PARAMETER_HIDDEN) == 0U, "parameter visible");
  }

  constexpr std::uint32_t kCreateOffset = 4096U;
  brk_create_info create{};
  create.struct_size = sizeof(create);
  create.engine_index = 0U;
  store(memory, kCreateOffset, create);
  const auto handle_raw = brk_instance_create(0U, kCreateOffset);
  require(handle_raw > 0, "instance create");
  const auto handle = static_cast<std::uint32_t>(handle_raw);

  constexpr std::uint32_t kPrepareOffset = 4352U;
  brk_prepare_info prepare{};
  prepare.struct_size = sizeof(prepare);
  prepare.sample_rate = 48000.0;
  prepare.max_block_frames = 128U;
  prepare.max_events_per_block = 16U;
  prepare.output_channel_count = 2U;
  prepare.realtime_memory_limit_bytes = 128U * 1024U;
  store(memory, kPrepareOffset, prepare);
  require(brk_instance_prepare(handle, kPrepareOffset) == BRK_OK, "prepare");
  require(brk_instance_activate(handle) == BRK_OK, "activate");

  constexpr std::uint32_t kOutputBusOffset = 4608U;
  constexpr std::uint32_t kProcessOffset = 4864U;
  constexpr std::uint32_t kEventOffset = 5120U;
  constexpr std::uint32_t kOutputOffset = 8192U;
  constexpr std::uint32_t kFrames = 128U;
  constexpr std::uint32_t kStride = 128U;

  brk_audio_span output{};
  output.struct_size = sizeof(output);
  output.data_offset = kOutputOffset;
  output.channel_count = 2U;
  output.frame_capacity = kFrames;
  output.channel_stride_frames = kStride;
  store(memory, kOutputBusOffset, output);

  brk_note_event note{};
  note.header.size = sizeof(note);
  note.header.type = BRK_EVENT_NOTE_ON;
  note.header.frame_offset = 0U;
  note.note_id = 1U;
  note.key = 48;
  note.velocity = 1.0F;
  store(memory, kEventOffset, note);

  brk_process_info process{};
  process.struct_size = sizeof(process);
  process.frame_count = kFrames;
  process.output_bus_offset = kOutputBusOffset;
  process.event_bytes_offset = kEventOffset;
  process.event_bytes_size = sizeof(note);
  process.event_count = 1U;
  process.process_flags = BRK_PROCESS_REALTIME;
  store(memory, kProcessOffset, process);

  require(brk_instance_process(handle, kProcessOffset) == BRK_OK, "note-on process");
  require(output_energy(memory, kOutputOffset, kFrames, kStride) > 1.0e-8,
          "note-on produces audio");

  brk_param_value_event level{};
  level.header.size = sizeof(level);
  level.header.type = BRK_EVENT_PARAM_VALUE;
  level.header.frame_offset = 0U;
  level.parameter_id = static_cast<std::uint32_t>(ParamId::Level);
  level.normalized_value = 0.0F;
  level.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
  store(memory, kEventOffset, level);
  process.event_bytes_size = sizeof(level);
  process.event_count = 1U;
  store(memory, kProcessOffset, process);

  require(brk_instance_process(handle, kProcessOffset) == BRK_OK, "parameter process");
  require(output_energy(memory, kOutputOffset, kFrames, kStride) == 0.0,
          "ABI level edit affects active voice");

  require(brk_instance_deactivate(handle) == BRK_OK, "deactivate");
  require(brk_instance_state_size(handle) == kStateV1Size, "state size");

  constexpr std::uint32_t kStateOffset = 12288U;
  require(brk_instance_state_write(handle, kStateOffset, kStateV1Size) == BRK_OK,
          "state write");
  require(brk_instance_state_read(
              handle, kStateOffset, kStateV1Size, kStateSchemaVersion) == BRK_OK,
          "state round trip");

  const auto saved = memory[kStateOffset + kStateHeaderSize];
  memory[kStateOffset + kStateHeaderSize] ^= 0x01U;
  require(brk_instance_state_read(
              handle, kStateOffset, kStateV1Size, kStateSchemaVersion)
              == BRK_ERROR_INVALID_STATE,
          "corrupt state rejected");
  memory[kStateOffset + kStateHeaderSize] = saved;

  require(brk_instance_destroy(handle) == BRK_OK, "destroy");

  std::cout << "brk_bogie_p1_abi=PASS\n";
  return 0;
}

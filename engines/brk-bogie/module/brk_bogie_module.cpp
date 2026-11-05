#include "brk_bogie_module_runtime.hpp"
#include "brk_bogie/parameter_registry.hpp"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string_view>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#define BRK_ABI_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define BRK_ABI_EXPORT extern "C"
#endif

namespace brk::bogie::module {
namespace {

struct LinearMemory {
  std::uintptr_t base = 0U;
  std::size_t size = 0U;

  std::uint8_t* bytes(std::uint32_t offset, std::size_t count) const noexcept {
    if (static_cast<std::size_t>(offset) > size || count > size - offset) return nullptr;
    return reinterpret_cast<std::uint8_t*>(
        base + static_cast<std::uintptr_t>(offset));
  }

  const std::uint8_t* const_bytes(
      std::uint32_t offset, std::size_t count) const noexcept {
    return bytes(offset, count);
  }
};

#if !defined(__EMSCRIPTEN__)
LinearMemory g_native_memory{};
#endif

LinearMemory current_memory() noexcept {
#if defined(__EMSCRIPTEN__)
  return {0U, static_cast<std::size_t>(emscripten_get_heap_size())};
#else
  return g_native_memory;
#endif
}

ModuleRuntime g_runtime{};

template <class T>
bool load_struct(
    const LinearMemory& memory, std::uint32_t offset, T& value) noexcept {
  const auto* source = memory.const_bytes(offset, sizeof(T));
  if (source == nullptr) return false;
  std::memcpy(&value, source, sizeof(T));
  return true;
}

template <class T, std::size_t N>
bool all_zero(const T (&values)[N]) noexcept {
  for (const auto& value : values) {
    if (value != 0) return false;
  }
  return true;
}

bool ranges_overlap(
    std::uint32_t a, std::size_t as,
    std::uint32_t b, std::size_t bs) noexcept {
  const std::uint64_t ae = static_cast<std::uint64_t>(a) + as;
  const std::uint64_t be = static_cast<std::uint64_t>(b) + bs;
  return static_cast<std::uint64_t>(a) < be
      && static_cast<std::uint64_t>(b) < ae;
}

std::uint32_t checked_required(std::size_t size) noexcept {
  return size <= std::numeric_limits<std::uint32_t>::max()
      ? static_cast<std::uint32_t>(size)
      : 0U;
}

bool append_string(
    const LinearMemory& memory, std::uint32_t dst,
    std::size_t& cursor, std::string_view text,
    brk_string_ref& ref) noexcept {
  const std::uint64_t absolute = static_cast<std::uint64_t>(dst) + cursor;
  if (absolute > std::numeric_limits<std::uint32_t>::max()) return false;
  ref.offset = static_cast<std::uint32_t>(absolute);
  ref.byte_size = static_cast<std::uint32_t>(text.size());
  if (!text.empty()) {
    auto* destination = memory.bytes(ref.offset, text.size());
    if (destination == nullptr) return false;
    std::memcpy(destination, text.data(), text.size());
  }
  cursor += text.size();
  return true;
}

std::uint32_t abi_parameter_type(ParameterKind kind) noexcept {
  switch (kind) {
    case ParameterKind::Continuous: return BRK_PARAMETER_CONTINUOUS;
    case ParameterKind::Enum: return BRK_PARAMETER_ENUM;
  }
  return BRK_PARAMETER_CONTINUOUS;
}

std::uint32_t write_module_descriptor(
    std::uint32_t dst, std::uint32_t capacity) noexcept {
  constexpr std::string_view module_id = "design.myldy.brk-bogie";
  constexpr std::string_view display_name = "BRK BOGIE";
  constexpr std::string_view vendor_name =
      "Myldy design / Choo Choo Rack contributors";
  constexpr std::string_view license_id =
      "GPL-3.0-only";
  constexpr std::size_t required_size =
      sizeof(brk_module_descriptor_v1)
      + module_id.size() + display_name.size()
      + vendor_name.size() + license_id.size();

  const auto required = checked_required(required_size);
  if (capacity < required) return required;
  const auto memory = current_memory();
  auto* destination = memory.bytes(dst, required_size);
  if (destination == nullptr) return 0U;

  brk_module_descriptor_v1 descriptor{};
  descriptor.struct_size = sizeof(descriptor);
  descriptor.abi_min_version = BRK_SYNTH_ABI_VERSION;
  descriptor.abi_max_version = BRK_SYNTH_ABI_VERSION;
  descriptor.engine_count = 1U;

  std::size_t cursor = sizeof(descriptor);
  if (!append_string(memory, dst, cursor, module_id, descriptor.module_id)
      || !append_string(memory, dst, cursor, display_name, descriptor.display_name)
      || !append_string(memory, dst, cursor, vendor_name, descriptor.vendor_name)
      || !append_string(memory, dst, cursor, license_id, descriptor.license_id)) {
    return 0U;
  }

  std::memcpy(destination, &descriptor, sizeof(descriptor));
  return required;
}

std::uint32_t write_engine_descriptor(
    std::uint32_t engine_index, std::uint32_t dst,
    std::uint32_t capacity) noexcept {
  if (engine_index != 0U) return 0U;
  constexpr std::string_view engine_id = "brk-bogie";
  constexpr std::string_view display_name = "BRK BOGIE";
  constexpr std::size_t required_size =
      sizeof(brk_engine_descriptor_v1)
      + engine_id.size() + display_name.size();

  const auto required = checked_required(required_size);
  if (capacity < required) return required;
  const auto memory = current_memory();
  auto* destination = memory.bytes(dst, required_size);
  if (destination == nullptr) return 0U;

  brk_engine_descriptor_v1 descriptor{};
  descriptor.struct_size = sizeof(descriptor);
  descriptor.engine_index = 0U;
  descriptor.output_channel_count = 2U;
  descriptor.parameter_count = static_cast<std::uint32_t>(kParameterCount);
  descriptor.state_schema_version = kStateSchemaVersion;
  descriptor.max_polyphony = kVoiceCount;

  std::size_t cursor = sizeof(descriptor);
  if (!append_string(memory, dst, cursor, engine_id, descriptor.engine_id)
      || !append_string(
          memory, dst, cursor, display_name, descriptor.display_name)) {
    return 0U;
  }

  std::memcpy(destination, &descriptor, sizeof(descriptor));
  return required;
}

std::uint32_t write_parameter_descriptor(
    std::uint32_t engine_index, std::uint32_t index,
    std::uint32_t dst, std::uint32_t capacity) noexcept {
  if (engine_index != 0U) return 0U;
  const auto* source = parameter_descriptor_at(index);
  if (source == nullptr) return 0U;

  const std::string_view key = source->key ? source->key : "";
  const std::string_view name =
      source->display_name ? source->display_name : "";
  const std::string_view unit = source->unit ? source->unit : "";
  const std::string_view group =
      source->group_key ? source->group_key : "";

  const std::size_t required_size =
      sizeof(brk_parameter_descriptor_v1)
      + key.size() + name.size() + unit.size() + group.size();
  const auto required = checked_required(required_size);
  if (capacity < required) return required;

  const auto memory = current_memory();
  auto* destination = memory.bytes(dst, required_size);
  if (destination == nullptr) return 0U;

  brk_parameter_descriptor_v1 descriptor{};
  descriptor.struct_size = sizeof(descriptor);
  descriptor.parameter_id = static_cast<std::uint32_t>(source->id);
  descriptor.parameter_type = abi_parameter_type(source->kind);
  descriptor.flags = BRK_PARAMETER_AUTOMATABLE;
  if (source->modulation_destination) {
    descriptor.flags |= BRK_PARAMETER_MODULATABLE;
  }
  descriptor.normalized_default = source->normalized_default;
  descriptor.plain_min = source->plain_min;
  descriptor.plain_max = source->plain_max;
  descriptor.plain_step =
      source->kind == ParameterKind::Enum ? 1.0F : 0.0F;
  descriptor.enum_value_count = source->enum_value_count;

  std::size_t cursor = sizeof(descriptor);
  if (!append_string(memory, dst, cursor, key, descriptor.key)
      || !append_string(memory, dst, cursor, name, descriptor.display_name)
      || !append_string(memory, dst, cursor, unit, descriptor.unit)
      || !append_string(memory, dst, cursor, group, descriptor.group_key)) {
    return 0U;
  }

  std::memcpy(destination, &descriptor, sizeof(descriptor));
  return required;
}

}  // namespace

ModuleRuntime& module_runtime() noexcept { return g_runtime; }

void bind_native_linear_memory(void* base, std::size_t size) noexcept {
#if !defined(__EMSCRIPTEN__)
  g_native_memory = {
      reinterpret_cast<std::uintptr_t>(base), size};
#else
  static_cast<void>(base);
  static_cast<void>(size);
#endif
}

void reset_module_runtime_for_tests() noexcept { g_runtime.clear(); }

}  // namespace brk::bogie::module

BRK_ABI_EXPORT std::uint32_t brk_abi_version(void) {
  return BRK_SYNTH_ABI_VERSION;
}

BRK_ABI_EXPORT std::uint32_t brk_module_descriptor(
    std::uint32_t dst, std::uint32_t capacity) {
  return brk::bogie::module::write_module_descriptor(dst, capacity);
}

BRK_ABI_EXPORT std::uint32_t brk_engine_descriptor(
    std::uint32_t index, std::uint32_t dst, std::uint32_t capacity) {
  return brk::bogie::module::write_engine_descriptor(index, dst, capacity);
}

BRK_ABI_EXPORT std::uint32_t brk_parameter_descriptor(
    std::uint32_t engine_index, std::uint32_t parameter_index,
    std::uint32_t dst, std::uint32_t capacity) {
  return brk::bogie::module::write_parameter_descriptor(
      engine_index, parameter_index, dst, capacity);
}

BRK_ABI_EXPORT std::int32_t brk_instance_create(
    std::uint32_t engine_index, std::uint32_t create_offset) {
  using namespace brk::bogie::module;
  const auto memory = current_memory();
  brk_create_info info{};
  if (!load_struct(memory, create_offset, info)
      || info.struct_size < sizeof(info)
      || info.flags != 0U
      || info.engine_index != engine_index
      || info.reserved0 != 0U
      || !all_zero(info.reserved)) {
    return BRK_ERROR_INVALID_ARGUMENT;
  }
  return module_runtime().create(engine_index);
}

BRK_ABI_EXPORT std::int32_t brk_instance_prepare(
    std::uint32_t handle, std::uint32_t prepare_offset) {
  using namespace brk::bogie::module;
  const auto memory = current_memory();
  brk_prepare_info info{};
  if (!load_struct(memory, prepare_offset, info)
      || !all_zero(info.reserved)) {
    return BRK_ERROR_INVALID_ARGUMENT;
  }
  return module_runtime().prepare(handle, info);
}

BRK_ABI_EXPORT std::int32_t brk_instance_activate(std::uint32_t handle) {
  return brk::bogie::module::module_runtime().activate(handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_deactivate(std::uint32_t handle) {
  return brk::bogie::module::module_runtime().deactivate(handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_reset(std::uint32_t handle) {
  return brk::bogie::module::module_runtime().reset(handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_destroy(std::uint32_t handle) {
  return brk::bogie::module::module_runtime().destroy(handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_process(
    std::uint32_t handle, std::uint32_t process_offset) {
  using namespace brk::bogie::module;

  const auto memory = current_memory();
  brk_process_info process{};
  if (!load_struct(memory, process_offset, process)
      || process.struct_size < sizeof(process)
      || !all_zero(process.reserved)
      || (process.process_flags
          & ~(BRK_PROCESS_REALTIME
              | BRK_PROCESS_OFFLINE
              | BRK_PROCESS_DISCONTINUITY)) != 0U) {
    return BRK_ERROR_INVALID_ARGUMENT;
  }

  brk_audio_span output{};
  if (!load_struct(memory, process.output_bus_offset, output)
      || output.struct_size < sizeof(output)
      || output.reserved0 != 0U
      || output.channel_count != 2U
      || output.frame_capacity < process.frame_count
      || output.channel_stride_frames < process.frame_count
      || (output.data_offset % alignof(float)) != 0U) {
    return BRK_ERROR_BAD_OFFSET;
  }

  const std::uint64_t output_frames =
      static_cast<std::uint64_t>(output.channel_stride_frames)
      + process.frame_count;
  const std::uint64_t output_bytes64 =
      output_frames * sizeof(float);
  if (output_bytes64 > std::numeric_limits<std::size_t>::max()) {
    return BRK_ERROR_BAD_SIZE;
  }
  const auto output_bytes = static_cast<std::size_t>(output_bytes64);
  auto* output_data = memory.bytes(output.data_offset, output_bytes);
  if (output_data == nullptr) return BRK_ERROR_BAD_OFFSET;

  const std::uint8_t* events = nullptr;
  if (process.event_count == 0U) {
    if (process.event_bytes_size != 0U) return BRK_ERROR_BAD_SIZE;
  } else {
    events = memory.const_bytes(
        process.event_bytes_offset, process.event_bytes_size);
    if (events == nullptr) return BRK_ERROR_BAD_OFFSET;
    if (ranges_overlap(
            output.data_offset, output_bytes,
            process.event_bytes_offset, process.event_bytes_size)) {
      return BRK_ERROR_BAD_OFFSET;
    }
  }

  if (process.transport_offset != 0U) {
    brk_transport_context transport{};
    if (!load_struct(memory, process.transport_offset, transport)
        || transport.struct_size < sizeof(transport)
        || !all_zero(transport.reserved)
        || !std::isfinite(transport.tempo_bpm)
        || !std::isfinite(transport.song_position_beats)) {
      return BRK_ERROR_BAD_OFFSET;
    }
  }

  auto* left = reinterpret_cast<float*>(output_data);
  auto* right = left + output.channel_stride_frames;
  return module_runtime().process(
      handle, left, right, process.frame_count,
      events, process.event_bytes_size, process.event_count);
}

BRK_ABI_EXPORT std::uint32_t brk_instance_state_size(
    std::uint32_t handle) {
  return brk::bogie::module::module_runtime().state_size(handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_state_write(
    std::uint32_t handle, std::uint32_t dst,
    std::uint32_t capacity) {
  using namespace brk::bogie::module;
  const auto memory = current_memory();
  auto* destination = memory.bytes(dst, capacity);
  if (destination == nullptr) return BRK_ERROR_BAD_OFFSET;
  return module_runtime().state_write(handle, destination, capacity);
}

BRK_ABI_EXPORT std::int32_t brk_instance_state_read(
    std::uint32_t handle, std::uint32_t src,
    std::uint32_t size, std::uint32_t schema) {
  using namespace brk::bogie::module;
  const auto memory = current_memory();
  const auto* source = memory.const_bytes(src, size);
  if (source == nullptr) return BRK_ERROR_BAD_OFFSET;
  return module_runtime().state_read(
      handle, source, size, schema);
}

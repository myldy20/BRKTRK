#include "brk_modal_module_runtime.hpp"

#include <array>
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

namespace brk::modal::abi {

namespace runtime_policy {
std::int32_t state_write_if_managed(brk_instance_handle handle,
                                    std::uint8_t* destination,
                                    std::size_t capacity,
                                    bool& handled) noexcept;
std::int32_t state_read_committed(brk_instance_handle handle) noexcept;
} // namespace runtime_policy

namespace {

struct LinearMemory {
    std::uintptr_t base = 0U;
    std::size_t size = 0U;

    std::uint8_t* bytes(std::uint32_t offset, std::size_t byte_size) const noexcept {
        if (static_cast<std::size_t>(offset) > size || byte_size > size - offset) return nullptr;
        return reinterpret_cast<std::uint8_t*>(base + static_cast<std::uintptr_t>(offset));
    }

    const std::uint8_t* const_bytes(std::uint32_t offset, std::size_t byte_size) const noexcept {
        return bytes(offset, byte_size);
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

template <typename T>
bool load_struct(const LinearMemory& memory, std::uint32_t offset, T& value) noexcept {
    const auto* source = memory.const_bytes(offset, sizeof(T));
    if (source == nullptr) return false;
    std::memcpy(&value, source, sizeof(T));
    return true;
}

template <typename T, std::size_t N>
bool all_zero(const T (&values)[N]) noexcept {
    for (const auto& value : values) if (value != 0) return false;
    return true;
}

bool ranges_overlap(std::uint32_t first_offset, std::size_t first_size,
                    std::uint32_t second_offset, std::size_t second_size) noexcept {
    const std::uint64_t first_end = static_cast<std::uint64_t>(first_offset) + first_size;
    const std::uint64_t second_end = static_cast<std::uint64_t>(second_offset) + second_size;
    return static_cast<std::uint64_t>(first_offset) < second_end
        && static_cast<std::uint64_t>(second_offset) < first_end;
}

std::uint32_t checked_required(std::size_t size) noexcept {
    return size <= std::numeric_limits<std::uint32_t>::max()
        ? static_cast<std::uint32_t>(size) : 0U;
}

bool append_string(const LinearMemory& memory,
                   std::uint32_t destination_offset,
                   std::size_t& cursor,
                   std::string_view text,
                   brk_string_ref& reference) noexcept {
    const std::uint64_t absolute = static_cast<std::uint64_t>(destination_offset) + cursor;
    if (absolute > std::numeric_limits<std::uint32_t>::max()) return false;
    reference.offset = static_cast<std::uint32_t>(absolute);
    reference.byte_size = static_cast<std::uint32_t>(text.size());
    if (!text.empty()) {
        auto* destination = memory.bytes(reference.offset, text.size());
        if (destination == nullptr) return false;
        std::memcpy(destination, text.data(), text.size());
    }
    cursor += text.size();
    return true;
}

std::uint32_t write_module_descriptor(std::uint32_t destination_offset,
                                      std::uint32_t destination_capacity) noexcept {
    constexpr std::string_view module_id = "design.myldy.brk-modal";
    constexpr std::string_view display_name = "BRK Modal";
    constexpr std::string_view vendor_name = "Myldy design / Ilya Tolstoukhov";
    constexpr std::string_view license_id = "GPL-3.0-only";
    constexpr std::size_t required_size = sizeof(brk_module_descriptor_v1)
        + module_id.size() + display_name.size() + vendor_name.size() + license_id.size();
    const auto required = checked_required(required_size);
    if (destination_capacity < required) return required;

    const auto memory = current_memory();
    auto* destination = memory.bytes(destination_offset, required_size);
    if (destination == nullptr) return 0U;

    brk_module_descriptor_v1 descriptor{};
    descriptor.struct_size = sizeof(descriptor);
    descriptor.abi_min_version = BRK_SYNTH_ABI_VERSION;
    descriptor.abi_max_version = BRK_SYNTH_ABI_VERSION;
    descriptor.engine_count = 1U;
    std::size_t cursor = sizeof(descriptor);
    if (!append_string(memory, destination_offset, cursor, module_id, descriptor.module_id)
        || !append_string(memory, destination_offset, cursor, display_name, descriptor.display_name)
        || !append_string(memory, destination_offset, cursor, vendor_name, descriptor.vendor_name)
        || !append_string(memory, destination_offset, cursor, license_id, descriptor.license_id)) return 0U;
    std::memcpy(destination, &descriptor, sizeof(descriptor));
    return required;
}

std::uint32_t write_engine_descriptor(std::uint32_t engine_index,
                                      std::uint32_t destination_offset,
                                      std::uint32_t destination_capacity) noexcept {
    if (engine_index != 0U) return 0U;
    constexpr std::string_view engine_id = "brk-modal";
    constexpr std::string_view display_name = "BRK Modal";
    constexpr std::size_t required_size = sizeof(brk_engine_descriptor_v1)
        + engine_id.size() + display_name.size();
    const auto required = checked_required(required_size);
    if (destination_capacity < required) return required;

    const auto memory = current_memory();
    auto* destination = memory.bytes(destination_offset, required_size);
    if (destination == nullptr) return 0U;

    brk_engine_descriptor_v1 descriptor{};
    descriptor.struct_size = sizeof(descriptor);
    descriptor.engine_index = 0U;
    descriptor.output_channel_count = 2U;
    descriptor.parameter_count = static_cast<std::uint32_t>(kParameterDescriptorCount);
    descriptor.state_schema_version = kStateSchemaVersionV1;
    descriptor.max_polyphony = static_cast<std::uint32_t>(kMaxVoices);
    std::size_t cursor = sizeof(descriptor);
    if (!append_string(memory, destination_offset, cursor, engine_id, descriptor.engine_id)
        || !append_string(memory, destination_offset, cursor, display_name, descriptor.display_name)) return 0U;
    std::memcpy(destination, &descriptor, sizeof(descriptor));
    return required;
}

std::uint32_t write_parameter_descriptor(std::uint32_t engine_index,
                                         std::uint32_t parameter_index,
                                         std::uint32_t destination_offset,
                                         std::uint32_t destination_capacity) noexcept {
    if (engine_index != 0U) return 0U;
    const auto* source = parameter_descriptor_at(parameter_index);
    if (source == nullptr) return 0U;
    const std::string_view key = source->key == nullptr ? "" : source->key;
    const std::string_view display_name = source->display_name == nullptr ? "" : source->display_name;
    const std::string_view unit = source->unit == nullptr ? "" : source->unit;
    const std::string_view group_key = source->group_key == nullptr ? "" : source->group_key;
    const std::size_t required_size = sizeof(brk_parameter_descriptor_v1)
        + key.size() + display_name.size() + unit.size() + group_key.size();
    const auto required = checked_required(required_size);
    if (destination_capacity < required) return required;

    const auto memory = current_memory();
    auto* destination = memory.bytes(destination_offset, required_size);
    if (destination == nullptr) return 0U;

    brk_parameter_descriptor_v1 descriptor{};
    descriptor.struct_size = sizeof(descriptor);
    descriptor.parameter_id = static_cast<std::uint32_t>(source->id);
    descriptor.parameter_type = static_cast<std::uint32_t>(source->type);
    descriptor.flags = source->flags;
    descriptor.normalized_default = parameter_default_normalized(*source);
    descriptor.plain_min = source->plain_min;
    descriptor.plain_max = source->plain_max;
    descriptor.plain_step = source->plain_step;
    descriptor.enum_value_count = source->enum_value_count;
    std::size_t cursor = sizeof(descriptor);
    if (!append_string(memory, destination_offset, cursor, key, descriptor.key)
        || !append_string(memory, destination_offset, cursor, display_name, descriptor.display_name)
        || !append_string(memory, destination_offset, cursor, unit, descriptor.unit)
        || !append_string(memory, destination_offset, cursor, group_key, descriptor.group_key)) return 0U;
    std::memcpy(destination, &descriptor, sizeof(descriptor));
    return required;
}

} // namespace

ModuleRuntime& module_runtime() noexcept { return g_runtime; }

void bind_native_linear_memory(void* base, std::size_t size) noexcept {
#if !defined(__EMSCRIPTEN__)
    g_native_memory = {reinterpret_cast<std::uintptr_t>(base), size};
#else
    static_cast<void>(base);
    static_cast<void>(size);
#endif
}

void reset_module_runtime_for_tests() noexcept { g_runtime.clear(); }

} // namespace brk::modal::abi

BRK_ABI_EXPORT std::uint32_t brk_abi_version(void) {
    return BRK_SYNTH_ABI_VERSION;
}

BRK_ABI_EXPORT std::uint32_t brk_module_descriptor(std::uint32_t dst_offset,
                                                   std::uint32_t dst_capacity) {
    return brk::modal::abi::write_module_descriptor(dst_offset, dst_capacity);
}

BRK_ABI_EXPORT std::uint32_t brk_engine_descriptor(std::uint32_t engine_index,
                                                   std::uint32_t dst_offset,
                                                   std::uint32_t dst_capacity) {
    return brk::modal::abi::write_engine_descriptor(engine_index, dst_offset, dst_capacity);
}

BRK_ABI_EXPORT std::uint32_t brk_parameter_descriptor(std::uint32_t engine_index,
                                                      std::uint32_t parameter_index,
                                                      std::uint32_t dst_offset,
                                                      std::uint32_t dst_capacity) {
    return brk::modal::abi::write_parameter_descriptor(
        engine_index, parameter_index, dst_offset, dst_capacity);
}

BRK_ABI_EXPORT std::int32_t brk_instance_create(std::uint32_t engine_index,
                                                std::uint32_t create_info_offset) {
    using namespace brk::modal::abi;
    const auto memory = current_memory();
    brk_create_info info{};
    if (!load_struct(memory, create_info_offset, info)
        || info.struct_size < sizeof(info) || info.flags != 0U
        || info.engine_index != engine_index || info.reserved0 != 0U
        || !all_zero(info.reserved)) return BRK_ERROR_INVALID_ARGUMENT;
    return module_runtime().create(engine_index);
}

BRK_ABI_EXPORT std::int32_t brk_instance_prepare(std::uint32_t instance_handle,
                                                 std::uint32_t prepare_info_offset) {
    using namespace brk::modal::abi;
    const auto memory = current_memory();
    brk_prepare_info info{};
    if (!load_struct(memory, prepare_info_offset, info) || !all_zero(info.reserved)) {
        return BRK_ERROR_INVALID_ARGUMENT;
    }
    return module_runtime().prepare(instance_handle, info);
}

BRK_ABI_EXPORT std::int32_t brk_instance_activate(std::uint32_t instance_handle) {
    return brk::modal::abi::module_runtime().activate(instance_handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_deactivate(std::uint32_t instance_handle) {
    return brk::modal::abi::module_runtime().deactivate(instance_handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_reset(std::uint32_t instance_handle) {
    return brk::modal::abi::module_runtime().reset(instance_handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_destroy(std::uint32_t instance_handle) {
    return brk::modal::abi::module_runtime().destroy(instance_handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_process(std::uint32_t instance_handle,
                                                 std::uint32_t process_info_offset) {
    using namespace brk::modal::abi;
    const auto memory = current_memory();
    brk_process_info process{};
    if (!load_struct(memory, process_info_offset, process)
        || process.struct_size < sizeof(process) || !all_zero(process.reserved)
        || (process.process_flags & ~(BRK_PROCESS_REALTIME | BRK_PROCESS_OFFLINE
                                     | BRK_PROCESS_DISCONTINUITY)) != 0U) {
        return BRK_ERROR_INVALID_ARGUMENT;
    }

    brk_audio_span output{};
    if (!load_struct(memory, process.output_bus_offset, output)
        || output.struct_size < sizeof(output) || output.reserved0 != 0U
        || output.channel_count != 2U || output.frame_capacity < process.frame_count
        || output.channel_stride_frames < process.frame_count
        || (output.data_offset % alignof(float)) != 0U) return BRK_ERROR_BAD_OFFSET;

    const std::uint64_t output_frames = static_cast<std::uint64_t>(output.channel_stride_frames)
        + process.frame_count;
    const std::uint64_t output_bytes_64 = output_frames * sizeof(float);
    if (output_bytes_64 > std::numeric_limits<std::size_t>::max()) return BRK_ERROR_BAD_SIZE;
    const auto output_bytes = static_cast<std::size_t>(output_bytes_64);
    auto* output_data = memory.bytes(output.data_offset, output_bytes);
    if (output_data == nullptr) return BRK_ERROR_BAD_OFFSET;

    const std::uint8_t* events = nullptr;
    if (process.event_count == 0U) {
        if (process.event_bytes_size != 0U) return BRK_ERROR_BAD_SIZE;
    } else {
        events = memory.const_bytes(process.event_bytes_offset, process.event_bytes_size);
        if (events == nullptr) return BRK_ERROR_BAD_OFFSET;
        if (ranges_overlap(output.data_offset, output_bytes,
                           process.event_bytes_offset, process.event_bytes_size)) {
            return BRK_ERROR_BAD_OFFSET;
        }
    }

    if (process.transport_offset != 0U) {
        brk_transport_context transport{};
        if (!load_struct(memory, process.transport_offset, transport)
            || transport.struct_size < sizeof(transport) || !all_zero(transport.reserved)
            || !std::isfinite(transport.tempo_bpm)
            || !std::isfinite(transport.song_position_beats)) return BRK_ERROR_BAD_OFFSET;
    }

    auto* left = reinterpret_cast<float*>(output_data);
    auto* right = left + output.channel_stride_frames;
    return module_runtime().process(instance_handle, left, right, process.frame_count,
                                    events, process.event_bytes_size, process.event_count);
}

BRK_ABI_EXPORT std::uint32_t brk_instance_state_size(std::uint32_t instance_handle) {
    return brk::modal::abi::module_runtime().state_size(instance_handle);
}

BRK_ABI_EXPORT std::int32_t brk_instance_state_write(std::uint32_t instance_handle,
                                                     std::uint32_t dst_offset,
                                                     std::uint32_t dst_capacity) {
    using namespace brk::modal::abi;
    const auto memory = current_memory();
    auto* destination = memory.bytes(dst_offset, dst_capacity);
    if (destination == nullptr) return BRK_ERROR_BAD_OFFSET;
    bool handled = false;
    const auto policy_result = runtime_policy::state_write_if_managed(
        instance_handle, destination, dst_capacity, handled);
    if (handled || policy_result != BRK_OK) return policy_result;
    return module_runtime().state_write(instance_handle, destination, dst_capacity);
}

BRK_ABI_EXPORT std::int32_t brk_instance_state_read(std::uint32_t instance_handle,
                                                    std::uint32_t src_offset,
                                                    std::uint32_t src_size,
                                                    std::uint32_t schema_version) {
    using namespace brk::modal::abi;
    const auto memory = current_memory();
    const auto* source = memory.const_bytes(src_offset, src_size);
    if (source == nullptr) return BRK_ERROR_BAD_OFFSET;
    const auto result = module_runtime().state_read(instance_handle, source, src_size, schema_version);
    if (result != BRK_OK) return result;
    return runtime_policy::state_read_committed(instance_handle);
}

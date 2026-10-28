#include "brk_modal_module_runtime.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <new>
#include <string>
#include <vector>

namespace {

bool g_track_allocations = false;
std::size_t g_allocation_count = 0U;

constexpr std::uint32_t kCreateOffset = 0x1000U;
constexpr std::uint32_t kPrepareOffset = 0x1100U;
constexpr std::uint32_t kProcessOffset = 0x1200U;
constexpr std::uint32_t kAudioSpanOffset = 0x1300U;
constexpr std::uint32_t kEventOffset = 0x2000U;
constexpr std::uint32_t kAudioOffset = 0x4000U;
constexpr std::uint32_t kStateOffset = 0x10000U;
constexpr std::uint32_t kDescriptorOffset = 0x12000U;
constexpr std::size_t kMemoryBytes = 2U * 1024U * 1024U;
constexpr std::uint32_t kFrames = 64U;

void* counted_allocate(std::size_t size) {
    if (g_track_allocations) ++g_allocation_count;
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}

template <typename T>
void store(std::vector<std::uint8_t>& memory, std::uint32_t offset, const T& value) {
    std::memcpy(memory.data() + offset, &value, sizeof(value));
}

template <typename T>
T load(const std::vector<std::uint8_t>& memory, std::uint32_t offset) {
    T value{};
    std::memcpy(&value, memory.data() + offset, sizeof(value));
    return value;
}

std::string read_string(const std::vector<std::uint8_t>& memory, brk_string_ref ref) {
    return std::string(reinterpret_cast<const char*>(memory.data() + ref.offset), ref.byte_size);
}

brk_event_header event_header(std::uint16_t type, std::uint16_t size, std::uint32_t frame) {
    brk_event_header header{};
    header.type = type;
    header.size = size;
    header.frame_offset = frame;
    return header;
}

template <typename T>
void append_event(std::vector<std::uint8_t>& bytes, const T& event) {
    const auto* source = reinterpret_cast<const std::uint8_t*>(&event);
    bytes.insert(bytes.end(), source, source + sizeof(event));
}

brk_note_event note(std::uint16_t type, std::uint32_t frame, std::uint32_t note_id,
                    std::int16_t key = 0, float velocity = 0.0F, float tuning = 0.0F) {
    brk_note_event event{};
    event.header = event_header(type, sizeof(event), frame);
    event.note_id = note_id;
    event.key = key;
    event.channel = -1;
    event.velocity = velocity;
    event.tuning_semitones = tuning;
    return event;
}

brk_param_value_event value_event(std::uint32_t frame, brk::modal::ParameterId id, float value) {
    brk_param_value_event event{};
    event.header = event_header(BRK_EVENT_PARAM_VALUE, sizeof(event), frame);
    event.parameter_id = static_cast<std::uint32_t>(id);
    event.normalized_value = value;
    event.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    return event;
}

brk_param_ramp_event ramp_event(std::uint32_t frame, brk::modal::ParameterId id,
                                float start, float end, std::uint32_t duration) {
    brk_param_ramp_event event{};
    event.header = event_header(BRK_EVENT_PARAM_RAMP, sizeof(event), frame);
    event.parameter_id = static_cast<std::uint32_t>(id);
    event.start_normalized = start;
    event.end_normalized = end;
    event.duration_frames = duration;
    event.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    return event;
}

brk_prepare_info prepare_info(std::uint64_t seed) {
    brk_prepare_info info{};
    info.struct_size = sizeof(info);
    info.sample_rate = 48000.0;
    info.max_block_frames = kFrames;
    info.max_events_per_block = 32U;
    info.output_channel_count = 2U;
    info.realtime_memory_limit_bytes = brk::modal::abi::kRealtimeMemoryEstimateBytes;
    info.deterministic_seed_lo = static_cast<std::uint32_t>(seed);
    info.deterministic_seed_hi = static_cast<std::uint32_t>(seed >> 32U);
    return info;
}

std::int32_t process_block(std::vector<std::uint8_t>& memory,
                           brk_instance_handle handle,
                           const std::vector<std::uint8_t>& events,
                           std::uint32_t event_count,
                           std::array<float, kFrames>& left,
                           std::array<float, kFrames>& right) {
    std::fill(memory.begin() + kAudioOffset,
              memory.begin() + kAudioOffset + 2U * kFrames * sizeof(float), 0U);
    if (!events.empty()) std::memcpy(memory.data() + kEventOffset, events.data(), events.size());

    brk_audio_span audio{};
    audio.struct_size = sizeof(audio);
    audio.data_offset = kAudioOffset;
    audio.channel_count = 2U;
    audio.frame_capacity = kFrames;
    audio.channel_stride_frames = kFrames;
    store(memory, kAudioSpanOffset, audio);

    brk_process_info process{};
    process.struct_size = sizeof(process);
    process.frame_count = kFrames;
    process.output_bus_offset = kAudioSpanOffset;
    process.event_bytes_offset = kEventOffset;
    process.event_bytes_size = static_cast<std::uint32_t>(events.size());
    process.event_count = event_count;
    process.process_flags = BRK_PROCESS_REALTIME;
    store(memory, kProcessOffset, process);

    const auto result = brk_instance_process(handle, kProcessOffset);
    if (result == BRK_OK) {
        std::memcpy(left.data(), memory.data() + kAudioOffset, kFrames * sizeof(float));
        std::memcpy(right.data(), memory.data() + kAudioOffset + kFrames * sizeof(float),
                    kFrames * sizeof(float));
    }
    return result;
}

bool finite_and_audible(const std::array<float, kFrames>& left,
                        const std::array<float, kFrames>& right) {
    bool audible = false;
    for (std::size_t i = 0U; i < left.size(); ++i) {
        if (!std::isfinite(left[i]) || !std::isfinite(right[i])) return false;
        audible = audible || std::abs(left[i]) > 1.0e-8F || std::abs(right[i]) > 1.0e-8F;
    }
    return audible;
}

void write_golden(const std::string& path,
                  const std::array<std::array<float, kFrames>, 3>& left,
                  const std::array<std::array<float, kFrames>, 3>& right) {
    if (path.empty()) return;
    std::ofstream output(path, std::ios::binary);
    const std::array<std::uint32_t, 4> header{0x474b5242U, 3U * kFrames, 2U, 0U};
    output.write(reinterpret_cast<const char*>(header.data()), sizeof(header));
    for (std::size_t block = 0U; block < left.size(); ++block) {
        for (std::size_t frame = 0U; frame < kFrames; ++frame) {
            output.write(reinterpret_cast<const char*>(&left[block][frame]), sizeof(float));
            output.write(reinterpret_cast<const char*>(&right[block][frame]), sizeof(float));
        }
    }
}

} // namespace

void* operator new(std::size_t size) { return counted_allocate(size); }
void* operator new[](std::size_t size) { return counted_allocate(size); }
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main(int argc, char** argv) {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    std::vector<std::uint8_t> memory(kMemoryBytes);
    bind_native_linear_memory(memory.data(), memory.size());
    reset_module_runtime_for_tests();

    if (brk_abi_version() != BRK_SYNTH_ABI_VERSION) return 1;

    const auto module_required = brk_module_descriptor(0U, 0U);
    if (module_required <= sizeof(brk_module_descriptor_v1)
        || brk_module_descriptor(kDescriptorOffset, module_required) != module_required) return 2;
    const auto module = load<brk_module_descriptor_v1>(memory, kDescriptorOffset);
    if (module.engine_count != 1U || read_string(memory, module.module_id) != "design.myldy.brk-modal"
        || read_string(memory, module.license_id) != "GPL-3.0-only") return 3;

    const auto engine_required = brk_engine_descriptor(0U, 0U, 0U);
    if (engine_required == 0U
        || brk_engine_descriptor(0U, kDescriptorOffset, engine_required) != engine_required) return 4;
    const auto engine_descriptor = load<brk_engine_descriptor_v1>(memory, kDescriptorOffset);
    if (engine_descriptor.parameter_count != 89U || engine_descriptor.max_polyphony != 16U
        || engine_descriptor.state_schema_version != kStateSchemaVersionV1) return 5;

    const auto parameter_required = brk_parameter_descriptor(0U, 3U, 0U, 0U);
    if (parameter_required == 0U
        || brk_parameter_descriptor(0U, 3U, kDescriptorOffset, parameter_required) != parameter_required) return 6;
    const auto parameter_descriptor = load<brk_parameter_descriptor_v1>(memory, kDescriptorOffset);
    if (parameter_descriptor.parameter_id != static_cast<std::uint32_t>(ParameterId::ResonatorGainDb)
        || read_string(memory, parameter_descriptor.key) != "gain") return 7;
    if (brk_parameter_descriptor(0U, 89U, kDescriptorOffset, 256U) != 0U
        || brk_module_descriptor(static_cast<std::uint32_t>(memory.size() - 4U), module_required) != 0U) return 8;

    brk_create_info create{};
    create.struct_size = sizeof(create);
    create.engine_index = 0U;
    store(memory, kCreateOffset, create);
    const auto first = brk_instance_create(0U, kCreateOffset);
    const auto second = brk_instance_create(0U, kCreateOffset);
    if (first <= 0 || second <= 0 || first == second) return 9;

    std::array<float, kFrames> scratch_left{};
    std::array<float, kFrames> scratch_right{};
    if (process_block(memory, static_cast<brk_instance_handle>(first), {}, 0U,
                      scratch_left, scratch_right) != BRK_ERROR_NOT_PREPARED) return 10;
    if (brk_instance_activate(static_cast<brk_instance_handle>(first)) != BRK_ERROR_NOT_PREPARED) return 11;

    const auto first_prepare = prepare_info(0x50344d4f44554c45ULL);
    const auto second_prepare = prepare_info(0x50344d4f44554c46ULL);
    store(memory, kPrepareOffset, first_prepare);
    if (brk_instance_prepare(static_cast<brk_instance_handle>(first), kPrepareOffset) != BRK_OK) return 12;
    store(memory, kPrepareOffset, second_prepare);
    if (brk_instance_prepare(static_cast<brk_instance_handle>(second), kPrepareOffset) != BRK_OK) return 13;

    std::array<std::uint8_t, kStateV1Size> initial_state{};
    if (!write_state_v1(make_factory_patch(FactoryPatch::GlassString),
                        initial_state.data(), initial_state.size())) return 14;
    std::memcpy(memory.data() + kStateOffset, initial_state.data(), initial_state.size());
    if (brk_instance_state_read(static_cast<brk_instance_handle>(first), kStateOffset,
                                static_cast<std::uint32_t>(initial_state.size()),
                                kStateSchemaVersionV1) != BRK_OK) return 15;
    if (brk_instance_state_size(static_cast<brk_instance_handle>(first)) != kStateV1Size) return 16;

    if (brk_instance_activate(static_cast<brk_instance_handle>(first)) != BRK_OK
        || brk_instance_activate(static_cast<brk_instance_handle>(second)) != BRK_OK) return 17;
    if (brk_instance_destroy(static_cast<brk_instance_handle>(first)) != BRK_ERROR_ALREADY_ACTIVE) return 18;

    std::vector<std::uint8_t> block0_events;
    append_event(block0_events, value_event(0U, ParameterId::ADecaySeconds, 0.4F));
    append_event(block0_events, note(BRK_EVENT_NOTE_ON, 0U, 1U, 52, 0.72F, 0.0F));
    append_event(block0_events, ramp_event(13U, ParameterId::OutputGainDb, 0.2F, 0.8F, 96U));
    std::vector<std::uint8_t> block2_events;
    append_event(block2_events, note(BRK_EVENT_NOTE_OFF, 10U, 1U));

    std::array<std::array<float, kFrames>, 3> first_left{};
    std::array<std::array<float, kFrames>, 3> first_right{};
    g_allocation_count = 0U;
    g_track_allocations = true;
    const auto block0_result = process_block(memory, static_cast<brk_instance_handle>(first),
                                             block0_events, 3U, first_left[0], first_right[0]);
    const auto ramps_after_first = module_runtime().active_ramp_count(first);
    const auto block1_result = process_block(memory, static_cast<brk_instance_handle>(first),
                                             {}, 0U, first_left[1], first_right[1]);
    const auto block2_result = process_block(memory, static_cast<brk_instance_handle>(first),
                                             block2_events, 1U, first_left[2], first_right[2]);
    g_track_allocations = false;
    if (block0_result != BRK_OK || block1_result != BRK_OK || block2_result != BRK_OK
        || ramps_after_first != 1U || module_runtime().active_ramp_count(first) != 0U) return 19;
    if (g_allocation_count != 0U) return 20;
    if (!finite_and_audible(first_left[0], first_right[0])) return 21;

    std::vector<std::uint8_t> second_events;
    append_event(second_events, note(BRK_EVENT_NOTE_ON, 0U, 2U, 67, 0.55F, 0.0F));
    std::array<float, kFrames> second_left{};
    std::array<float, kFrames> second_right{};
    if (process_block(memory, static_cast<brk_instance_handle>(second), second_events, 1U,
                      second_left, second_right) != BRK_OK
        || !finite_and_audible(second_left, second_right)) return 22;
    bool different = false;
    for (std::size_t i = 0U; i < kFrames; ++i) {
        different = different || first_left[0][i] != second_left[i] || first_right[0][i] != second_right[i];
    }
    if (!different) return 23;

    if (brk_instance_state_write(static_cast<brk_instance_handle>(first), kStateOffset,
                                 static_cast<std::uint32_t>(kStateV1Size)) != BRK_OK) return 24;
    const auto written_magic = load<std::uint32_t>(memory, kStateOffset);
    if (written_magic != kStateMagic) return 25;
    if (brk_instance_state_read(static_cast<brk_instance_handle>(first), kStateOffset,
                                static_cast<std::uint32_t>(kStateV1Size),
                                kStateSchemaVersionV1) != BRK_ERROR_ALREADY_ACTIVE) return 26;

    brk_process_info bad_process{};
    bad_process.struct_size = sizeof(bad_process);
    bad_process.frame_count = kFrames;
    bad_process.output_bus_offset = static_cast<std::uint32_t>(memory.size() - 2U);
    store(memory, kProcessOffset, bad_process);
    if (brk_instance_process(static_cast<brk_instance_handle>(first), kProcessOffset) != BRK_ERROR_BAD_OFFSET) return 27;

    if (brk_instance_deactivate(static_cast<brk_instance_handle>(first)) != BRK_OK
        || brk_instance_deactivate(static_cast<brk_instance_handle>(second)) != BRK_OK) return 28;
    if (brk_instance_destroy(static_cast<brk_instance_handle>(second)) != BRK_OK) return 29;
    if (brk_instance_reset(static_cast<brk_instance_handle>(second)) != BRK_ERROR_INVALID_ARGUMENT) return 30;
    if (brk_instance_destroy(static_cast<brk_instance_handle>(first)) != BRK_OK) return 31;

    const std::string golden = argc > 1 ? argv[1] : "";
    write_golden(golden, first_left, first_right);
    std::cout << "module_instances=2\n";
    std::cout << "persistent_ramp_blocks=2\n";
    std::cout << "post_activate_allocations=" << g_allocation_count << '\n';
    std::cout << "golden_frames=" << 3U * kFrames << '\n';
    return 0;
}

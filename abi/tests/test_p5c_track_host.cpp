// Copyright © 2026 Myldy design / Ilya Tolstoukhov
// SPDX-License-Identifier: GPL-3.0-only

#include "brk_modal_module_runtime.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

namespace {

constexpr std::uint32_t kCreateOffset = 0x1000U;
constexpr std::uint32_t kPrepareOffset = 0x1100U;
constexpr std::uint32_t kProcessOffset = 0x1200U;
constexpr std::uint32_t kAudioSpanOffset = 0x1300U;
constexpr std::uint32_t kEventOffset = 0x2000U;
constexpr std::uint32_t kAudioOffset = 0x4000U;
constexpr std::uint32_t kStateOffset = 0x10000U;
constexpr std::size_t kMemoryBytes = 2U * 1024U * 1024U;
constexpr std::uint32_t kFrames = 128U;

template <typename T>
void store(std::vector<std::uint8_t>& memory, std::uint32_t offset, const T& value) {
    std::memcpy(memory.data() + offset, &value, sizeof(value));
}

template <typename T>
void append_event(std::vector<std::uint8_t>& bytes, const T& event) {
    const auto* source = reinterpret_cast<const std::uint8_t*>(&event);
    bytes.insert(bytes.end(), source, source + sizeof(event));
}

brk_note_event note_on(std::uint32_t note_id, std::int16_t key, float velocity) {
    brk_note_event event{};
    event.header.type = BRK_EVENT_NOTE_ON;
    event.header.size = sizeof(event);
    event.header.frame_offset = 0U;
    event.note_id = note_id;
    event.key = key;
    event.channel = -1;
    event.velocity = velocity;
    return event;
}

brk_prepare_info prepare_info(std::uint32_t seed_lo) {
    brk_prepare_info info{};
    info.struct_size = sizeof(info);
    info.sample_rate = 48000.0;
    info.max_block_frames = kFrames;
    info.max_events_per_block = 16U;
    info.output_channel_count = 2U;
    info.realtime_memory_limit_bytes = brk::modal::abi::kRealtimeMemoryEstimateBytes;
    info.deterministic_seed_lo = seed_lo;
    info.deterministic_seed_hi = 0x50344d4fU;
    return info;
}

std::int32_t process_block(std::vector<std::uint8_t>& memory,
                           brk_instance_handle handle,
                           const std::vector<std::uint8_t>& events,
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
    process.event_count = events.empty() ? 0U : 1U;
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
    for (std::size_t frame = 0U; frame < left.size(); ++frame) {
        if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])) return false;
        audible = audible || std::abs(left[frame]) > 1.0e-8F || std::abs(right[frame]) > 1.0e-8F;
    }
    return audible;
}

} // namespace

int main() {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    std::vector<std::uint8_t> memory(kMemoryBytes);
    bind_native_linear_memory(memory.data(), memory.size());
    reset_module_runtime_for_tests();

    brk_create_info create{};
    create.struct_size = sizeof(create);
    create.engine_index = 0U;
    store(memory, kCreateOffset, create);
    const auto first = brk_instance_create(0U, kCreateOffset);
    const auto second = brk_instance_create(0U, kCreateOffset);
    if (first <= 0 || second <= 0 || first == second) return 1;

    const auto first_prepare = prepare_info(0x44554c45U);
    const auto second_prepare = prepare_info(0x44554c46U);
    store(memory, kPrepareOffset, first_prepare);
    if (brk_instance_prepare(static_cast<brk_instance_handle>(first), kPrepareOffset) != BRK_OK) return 2;
    store(memory, kPrepareOffset, second_prepare);
    if (brk_instance_prepare(static_cast<brk_instance_handle>(second), kPrepareOffset) != BRK_OK) return 3;

    std::array<std::uint8_t, kStateV1Size> shared_patch{};
    if (!write_state_v1(make_factory_patch(FactoryPatch::GlassString),
                        shared_patch.data(), shared_patch.size())) return 4;
    std::memcpy(memory.data() + kStateOffset, shared_patch.data(), shared_patch.size());
    if (brk_instance_state_read(static_cast<brk_instance_handle>(first), kStateOffset,
                                static_cast<std::uint32_t>(shared_patch.size()),
                                kStateSchemaVersionV1) != BRK_OK) return 5;
    if (brk_instance_state_read(static_cast<brk_instance_handle>(second), kStateOffset,
                                static_cast<std::uint32_t>(shared_patch.size()),
                                kStateSchemaVersionV1) != BRK_OK) return 6;

    if (brk_instance_activate(static_cast<brk_instance_handle>(first)) != BRK_OK
        || brk_instance_activate(static_cast<brk_instance_handle>(second)) != BRK_OK) return 7;

    std::vector<std::uint8_t> first_events;
    std::vector<std::uint8_t> second_events;
    append_event(first_events, note_on(1001U, 52, 0.72F));
    append_event(second_events, note_on(2001U, 67, 0.55F));

    std::array<float, kFrames> first_left{};
    std::array<float, kFrames> first_right{};
    std::array<float, kFrames> second_left{};
    std::array<float, kFrames> second_right{};
    if (process_block(memory, static_cast<brk_instance_handle>(first), first_events,
                      first_left, first_right) != BRK_OK) return 8;
    if (process_block(memory, static_cast<brk_instance_handle>(second), second_events,
                      second_left, second_right) != BRK_OK) return 9;
    if (!finite_and_audible(first_left, first_right)
        || !finite_and_audible(second_left, second_right)) return 10;

    bool performers_differ = false;
    float track_peak = 0.0F;
    for (std::size_t frame = 0U; frame < kFrames; ++frame) {
        performers_differ = performers_differ
            || first_left[frame] != second_left[frame]
            || first_right[frame] != second_right[frame];
        const float track_left = first_left[frame] + second_left[frame];
        const float track_right = first_right[frame] + second_right[frame];
        if (!std::isfinite(track_left) || !std::isfinite(track_right)) return 11;
        track_peak = std::max(track_peak, std::abs(track_left));
        track_peak = std::max(track_peak, std::abs(track_right));
    }
    if (!performers_differ || !(track_peak > 0.0F)) return 12;

    if (brk_instance_state_read(static_cast<brk_instance_handle>(first), kStateOffset,
                                static_cast<std::uint32_t>(shared_patch.size()),
                                kStateSchemaVersionV1) != BRK_ERROR_ALREADY_ACTIVE) return 13;

    if (brk_instance_deactivate(static_cast<brk_instance_handle>(first)) != BRK_OK
        || brk_instance_deactivate(static_cast<brk_instance_handle>(second)) != BRK_OK) return 14;
    if (brk_instance_destroy(static_cast<brk_instance_handle>(first)) != BRK_OK
        || brk_instance_destroy(static_cast<brk_instance_handle>(second)) != BRK_OK) return 15;

    std::cout << "p5c_native_performers=2\n";
    std::cout << "p5c_native_shared_patch_bytes=" << shared_patch.size() << '\n';
    std::cout << "p5c_native_independent_runtime=ok\n";
    std::cout << "p5c_native_track_dry_sum_peak=" << track_peak << '\n';
    std::cout << "p5c_native_active_state_guard=ok\n";
    return 0;
}

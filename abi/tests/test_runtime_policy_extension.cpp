// Copyright © 2026 Myldy design / Ilya Tolstoukhov
// SPDX-License-Identifier: GPL-3.0-only

#include "brk_modal_module_runtime.hpp"
#include "brk_modal/auto_quality.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>

extern "C" std::int32_t brk_runtime_policy_set_u32(
    brk_instance_handle handle, std::uint32_t setting_id, std::uint32_t value);
extern "C" std::int32_t brk_runtime_policy_get_u32(
    brk_instance_handle handle, std::uint32_t setting_id, std::uint32_t* out_value);
extern "C" std::int32_t brk_instance_state_write(
    std::uint32_t instance_handle, std::uint32_t dst_offset, std::uint32_t dst_capacity);
extern "C" std::int32_t brk_instance_state_read(
    std::uint32_t instance_handle, std::uint32_t src_offset,
    std::uint32_t src_size, std::uint32_t schema_version);

namespace brk::modal::abi {
void bind_native_linear_memory(void* base, std::size_t size) noexcept;
}

int main() {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    reset_module_runtime_for_tests();
    const auto created = module_runtime().create(0U);
    if (created <= 0) return 1;
    const auto handle = static_cast<brk_instance_handle>(created);

    brk_prepare_info prepare{};
    prepare.struct_size = sizeof(prepare);
    prepare.sample_rate = 48000.0;
    prepare.max_block_frames = 128U;
    prepare.max_events_per_block = 64U;
    prepare.output_channel_count = 2U;
    prepare.realtime_memory_limit_bytes = kRealtimeMemoryEstimateBytes;
    if (module_runtime().prepare(handle, prepare) != BRK_OK) return 2;

    Patch authored = make_factory_patch(FactoryPatch::RitualBell);
    authored.polyphony = 16U;
    authored.resonator_a.partials = 64U;
    authored.resonator_b.partials = 64U;
    std::array<std::uint8_t, kStateV1Size> state{};
    if (!write_state_v1(authored, state.data(), state.size())) return 3;

    std::array<std::uint8_t, kStateV1Size * 2U> linear_memory{};
    std::memcpy(linear_memory.data(), state.data(), state.size());
    bind_native_linear_memory(linear_memory.data(), linear_memory.size());
    if (brk_instance_state_read(handle, 0U, kStateV1Size, kStateSchemaVersionV1) != BRK_OK) {
        return 4;
    }

    std::uint32_t value = 0xffffffffU;
    if (brk_runtime_policy_set_u32(handle, 1U,
            static_cast<std::uint32_t>(QualityProfile::Balanced)) != BRK_OK) return 5;
    if (brk_runtime_policy_get_u32(handle, 1U, &value) != BRK_OK
        || value != static_cast<std::uint32_t>(QualityProfile::Balanced)) return 6;
    const auto* engine = module_runtime().engine(handle);
    if (engine == nullptr || engine->patch().polyphony > 12U) return 7;

    if (brk_runtime_policy_set_u32(handle, 2U,
            static_cast<std::uint32_t>(TailPolicy::Conservative)) != BRK_OK) return 8;
    if (brk_runtime_policy_get_u32(handle, 2U, &value) != BRK_OK
        || value != static_cast<std::uint32_t>(TailPolicy::Conservative)) return 9;

    if (brk_runtime_policy_set_u32(handle, 3U,
            static_cast<std::uint32_t>(ModalKernel::Auto)) != BRK_OK) return 10;
    if (brk_runtime_policy_get_u32(handle, 3U, &value) != BRK_OK
        || value != static_cast<std::uint32_t>(ModalKernel::Auto)) return 11;

    if (brk_runtime_policy_set_u32(handle, 99U, 0U) != BRK_ERROR_UNSUPPORTED) return 12;
    if (brk_runtime_policy_get_u32(handle, 99U, &value) != BRK_ERROR_UNSUPPORTED) return 13;
    if (brk_runtime_policy_get_u32(handle, 1U, nullptr) != BRK_ERROR_BAD_OFFSET) return 14;
    if (brk_runtime_policy_set_u32(handle, 1U, 4U) != BRK_ERROR_INVALID_ARGUMENT) return 15;
    if (brk_runtime_policy_set_u32(handle, 2U, 2U) != BRK_ERROR_INVALID_ARGUMENT) return 16;
    if (brk_runtime_policy_set_u32(handle, 3U, 3U) != BRK_ERROR_INVALID_ARGUMENT) return 17;

    // The quality projection is runtime-only. Standard ABI state write must
    // preserve the exact authored bytes rather than serializing the reduced
    // effective polyphony/modal budget.
    if (brk_instance_state_write(handle, kStateV1Size, kStateV1Size) != BRK_OK) return 18;
    if (!std::equal(state.begin(), state.end(), linear_memory.begin() + kStateV1Size)) return 19;

    // Live generic parameter events must still become authored state. The
    // overlay reconciler folds untouched-by-quality parameters back into the
    // source shadow while keeping quality-owned structural fields authored.
    if (module_runtime().activate(handle) != BRK_OK) return 20;
    constexpr float target = 0.73F;
    brk_param_value_event event{};
    event.header.type = BRK_EVENT_PARAM_VALUE;
    event.header.size = sizeof(event);
    event.header.frame_offset = 0U;
    event.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    event.parameter_id = static_cast<std::uint32_t>(ParameterId::OutputGainDb);
    event.normalized_value = target;
    std::array<float, 16> left{};
    std::array<float, 16> right{};
    if (module_runtime().process(
            handle, left.data(), right.data(), static_cast<std::uint32_t>(left.size()),
            reinterpret_cast<const std::uint8_t*>(&event), sizeof(event), 1U) != BRK_OK) return 21;
    if (module_runtime().deactivate(handle) != BRK_OK) return 22;
    if (brk_instance_state_write(handle, kStateV1Size, kStateV1Size) != BRK_OK) return 23;

    Patch edited{};
    if (read_state_v1(
            edited, linear_memory.data() + kStateV1Size, kStateV1Size) != StateReadResult::Ok) return 24;
    if (edited.polyphony != authored.polyphony) return 25;
    float edited_gain = 0.0F;
    if (!get_parameter_normalized(edited, ParameterId::OutputGainDb, edited_gain)
        || std::abs(edited_gain - target) > 1.0e-5F) return 26;

    // A stopped state replacement is authoritative authored state. The module
    // state-read hook refreshes the source shadow; re-applying the same opaque
    // policy tuple reconstructs the runtime projection without contaminating
    // the next state save.
    if (brk_instance_state_read(handle, 0U, kStateV1Size, kStateSchemaVersionV1) != BRK_OK) {
        return 27;
    }
    if (brk_runtime_policy_set_u32(handle, 1U, 1U) != BRK_OK
        || brk_runtime_policy_set_u32(handle, 2U, 1U) != BRK_OK
        || brk_runtime_policy_set_u32(handle, 3U, 0U) != BRK_OK) return 28;
    if (brk_runtime_policy_get_u32(handle, 1U, &value) != BRK_OK || value != 1U) return 29;
    if (brk_runtime_policy_get_u32(handle, 2U, &value) != BRK_OK || value != 1U) return 30;
    if (brk_runtime_policy_get_u32(handle, 3U, &value) != BRK_OK || value != 0U) return 31;
    if (brk_instance_state_write(handle, kStateV1Size, kStateV1Size) != BRK_OK) return 32;
    if (!std::equal(state.begin(), state.end(), linear_memory.begin() + kStateV1Size)) return 33;

    std::cout << "runtime_policy_quality_roundtrip=PASS\n";
    std::cout << "runtime_policy_tail_roundtrip=PASS\n";
    std::cout << "runtime_policy_kernel_roundtrip=PASS\n";
    std::cout << "runtime_policy_unknown_setting_rejected=PASS\n";
    std::cout << "runtime_policy_authored_state_isolation=PASS\n";
    std::cout << "runtime_policy_live_parameter_state_reconcile=PASS\n";
    std::cout << "runtime_policy_state_reload_reapply=PASS\n";
    std::cout << "brk_runtime_policy_extension=PASS\n";
    return 0;
}

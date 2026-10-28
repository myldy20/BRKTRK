// Copyright © 2026 Myldy design / Ilya Tolstoukhov
// SPDX-License-Identifier: GPL-3.0-only

#include "brk_modal_module_runtime.hpp"
#include "brk_modal/auto_quality.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>

extern "C" std::int32_t brk_modal_quality_source_sync(brk_instance_handle handle);
extern "C" std::int32_t brk_modal_quality_source_set_parameter(
    brk_instance_handle handle, std::uint32_t parameter_id, float normalized_value);
extern "C" std::int32_t brk_modal_quality_apply(
    brk_instance_handle handle, std::uint32_t profile);
extern "C" std::int32_t brk_modal_quality_profile(brk_instance_handle handle);
extern "C" std::int32_t brk_modal_quality_auto_reset(
    brk_instance_handle handle, std::uint32_t initial_profile);
extern "C" std::int32_t brk_modal_quality_auto_observe(
    brk_instance_handle handle, float deadline_headroom);
extern "C" std::int32_t brk_modal_runtime_tail_policy_set(
    brk_instance_handle handle, std::uint32_t policy);
extern "C" std::int32_t brk_modal_runtime_tail_policy(brk_instance_handle handle);
extern "C" std::int32_t brk_modal_runtime_workload_word0(brk_instance_handle handle);
extern "C" std::int32_t brk_modal_runtime_workload_word1(brk_instance_handle handle);

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
    authored.stereo_mode = StereoMode::VoiceSpread;
    authored.resonator_a.partials = 64U;
    authored.resonator_b.partials = 64U;
    std::array<std::uint8_t, kStateV1Size> state{};
    if (!write_state_v1(authored, state.data(), state.size())) return 3;
    if (module_runtime().state_read(handle, state.data(), state.size(), kStateSchemaVersionV1) != BRK_OK) return 4;
    const Patch source = module_runtime().engine(handle)->patch();
    if (brk_modal_quality_source_sync(handle) != BRK_OK) return 5;

    // Tail work policy is runtime-only. Disabled is the exact oracle, changing
    // the policy must not mutate the authored/effective 768-byte state, and
    // invalid policy values must fail closed.
    if (brk_modal_runtime_tail_policy(handle)
        != static_cast<std::int32_t>(TailPolicy::Disabled)) return 6;
    std::array<std::uint8_t, kStateV1Size> tail_state_before{};
    if (module_runtime().state_write(handle, tail_state_before.data(), tail_state_before.size()) != BRK_OK) return 7;
    if (brk_modal_runtime_tail_policy_set(handle, static_cast<std::uint32_t>(TailPolicy::Conservative))
        != static_cast<std::int32_t>(TailPolicy::Conservative)) return 8;
    if (brk_modal_runtime_tail_policy(handle)
        != static_cast<std::int32_t>(TailPolicy::Conservative)) return 9;
    std::array<std::uint8_t, kStateV1Size> tail_state_after{};
    if (module_runtime().state_write(handle, tail_state_after.data(), tail_state_after.size()) != BRK_OK) return 10;
    if (tail_state_before != tail_state_after) return 11;
    if (brk_modal_runtime_tail_policy_set(handle, 2U) != BRK_ERROR_INVALID_ARGUMENT) return 12;
    if (brk_modal_runtime_tail_policy_set(handle, static_cast<std::uint32_t>(TailPolicy::Disabled))
        != static_cast<std::int32_t>(TailPolicy::Disabled)) return 13;

    if (brk_modal_quality_apply(handle, static_cast<std::uint32_t>(QualityProfile::Economy)) != BRK_OK) return 14;
    const auto economy = module_runtime().engine(handle)->patch();
    if (economy.polyphony != std::min<std::uint8_t>(source.polyphony, 8U)) return 15;
    if (economy.stereo_mode != source.stereo_mode) return 16;
    if (economy.resonator_a.max_render_partials < 24U) return 17;

    if (brk_modal_quality_apply(handle, static_cast<std::uint32_t>(QualityProfile::Draft)) != BRK_OK) return 18;
    const auto draft = module_runtime().engine(handle)->patch();
    if (draft.polyphony != std::min<std::uint8_t>(source.polyphony, 6U)
        || draft.stereo_mode != StereoMode::Mono) return 19;

    if (brk_modal_quality_apply(handle, static_cast<std::uint32_t>(QualityProfile::Full)) != BRK_OK) return 20;
    const auto full = module_runtime().engine(handle)->patch();
    if (full.polyphony != source.polyphony || full.stereo_mode != source.stereo_mode
        || full.resonator_a.max_render_partials != 64U) return 21;

    constexpr float target = 0.61F;
    if (brk_modal_quality_source_set_parameter(
            handle, static_cast<std::uint32_t>(ParameterId::OutputGainDb), target) != BRK_OK) return 22;
    if (brk_modal_quality_apply(handle, static_cast<std::uint32_t>(QualityProfile::Balanced)) != BRK_OK) return 23;
    float normalized = 0.0F;
    if (!get_parameter_normalized(module_runtime().engine(handle)->patch(), ParameterId::OutputGainDb, normalized)
        || std::abs(normalized - target) > 1.0e-6F) return 24;

    if (brk_modal_quality_auto_reset(handle, static_cast<std::uint32_t>(QualityProfile::Full))
        != static_cast<std::int32_t>(QualityProfile::Full)) return 25;
    for (int i = 0; i < 16; ++i) {
        if (brk_modal_quality_auto_observe(handle, -1.0F) < 0) return 26;
    }
    if (brk_modal_quality_profile(handle)
        != static_cast<std::int32_t>(QualityProfile::Balanced)) return 27;

    bool recovered = false;
    for (int i = 0; i < 512; ++i) {
        if (brk_modal_quality_auto_observe(handle, 1.0F) < 0) return 28;
        if (brk_modal_quality_profile(handle)
            == static_cast<std::int32_t>(QualityProfile::Full)) {
            recovered = true;
            break;
        }
    }
    if (!recovered) return 29;

    std::array<std::uint8_t, kStateV1Size> written{};
    if (module_runtime().state_write(handle, written.data(), written.size()) != BRK_OK) return 30;
    Patch effective_state{};
    if (read_state_v1(effective_state, written.data(), written.size()) != StateReadResult::Ok) return 31;

    const auto idle0 = brk_modal_runtime_workload_word0(handle);
    const auto idle1 = brk_modal_runtime_workload_word1(handle);
    if (idle0 < 0 || idle1 < 0) return 32;
    const auto idle_mode = (static_cast<std::uint32_t>(idle0) >> 20U) & 0x3U;
    if (idle_mode != 0U) return 33;

    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return 34;
    engine->set_patch(make_factory_patch(FactoryPatch::GlassString));
    engine->note_on({77U, 60, 0.8F, 0.0F});
    const auto active0 = static_cast<std::uint32_t>(brk_modal_runtime_workload_word0(handle));
    const auto active1 = static_cast<std::uint32_t>(brk_modal_runtime_workload_word1(handle));
    if ((active0 & 0x1fU) != 1U || ((active0 >> 5U) & 0x1fU) != 1U
        || ((active0 >> 20U) & 0x3U) != 1U) return 35;
    const auto a_units = active1 & 0x7fU;
    const auto b_units = (active1 >> 7U) & 0x7fU;
    const auto active_work = (active1 >> 14U) & 0xfffU;
    if (a_units + b_units == 0U || active_work != a_units + b_units) return 36;

    if (brk_modal_runtime_tail_policy_set(handle, static_cast<std::uint32_t>(TailPolicy::Conservative))
        != static_cast<std::int32_t>(TailPolicy::Conservative)) return 37;
    const auto conservative1 = static_cast<std::uint32_t>(brk_modal_runtime_workload_word1(handle));
    if (((conservative1 >> 30U) & 0x1U) != 1U) return 38;

    engine->note_off(77U);
    const auto tail0 = static_cast<std::uint32_t>(brk_modal_runtime_workload_word0(handle));
    if (((tail0 >> 20U) & 0x3U) != 2U) return 39;

    std::cout << "p9c_modal_quality_extension=ok\n";
    std::cout << "p9c_quality_reversible_source=ok\n";
    std::cout << "p9c_auto_full_balanced=ok\n";
    std::cout << "p9_tail_runtime_state_isolation=ok\n";
    std::cout << "p9_profile_workload_snapshot=ok\n";
    return 0;
}

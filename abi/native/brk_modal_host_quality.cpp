// Copyright © 2026 Myldy design / Ilya Tolstoukhov
// SPDX-License-Identifier: GPL-3.0-only

#include "brk_modal_module_runtime.hpp"
#include "brk_modal/auto_quality.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define BRK_MODAL_HOST_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define BRK_MODAL_HOST_EXPORT extern "C"
#endif

namespace brk::modal::abi::host_quality {
namespace {

struct SourceState {
    brk_instance_handle handle = 0U;
    Patch source{};
    QualityProfile profile = QualityProfile::Full;
    AutoQualityController automatic{};
    bool initialized = false;
};

std::array<SourceState, kMaxModuleInstances> states{};

SourceState* state_for(brk_instance_handle handle, bool create) noexcept {
    if (module_runtime().engine(handle) == nullptr) return nullptr;
    for (auto& state : states) {
        if (state.initialized && state.handle == handle) return &state;
    }
    if (!create) return nullptr;
    for (auto& state : states) {
        if (!state.initialized || module_runtime().engine(state.handle) == nullptr) {
            state = {};
            state.handle = handle;
            state.source = module_runtime().engine(handle)->patch();
            state.profile = QualityProfile::Full;
            state.automatic.reset(QualityProfile::Full);
            state.initialized = true;
            return &state;
        }
    }
    return nullptr;
}

bool valid_profile(std::uint32_t profile) noexcept {
    return profile <= static_cast<std::uint32_t>(QualityProfile::Draft);
}

bool valid_kernel(std::uint32_t kernel) noexcept {
    return kernel <= static_cast<std::uint32_t>(ModalKernel::Vector4);
}

bool valid_tail_policy(std::uint32_t policy) noexcept {
    return policy <= static_cast<std::uint32_t>(TailPolicy::Conservative);
}

bool is_tube(Model model) noexcept {
    return model == Model::OpenTube || model == Model::ClosedTube;
}

std::uint32_t resonator_work_units(const ResonatorPatch& resonator) noexcept {
    if (!resonator.enabled) return 0U;
    if (is_tube(resonator.model)) return 1U;
    return static_cast<std::uint32_t>(std::max<std::size_t>(
        1U,
        std::min<std::size_t>(resonator.partials, resonator.max_render_partials)));
}

void apply(SourceState& state) noexcept {
    if (auto* engine = module_runtime().engine(state.handle)) {
        engine->set_patch(apply_auto_quality_profile(state.source, state.profile));
    }
}

} // namespace

void clear_for_tests() noexcept {
    states = {};
}

} // namespace brk::modal::abi::host_quality

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_quality_source_sync(
    brk_instance_handle handle) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    auto* state = host_quality::state_for(handle, true);
    if (state == nullptr) return BRK_ERROR_OUT_OF_MEMORY;
    state->source = engine->patch();
    state->profile = QualityProfile::Full;
    state->automatic.reset(QualityProfile::Full);
    return BRK_OK;
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_quality_source_set_parameter(
    brk_instance_handle handle,
    std::uint32_t parameter_id,
    float normalized_value) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    auto* state = host_quality::state_for(handle, true);
    if (state == nullptr || !std::isfinite(normalized_value)
        || normalized_value < 0.0F || normalized_value > 1.0F
        || !set_parameter_normalized(
            state->source, static_cast<ParameterId>(parameter_id), normalized_value)) {
        return BRK_ERROR_BAD_PARAMETER;
    }
    return BRK_OK;
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_quality_apply(
    brk_instance_handle handle,
    std::uint32_t profile) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    if (!host_quality::valid_profile(profile)) return BRK_ERROR_INVALID_ARGUMENT;
    auto* state = host_quality::state_for(handle, true);
    if (state == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    state->profile = static_cast<QualityProfile>(profile);
    host_quality::apply(*state);
    return BRK_OK;
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_quality_profile(
    brk_instance_handle handle) {
    using namespace brk::modal::abi;
    auto* state = host_quality::state_for(handle, false);
    if (state == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    return static_cast<std::int32_t>(state->profile);
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_quality_auto_reset(
    brk_instance_handle handle,
    std::uint32_t initial_profile) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    if (initial_profile > static_cast<std::uint32_t>(QualityProfile::Balanced)) {
        return BRK_ERROR_INVALID_ARGUMENT;
    }
    auto* state = host_quality::state_for(handle, true);
    if (state == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    state->automatic.reset(static_cast<QualityProfile>(initial_profile));
    state->profile = state->automatic.current_profile();
    host_quality::apply(*state);
    return static_cast<std::int32_t>(state->profile);
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_quality_auto_observe(
    brk_instance_handle handle,
    float deadline_headroom) {
    using namespace brk::modal::abi;
    auto* state = host_quality::state_for(handle, true);
    if (state == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    const auto decision = state->automatic.observe_deadline_headroom(deadline_headroom);
    if (decision.changed) {
        state->profile = decision.profile;
        host_quality::apply(*state);
    }
    return static_cast<std::int32_t>(state->profile);
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_kernel_set(
    brk_instance_handle handle,
    std::uint32_t kernel) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    if (!host_quality::valid_kernel(kernel)) return BRK_ERROR_INVALID_ARGUMENT;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    engine->set_modal_kernel(static_cast<ModalKernel>(kernel));
    return static_cast<std::int32_t>(engine->active_modal_kernel());
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_kernel_requested(
    brk_instance_handle handle) {
    using namespace brk::modal::abi;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    return static_cast<std::int32_t>(engine->modal_kernel());
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_kernel_active(
    brk_instance_handle handle) {
    using namespace brk::modal::abi;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    return static_cast<std::int32_t>(engine->active_modal_kernel());
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_vector_available(void) {
    return brk::modal::modal_vector_kernel_available() ? 1 : 0;
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_tail_policy_set(
    brk_instance_handle handle,
    std::uint32_t policy) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    if (!host_quality::valid_tail_policy(policy)) return BRK_ERROR_INVALID_ARGUMENT;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    engine->set_tail_policy(static_cast<TailPolicy>(policy));
    return static_cast<std::int32_t>(engine->tail_policy());
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_tail_policy(
    brk_instance_handle handle) {
    using namespace brk::modal::abi;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    return static_cast<std::int32_t>(engine->tail_policy());
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_reference_output_mode_set(
    brk_instance_handle handle,
    std::uint32_t mode) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    if (mode > static_cast<std::uint32_t>(ReferenceOutputMode::RawHeadroom)) {
        return BRK_ERROR_INVALID_ARGUMENT;
    }
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    engine->set_reference_output_mode(static_cast<ReferenceOutputMode>(mode));
    return static_cast<std::int32_t>(engine->reference_output_mode());
}

BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_reference_output_mode(
    brk_instance_handle handle) {
    using namespace brk::modal::abi;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    return static_cast<std::int32_t>(engine->reference_output_mode());
}

// P9 physical profiling extension. These packed words are engine-specific,
// runtime-only diagnostics and deliberately remain outside frozen ABI v1/state.
// Word 0: active[0:4], held[5:9], sustained[10:14], sleeping[15:19],
// mode[20:21] (0 idle, 1 active/held, 2 terminal tail), polyphony[22:26].
BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_workload_word0(
    brk_instance_handle handle) {
    using namespace brk::modal::abi;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    const std::uint32_t active = static_cast<std::uint32_t>(
        std::min<std::size_t>(31U, engine->active_voice_count()));
    const std::uint32_t held = static_cast<std::uint32_t>(
        std::min<std::size_t>(31U, engine->held_voice_count()));
    const std::uint32_t sustained = static_cast<std::uint32_t>(
        std::min<std::size_t>(31U, engine->sustained_voice_count()));
    const std::uint32_t sleeping = static_cast<std::uint32_t>(
        std::min<std::size_t>(31U, engine->sleeping_voice_count()));
    const std::uint32_t effective = active > sleeping ? active - sleeping : 0U;
    const std::uint32_t mode = effective == 0U ? 0U : ((held + sustained) > 0U ? 1U : 2U);
    const std::uint32_t polyphony = std::min<std::uint32_t>(31U, engine->patch().polyphony);
    return static_cast<std::int32_t>(
        active | (held << 5U) | (sustained << 10U) | (sleeping << 15U)
        | (mode << 20U) | (polyphony << 22U));
}

// Word 1: resonator-A work/voice[0:6], resonator-B work/voice[7:13],
// effective active modal work[14:25], stereo[26:27], reference[28], serial[29],
// conservative tail policy[30].
BRK_MODAL_HOST_EXPORT std::int32_t brk_modal_runtime_workload_word1(
    brk_instance_handle handle) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    auto* engine = module_runtime().engine(handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    const auto& patch = engine->patch();
    const std::uint32_t a = std::min<std::uint32_t>(127U,
        host_quality::resonator_work_units(patch.resonator_a));
    const std::uint32_t b = std::min<std::uint32_t>(127U,
        host_quality::resonator_work_units(patch.resonator_b));
    const std::uint32_t active = static_cast<std::uint32_t>(engine->active_voice_count());
    const std::uint32_t sleeping = static_cast<std::uint32_t>(engine->sleeping_voice_count());
    const std::uint32_t effective = active > sleeping ? active - sleeping : 0U;
    const std::uint32_t modal_work = std::min<std::uint32_t>(4095U, (a + b) * effective);
    const std::uint32_t stereo = std::min<std::uint32_t>(3U,
        static_cast<std::uint32_t>(patch.stereo_mode));
    const std::uint32_t reference = patch.coupling_profile == CouplingProfile::Reference ? 1U : 0U;
    const std::uint32_t serial = patch.coupling == Coupling::Serial ? 1U : 0U;
    const std::uint32_t conservative_tail = engine->tail_policy() == TailPolicy::Conservative ? 1U : 0U;
    return static_cast<std::int32_t>(
        a | (b << 7U) | (modal_work << 14U) | (stereo << 26U)
        | (reference << 28U) | (serial << 29U) | (conservative_tail << 30U));
}

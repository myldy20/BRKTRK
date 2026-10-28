// Copyright © 2026 Myldy design / Ilya Tolstoukhov
// SPDX-License-Identifier: GPL-3.0-only

#include "brk_modal_module_runtime.hpp"
#include "brk_modal/auto_quality.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define BRK_RUNTIME_POLICY_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define BRK_RUNTIME_POLICY_EXPORT extern "C"
#endif

extern "C" std::int32_t brk_modal_quality_source_sync(brk_instance_handle handle);
extern "C" std::int32_t brk_modal_quality_source_set_parameter(
    brk_instance_handle handle, std::uint32_t parameter_id, float normalized_value);
extern "C" std::int32_t brk_modal_quality_apply(
    brk_instance_handle handle, std::uint32_t profile);
extern "C" std::int32_t brk_modal_quality_profile(brk_instance_handle handle);
extern "C" std::int32_t brk_modal_runtime_tail_policy_set(
    brk_instance_handle handle, std::uint32_t policy);
extern "C" std::int32_t brk_modal_runtime_tail_policy(brk_instance_handle handle);
extern "C" std::int32_t brk_modal_runtime_kernel_set(
    brk_instance_handle handle, std::uint32_t kernel);
extern "C" std::int32_t brk_modal_runtime_kernel_requested(brk_instance_handle handle);

namespace {

constexpr std::uint32_t kQualityProfileSetting = 1U;
constexpr std::uint32_t kTailPolicySetting = 2U;
constexpr std::uint32_t kRenderKernelSetting = 3U;
constexpr float kStateReconcileTolerance = 1.0e-6F;

std::int32_t as_status(std::int32_t result) noexcept {
    return result < 0 ? result : BRK_OK;
}

} // namespace

namespace brk::modal::abi::runtime_policy {
namespace {

struct PolicyState {
    brk_instance_handle handle = 0U;
    Patch source{};
    QualityProfile profile = QualityProfile::Full;
    bool initialized = false;
    bool managed_quality = false;
};

std::array<PolicyState, kMaxModuleInstances> states{};

PolicyState* state_for(brk_instance_handle handle, bool create) noexcept {
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
            state.initialized = true;
            return &state;
        }
    }
    return nullptr;
}

std::int32_t sync_source(PolicyState& state) noexcept {
    auto* engine = module_runtime().engine(state.handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;
    const auto result = brk_modal_quality_source_sync(state.handle);
    if (result != BRK_OK) return result;
    state.source = engine->patch();
    state.profile = QualityProfile::Full;
    return BRK_OK;
}

std::int32_t reconcile_source(PolicyState& state) noexcept {
    auto* engine = module_runtime().engine(state.handle);
    if (engine == nullptr) return BRK_ERROR_INVALID_ARGUMENT;

    const Patch projected = apply_auto_quality_profile(state.source, state.profile);
    const Patch& effective = engine->patch();
    for (std::size_t index = 0U; index < kParameterDescriptorCount; ++index) {
        const auto* descriptor = parameter_descriptor_at(index);
        if (descriptor == nullptr) continue;

        float source_value = 0.0F;
        float projected_value = 0.0F;
        float effective_value = 0.0F;
        if (!get_parameter_normalized(state.source, descriptor->id, source_value)
            || !get_parameter_normalized(projected, descriptor->id, projected_value)
            || !get_parameter_normalized(effective, descriptor->id, effective_value)) {
            continue;
        }

        // A quality-owned projection must never overwrite the authored source.
        // Parameters untouched by the projection may have moved through the
        // ordinary generic ABI event path; fold only those live edits back into
        // the source shadow before save or a later quality-profile change.
        if (std::abs(projected_value - source_value) <= kStateReconcileTolerance
            && std::abs(effective_value - projected_value) > kStateReconcileTolerance) {
            if (!set_parameter_normalized(state.source, descriptor->id, effective_value)) {
                return BRK_ERROR_INTERNAL;
            }
            const auto result = brk_modal_quality_source_set_parameter(
                state.handle, static_cast<std::uint32_t>(descriptor->id), effective_value);
            if (result != BRK_OK) return result;
        }
    }
    return BRK_OK;
}

} // namespace

std::int32_t state_write_if_managed(brk_instance_handle handle,
                                    std::uint8_t* destination,
                                    std::size_t capacity,
                                    bool& handled) noexcept {
    handled = false;
    auto* state = state_for(handle, false);
    if (state == nullptr || !state->managed_quality) return BRK_OK;
    handled = true;
    if (destination == nullptr || capacity < kStateV1Size) return BRK_ERROR_BAD_SIZE;
    if (const auto result = reconcile_source(*state); result != BRK_OK) return result;
    return write_state_v1(state->source, destination, capacity) ? BRK_OK : BRK_ERROR_INTERNAL;
}

std::int32_t state_read_committed(brk_instance_handle handle) noexcept {
    auto* state = state_for(handle, false);
    if (state == nullptr || !state->managed_quality) return BRK_OK;
    return sync_source(*state);
}

void clear_for_tests() noexcept {
    states = {};
}

} // namespace brk::modal::abi::runtime_policy

// Engine-neutral runtime-policy extension used by the generic Host. Setting IDs
// and values are package-owned opaque u32 values; only this Modal adapter knows
// their meaning. The extension is runtime-only and does not alter ABI v1 state.
BRK_RUNTIME_POLICY_EXPORT std::int32_t brk_runtime_policy_set_u32(
    brk_instance_handle handle,
    std::uint32_t setting_id,
    std::uint32_t value) {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    switch (setting_id) {
    case kQualityProfileSetting: {
        if (value > static_cast<std::uint32_t>(QualityProfile::Draft)) {
            return BRK_ERROR_INVALID_ARGUMENT;
        }
        auto* state = runtime_policy::state_for(handle, true);
        if (state == nullptr) return BRK_ERROR_OUT_OF_MEMORY;
        if (state->managed_quality) {
            if (const auto result = runtime_policy::reconcile_source(*state); result != BRK_OK) {
                return result;
            }
        } else if (const auto result = runtime_policy::sync_source(*state); result != BRK_OK) {
            return result;
        }
        const auto result = brk_modal_quality_apply(handle, value);
        if (result < 0) return result;
        state->profile = static_cast<QualityProfile>(value);
        state->managed_quality = true;
        return BRK_OK;
    }
    case kTailPolicySetting:
        if (value > static_cast<std::uint32_t>(TailPolicy::Conservative)) {
            return BRK_ERROR_INVALID_ARGUMENT;
        }
        return as_status(brk_modal_runtime_tail_policy_set(handle, value));
    case kRenderKernelSetting:
        if (value > static_cast<std::uint32_t>(ModalKernel::Vector4)) {
            return BRK_ERROR_INVALID_ARGUMENT;
        }
        return as_status(brk_modal_runtime_kernel_set(handle, value));
    default:
        return BRK_ERROR_UNSUPPORTED;
    }
}

// Status and value are deliberately separate: the complete u32 value space is
// available to engines without reserving a sentinel for errors. In Wasm the
// pointer is a linear-memory offset supplied by the generic Host.
BRK_RUNTIME_POLICY_EXPORT std::int32_t brk_runtime_policy_get_u32(
    brk_instance_handle handle,
    std::uint32_t setting_id,
    std::uint32_t* out_value) {
    if (out_value == nullptr) return BRK_ERROR_BAD_OFFSET;

    std::int32_t result = BRK_ERROR_UNSUPPORTED;
    switch (setting_id) {
    case kQualityProfileSetting:
        result = brk_modal_quality_profile(handle);
        break;
    case kTailPolicySetting:
        result = brk_modal_runtime_tail_policy(handle);
        break;
    case kRenderKernelSetting:
        result = brk_modal_runtime_kernel_requested(handle);
        break;
    default:
        return BRK_ERROR_UNSUPPORTED;
    }
    if (result < 0) return result;
    *out_value = static_cast<std::uint32_t>(result);
    return BRK_OK;
}

#include "brk_modal/brk_modal.hpp"
#include "brk_modal/parameter_descriptors.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <tuple>
#include <utility>

#ifndef BRK_MODAL_ENABLE_VECTOR
#define BRK_MODAL_ENABLE_VECTOR 1
#endif

#if BRK_MODAL_ENABLE_VECTOR && defined(__wasm_simd128__)
#include <wasm_simd128.h>
#define BRK_MODAL_VECTOR_WASM 1
#elif BRK_MODAL_ENABLE_VECTOR && (defined(__ARM_NEON) || defined(__ARM_NEON__))
#include <arm_neon.h>
#define BRK_MODAL_VECTOR_NEON 1
#elif BRK_MODAL_ENABLE_VECTOR && defined(__SSE2__)
#include <emmintrin.h>
#define BRK_MODAL_VECTOR_SSE2 1
#endif

namespace brk::modal {
namespace detail {

constexpr float kPi = 3.14159265358979323846F;
constexpr float kTwoPi = 2.0F * kPi;
constexpr float kSilenceThreshold = 1.0e-8F;
// P4.7C conservative terminal-tail thresholds are measured on the complete
// pre-output voice sample plus smoothed resonator/exciter residuals. The wake
// threshold is intentionally 4x higher than the sleep threshold to prevent
// threshold chatter during beating tails.
constexpr float kTailSleepThreshold = 1.0e-6F;
constexpr float kTailWakeThreshold = 4.0e-6F;
constexpr double kTailSleepDwellSeconds = 0.050;
constexpr double kTailRetireSeconds = 0.100;
constexpr std::size_t kStereoDelayFrames = 8192;
constexpr std::uint32_t kDefaultSeed = 0x42524b4dU;

#if defined(BRK_MODAL_VECTOR_WASM) || defined(BRK_MODAL_VECTOR_NEON) || defined(BRK_MODAL_VECTOR_SSE2)
constexpr bool kModalVectorKernelCompiled = true;
#else
constexpr bool kModalVectorKernelCompiled = false;
#endif

ModalKernel resolve_modal_kernel(ModalKernel requested) noexcept {
    if (requested == ModalKernel::Scalar) return ModalKernel::Scalar;
    return kModalVectorKernelCompiled ? ModalKernel::Vector4 : ModalKernel::Scalar;
}

float clampf(float value, float low, float high) noexcept {
    return std::max(low, std::min(high, value));
}

float midi_to_hz(std::int16_t key, float tuning_semitones) noexcept {
    return 440.0F * std::pow(2.0F, (static_cast<float>(key) - 69.0F + tuning_semitones) / 12.0F);
}

float pitch_factor(const ResonatorPatch& patch) noexcept {
    return std::pow(2.0F, (patch.coarse_semitones + patch.fine_cents * 0.01F) / 12.0F);
}

float cents_between(float a, float b) noexcept {
    if (!(a > 0.0F && b > 0.0F)) return 0.0F;
    return 1200.0F * std::log2(a / b);
}

float ratio_from_cents(float cents) noexcept {
    return std::pow(2.0F, cents / 1200.0F);
}

float velocity_shape(float velocity, const VelocityPatch& patch) noexcept {
    return std::pow(clampf(velocity, 0.0F, 1.0F), clampf(patch.curve, 0.25F, 4.0F));
}

std::uint32_t xorshift32(std::uint32_t& state) noexcept {
    state ^= state << 13U;
    state ^= state >> 17U;
    state ^= state << 5U;
    return state;
}

float random_bipolar(std::uint32_t& state) noexcept {
    const std::uint32_t bits = xorshift32(state);
    return static_cast<float>(bits) * (2.0F / 4294967295.0F) - 1.0F;
}

struct Biquad {
    float b0 = 1.0F;
    float b1 = 0.0F;
    float b2 = 0.0F;
    float a1 = 0.0F;
    float a2 = 0.0F;
    float z1 = 0.0F;
    float z2 = 0.0F;

    void reset() noexcept { z1 = z2 = 0.0F; }

    void bandpass(float sample_rate, float frequency, float q) noexcept {
        const float f = clampf(frequency, 10.0F, 0.47F * sample_rate);
        const float omega = kTwoPi * f / sample_rate;
        const float sin_w = std::sin(omega);
        const float cos_w = std::cos(omega);
        const float alpha = sin_w / (2.0F * std::max(0.05F, q));
        const float inv_a0 = 1.0F / (1.0F + alpha);
        b0 = alpha * inv_a0;
        b1 = 0.0F;
        b2 = -alpha * inv_a0;
        a1 = -2.0F * cos_w * inv_a0;
        a2 = (1.0F - alpha) * inv_a0;
    }

    float process(float x) noexcept {
        const float y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

// Direct C++ Patch callers bypass the ABI/state-v1 normalization layer. Keep
// valid in-range values bit-for-bit unchanged, but route non-finite or plainly
// out-of-contract values through the same descriptor ranges/defaults used by
// the public parameter API. This makes Engine::set_patch robust without
// changing authored presets or normalized state semantics.
void sanitize_patch_contract(Patch& patch) noexcept {
    for (std::size_t index = 0U; index < kParameterDescriptorCount; ++index) {
        const auto* descriptor = parameter_descriptor_at(index);
        if (descriptor == nullptr) continue;
        float value = descriptor->plain_default;
        if (!get_parameter_plain(patch, descriptor->id, value)) continue;
        if (std::isfinite(value)
            && value >= descriptor->plain_min
            && value <= descriptor->plain_max) {
            continue;
        }
        const float replacement = std::isfinite(value)
            ? std::clamp(value, descriptor->plain_min, descriptor->plain_max)
            : descriptor->plain_default;
        (void)set_parameter_plain(patch, descriptor->id, replacement);
    }
}

#include "detail/brk_modal_upstream_exciter.inc"
#include "detail/brk_modal_primitives.inc"
#include "detail/brk_modal_models.inc"
#include "detail/brk_modal_output.inc"
} // namespace detail
using namespace detail;

const char* modal_kernel_name(ModalKernel kernel) noexcept {
    switch (kernel) {
    case ModalKernel::Auto: return "auto";
    case ModalKernel::Scalar: return "scalar";
    case ModalKernel::Vector4: return "vector4";
    }
    return "scalar";
}

bool modal_vector_kernel_available() noexcept {
    return detail::kModalVectorKernelCompiled;
}

const char* tail_policy_name(TailPolicy policy) noexcept {
    switch (policy) {
    case TailPolicy::Disabled: return "disabled";
    case TailPolicy::Conservative: return "conservative";
    }
    return "disabled";
}

const char* modal_vector_kernel_backend() noexcept {
#if defined(BRK_MODAL_VECTOR_WASM)
    return "wasm-simd128";
#elif defined(BRK_MODAL_VECTOR_NEON)
    return "neon";
#elif defined(BRK_MODAL_VECTOR_SSE2)
    return "sse2";
#else
    return "scalar";
#endif
}

#include "detail/brk_modal_engine.inc"

void Engine::set_live_gain_patch(
    const Patch& patch,
    bool update_resonator_gain,
    bool update_output_gain) noexcept {

    if (!impl_ || (!update_resonator_gain && !update_output_gain)) return;

    if (update_resonator_gain) {
        patch_.resonator_gain_db = clamp(patch.resonator_gain_db, -24.0F, 24.0F);
        impl_->resonator_gain = db_to_gain(patch_.resonator_gain_db);
    }
    if (update_output_gain) {
        patch_.output_gain_db = clamp(patch.output_gain_db, -60.0F, 12.0F);
        impl_->output_gain = db_to_gain(patch_.output_gain_db);
    }

    // Generic set_patch() resets terminal-tail observers for any live patch edit
    // and retires an already-sleeping voice. Preserve that lifecycle behavior
    // without rebuilding modal tables or reconfiguring active resonators.
    const std::size_t voice_limit = std::max<std::size_t>(1U, patch_.polyphony);
    for (std::size_t index = 0U; index < voice_limit; ++index) {
        auto& voice = impl_->voices[index];
        if (!voice.active) continue;
        voice.tail_below_frames = 0U;
        voice.tail_observer = 0.0F;
        voice.tail_block_peak = 0.0F;
        if (voice.tail_sleeping) {
            voice.reset();
            ++impl_->tail_sleep_stats.retired_voices;
        }
    }
}

} // namespace brk::modal
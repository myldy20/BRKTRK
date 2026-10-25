#pragma once

#include "brk_modal/brk_modal.hpp"
#include "brk_modal/parameter_ids.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace brk::modal {

enum class ParameterType : std::uint32_t {
    Continuous = 1,
    Stepped = 2,
    Enum = 3,
    Boolean = 4,
};

enum ParameterFlags : std::uint32_t {
    ParameterAutomatable = 1U << 0U,
    ParameterModulatable = 1U << 1U,
    ParameterPerNote = 1U << 2U,
    ParameterHidden = 1U << 3U,
    ParameterReadOnly = 1U << 4U,
    ParameterRequiresReconfigure = 1U << 5U,
};

struct ParameterDescriptor {
    ParameterId id;
    const char* key;
    const char* display_name;
    const char* unit;
    const char* group_key;
    ParameterType type;
    std::uint32_t flags;
    float plain_min;
    float plain_max;
    float plain_step;
    float skew;
    float plain_default;
    const char* enum_labels;
    const float* enum_plain_values;
    std::uint32_t enum_value_count;
};

namespace parameter_detail {

inline constexpr std::array<float, 7> kPartialValues = {4.0F, 8.0F, 16.0F, 32.0F, 64.0F, 1.0F, 2.0F};

inline constexpr std::uint32_t kAutomatable = ParameterAutomatable;
inline constexpr std::uint32_t kModulatable = ParameterAutomatable | ParameterModulatable;
inline constexpr std::uint32_t kReconfigure = ParameterRequiresReconfigure;
inline constexpr std::uint32_t kHiddenReconfigure = ParameterHidden | ParameterRequiresReconfigure;

#define BRK_D(id_, name_, unit_, group_, type_, flags_, min_, max_, step_, skew_, def_, labels_, values_, count_) \
    {ParameterId::id_, parameter_key(ParameterId::id_), name_, unit_, group_, ParameterType::type_, flags_, min_, max_, step_, skew_, def_, labels_, values_, count_}

// Runtime contract used by the production persistent executor:
// - kModulatable: sample-accurate PARAM_VALUE and PARAM_RAMP are supported;
// - kAutomatable: PARAM_VALUE is supported only at the block boundary;
// - kReconfigure: structural PARAM_VALUE is supported only at the block boundary.
// Only controls with a proven cheap live path carry ParameterModulatable.
inline constexpr ParameterDescriptor kDescriptors[] = {
    BRK_D(Coupling, "Coupling", "", "coupling", Enum, kReconfigure, 0, 1, 1, 1, 0, "A+B|A>B", nullptr, 2),
    BRK_D(ParallelMix, "A/B Mix", "%", "coupling", Continuous, kAutomatable, 0, 1, 0, 1, 0.5F, nullptr, nullptr, 0),
    BRK_D(CouplingSplit, "Coupling Split", "", "coupling", Continuous, kAutomatable, 0.01F, 1, 0.001F, 0.5F, 0.01F, nullptr, nullptr, 0),
    BRK_D(ResonatorGainDb, "Resonator Gain", "dB", "output", Continuous, kModulatable, -24, 24, 0, 1, 12, nullptr, nullptr, 0),
    BRK_D(CouplingProfile, "Coupling Profile", "", "coupling", Enum, kReconfigure, 0, 2, 1, 1, 0, "Stable|Reference|Wild", nullptr, 3),
    BRK_D(MaxCouplingDetuneCents, "Maximum Coupling Detune", "ct", "coupling", Continuous, kAutomatable, 0, 200, 0.1F, 1, 28, nullptr, nullptr, 0),
    BRK_D(ReleaseMode, "Release Mode", "", "lifecycle", Enum, kReconfigure, 0, 2, 1, 1, 0, "Damped|Natural|One Shot", nullptr, 3),
    BRK_D(RetriggerDeclickMs, "Retrigger Declick", "ms", "lifecycle", Continuous, kAutomatable, 0, 20, 0.1F, 1, 2.5F, nullptr, nullptr, 0),
    BRK_D(OutputGainDb, "Output Gain", "dB", "output", Continuous, kModulatable, -60, 12, 0, 1, -3, nullptr, nullptr, 0),
    BRK_D(StereoMode, "Stereo Mode", "", "output", Enum, kReconfigure, 0, 2, 1, 1, 1, "Mono|Comb|Voice Spread", nullptr, 3),
    BRK_D(StereoWidth, "Stereo Width", "%", "output", Continuous, kModulatable, 0, 1, 0, 1, 1, nullptr, nullptr, 0),
    BRK_D(Polyphony, "Polyphony", "voices", "lifecycle", Stepped, kReconfigure, 1, 16, 1, 1, 12, nullptr, nullptr, 0),

    BRK_D(AEnabled, "A Enabled", "", "resonator_a", Boolean, kReconfigure, 0, 1, 1, 1, 1, "Off|On", nullptr, 2),
    BRK_D(AModel, "A Model", "", "resonator_a", Enum, kReconfigure, 0, 11, 1, 1, 0, "String|Beam|Squared|Membrane|Plate|Drumhead|Marimba|Open Tube|Closed Tube|Marimba2|Bell|Djembe", nullptr, 12),
    BRK_D(APartials, "A Partials", "modes", "resonator_a", Enum, kReconfigure, 1, 64, 0, 1, 32, "4|8|16|32|64|1|2", kPartialValues.data(), 7),
    BRK_D(ADecaySeconds, "A Decay", "s", "resonator_a", Continuous, kModulatable, 0.01F, 100, 0.01F, 0.2F, 1, nullptr, nullptr, 0),
    BRK_D(AMaterial, "A Material", "", "resonator_a", Continuous, kModulatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(ATone, "A Tone", "", "resonator_a", Continuous, kModulatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(AHitPosition, "A Hit Position", "", "resonator_a", Continuous, kAutomatable, 0.02F, 0.5F, 0, 1, 0.26F, nullptr, nullptr, 0),
    BRK_D(AReleaseScale, "A Release", "", "resonator_a", Continuous, kAutomatable, 0.001F, 1, 0, 1, 1, nullptr, nullptr, 0),
    BRK_D(AInharmonicity, "A Inharmonicity", "", "resonator_a", Continuous, kAutomatable, 0.0001F, 1, 0.0001F, 0.3F, 0.0001F, nullptr, nullptr, 0),
    BRK_D(AModelRatio, "A Ratio", "", "resonator_a", Continuous, kAutomatable, 0.1F, 10, 0.01F, 0.3F, 1, nullptr, nullptr, 0),
    BRK_D(ALowCut, "A Low Cut", "", "resonator_a", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(ATubeRadius, "A Tube Radius", "", "resonator_a", Continuous, kAutomatable, 0, 1, 0, 1, 0.5F, nullptr, nullptr, 0),
    BRK_D(ACoarseSemitones, "A Coarse", "st", "resonator_a", Stepped, kAutomatable, -48, 48, 1, 1, 0, nullptr, nullptr, 0),
    BRK_D(AFineCents, "A Fine", "ct", "resonator_a", Stepped, kAutomatable, -99, 99, 1, 1, 0, nullptr, nullptr, 0),
    BRK_D(ASpectralFocus, "A Spectral Focus", "%", "resonator_a", Continuous, kAutomatable, 0, 1, 0, 1, 0.25F, nullptr, nullptr, 0),
    BRK_D(AVelocityDecay, "Velocity A Decay", "", "resonator_a_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(AVelocityHitPosition, "Velocity A Hit", "", "resonator_a_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(AVelocityInharmonicity, "Velocity A Inharmonicity", "", "resonator_a_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(AVelocityMaterial, "Velocity A Material", "", "resonator_a_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(AVelocityTone, "Velocity A Tone", "", "resonator_a_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),

    BRK_D(BEnabled, "B Enabled", "", "resonator_b", Boolean, kReconfigure, 0, 1, 1, 1, 0, "Off|On", nullptr, 2),
    BRK_D(BModel, "B Model", "", "resonator_b", Enum, kReconfigure, 0, 11, 1, 1, 1, "String|Beam|Squared|Membrane|Plate|Drumhead|Marimba|Open Tube|Closed Tube|Marimba2|Bell|Djembe", nullptr, 12),
    BRK_D(BPartials, "B Partials", "modes", "resonator_b", Enum, kReconfigure, 1, 64, 0, 1, 32, "4|8|16|32|64|1|2", kPartialValues.data(), 7),
    BRK_D(BDecaySeconds, "B Decay", "s", "resonator_b", Continuous, kModulatable, 0.01F, 100, 0.01F, 0.2F, 1, nullptr, nullptr, 0),
    BRK_D(BMaterial, "B Material", "", "resonator_b", Continuous, kModulatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(BTone, "B Tone", "", "resonator_b", Continuous, kModulatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(BHitPosition, "B Hit Position", "", "resonator_b", Continuous, kAutomatable, 0.02F, 0.5F, 0, 1, 0.26F, nullptr, nullptr, 0),
    BRK_D(BReleaseScale, "B Release", "", "resonator_b", Continuous, kAutomatable, 0.001F, 1, 0, 1, 1, nullptr, nullptr, 0),
    BRK_D(BInharmonicity, "B Inharmonicity", "", "resonator_b", Continuous, kAutomatable, 0.0001F, 1, 0.0001F, 0.3F, 0.0001F, nullptr, nullptr, 0),
    BRK_D(BModelRatio, "B Ratio", "", "resonator_b", Continuous, kAutomatable, 0.1F, 10, 0.01F, 0.3F, 1, nullptr, nullptr, 0),
    BRK_D(BLowCut, "B Low Cut", "", "resonator_b", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(BTubeRadius, "B Tube Radius", "", "resonator_b", Continuous, kAutomatable, 0, 1, 0, 1, 0.5F, nullptr, nullptr, 0),
    BRK_D(BCoarseSemitones, "B Coarse", "st", "resonator_b", Stepped, kAutomatable, -48, 48, 1, 1, 0, nullptr, nullptr, 0),
    BRK_D(BFineCents, "B Fine", "ct", "resonator_b", Stepped, kAutomatable, -99, 99, 1, 1, 0, nullptr, nullptr, 0),
    BRK_D(BSpectralFocus, "B Spectral Focus", "%", "resonator_b", Continuous, kAutomatable, 0, 1, 0, 1, 0.25F, nullptr, nullptr, 0),
    BRK_D(BVelocityDecay, "Velocity B Decay", "", "resonator_b_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(BVelocityHitPosition, "Velocity B Hit", "", "resonator_b_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(BVelocityInharmonicity, "Velocity B Inharmonicity", "", "resonator_b_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(BVelocityMaterial, "Velocity B Material", "", "resonator_b_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(BVelocityTone, "Velocity B Tone", "", "resonator_b_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),

    BRK_D(MalletDirect, "Mallet Direct", "%", "mallet", Continuous, kAutomatable, 0, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(MalletResonator, "Mallet Resonator", "%", "mallet", Continuous, kAutomatable, 0, 1, 0, 1, 0.8F, nullptr, nullptr, 0),
    BRK_D(MalletHardnessHz, "Mallet Stiffness", "Hz", "mallet", Continuous, kAutomatable, 100, 5000, 1, 0.3F, 600, nullptr, nullptr, 0),
    BRK_D(MalletKeytrack, "Mallet Keytrack", "%", "mallet", Continuous, kAutomatable, 0, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(MalletVelocityDirect, "Velocity Mallet Direct", "", "mallet_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(MalletVelocityResonator, "Velocity Mallet Resonator", "", "mallet_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(MalletVelocityHardness, "Velocity Mallet Stiffness", "", "mallet_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),

    BRK_D(NoiseEngine, "Noise Engine", "", "noise", Boolean, kHiddenReconfigure, 0, 1, 1, 1, 0, "BRK Burst|RipplerX ADSR", nullptr, 2),
    BRK_D(NoiseDirect, "Noise Direct", "%", "noise", Continuous, kAutomatable, 0, 1, 0.0001F, 0.3F, 0, nullptr, nullptr, 0),
    BRK_D(NoiseResonator, "Noise Resonator", "%", "noise", Continuous, kAutomatable, 0, 1, 0.0001F, 0.3F, 0, nullptr, nullptr, 0),
    BRK_D(NoiseLegacyColor, "Noise Color", "%", "noise", Continuous, kAutomatable, 0, 1, 0, 1, 0.5F, nullptr, nullptr, 0),
    BRK_D(NoiseFilterMode, "Noise Filter", "", "noise", Enum, kReconfigure, 0, 2, 1, 1, 2, "LP|BP|HP", nullptr, 3),
    BRK_D(NoiseFilterFrequencyHz, "Noise Filter Frequency", "Hz", "noise", Continuous, kAutomatable, 20, 20000, 1, 0.3F, 20, nullptr, nullptr, 0),
    BRK_D(NoiseFilterQ, "Noise Filter Q", "Q", "noise", Continuous, kAutomatable, 0.707F, 4, 0, 1, 0.707F, nullptr, nullptr, 0),
    BRK_D(NoiseAttackMs, "Noise Attack", "ms", "noise_envelope", Continuous, kAutomatable, 1, 20000, 1, 0.3F, 1, nullptr, nullptr, 0),
    BRK_D(NoiseDecayMs, "Noise Decay", "ms", "noise_envelope", Continuous, kAutomatable, 1, 20000, 1, 0.3F, 120, nullptr, nullptr, 0),
    BRK_D(NoiseSustain, "Noise Sustain", "%", "noise_envelope", Continuous, kAutomatable, 0, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseReleaseMs, "Noise Release", "ms", "noise_envelope", Continuous, kAutomatable, 1, 20000, 1, 0.3F, 500, nullptr, nullptr, 0),
    BRK_D(NoiseAttackTension, "Noise Attack Tension", "", "noise_envelope", Continuous, kAutomatable, -1, 1, 0, 1, 0.4F, nullptr, nullptr, 0),
    BRK_D(NoiseDecayTension, "Noise Decay Tension", "", "noise_envelope", Continuous, kAutomatable, -1, 1, 0, 1, 0.4F, nullptr, nullptr, 0),
    BRK_D(NoiseReleaseTension, "Noise Release Tension", "", "noise_envelope", Continuous, kAutomatable, -1, 1, 0, 1, 0.4F, nullptr, nullptr, 0),
    BRK_D(NoiseVelocityDirect, "Velocity Noise Direct", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseVelocityResonator, "Velocity Noise Resonator", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseVelocityFrequency, "Velocity Noise Frequency", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseVelocityQ, "Velocity Noise Q", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseVelocityAttack, "Velocity Noise Attack", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseVelocityDecay, "Velocity Noise Decay", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseVelocitySustain, "Velocity Noise Sustain", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),
    BRK_D(NoiseVelocityRelease, "Velocity Noise Release", "", "noise_velocity", Continuous, kAutomatable, -1, 1, 0, 1, 0, nullptr, nullptr, 0),

    BRK_D(VelocityResponse, "Velocity Response", "%", "velocity_macro", Continuous, kAutomatable, 0, 1, 0, 1, 0.85F, nullptr, nullptr, 0),
    BRK_D(VelocityCurve, "Velocity Curve", "", "velocity_macro", Continuous, kAutomatable, 0.25F, 4, 0, 1, 1, nullptr, nullptr, 0),
    BRK_D(VelocityMalletHardness, "Velocity Hardness", "oct", "velocity_macro", Continuous, kAutomatable, -4, 4, 0, 1, 0.75F, nullptr, nullptr, 0),
    BRK_D(VelocityNoiseColor, "Velocity Noise Color", "", "velocity_macro", Continuous, kAutomatable, -1, 1, 0, 1, 0.15F, nullptr, nullptr, 0),
    BRK_D(VelocityDecay, "Velocity Decay", "oct", "velocity_macro", Continuous, kAutomatable, -4, 4, 0, 1, 0.35F, nullptr, nullptr, 0),
    BRK_D(VelocityMaterial, "Velocity Material", "", "velocity_macro", Continuous, kAutomatable, -1, 1, 0, 1, 0.15F, nullptr, nullptr, 0),
    BRK_D(VelocityTone, "Velocity Tone", "", "velocity_macro", Continuous, kAutomatable, -1, 1, 0, 1, 0.2F, nullptr, nullptr, 0),
    BRK_D(VelocityInharmonicity, "Velocity Inharmonicity", "", "velocity_macro", Continuous, kAutomatable, 0, 1, 0, 1, 0.012F, nullptr, nullptr, 0),
};

#undef BRK_D

inline float clamp01(float value) noexcept { return std::max(0.0F, std::min(1.0F, value)); }

inline float snap_plain(const ParameterDescriptor& descriptor, float value) noexcept {
    value = std::max(descriptor.plain_min, std::min(descriptor.plain_max, value));
    if (descriptor.plain_step > 0.0F) {
        value = descriptor.plain_min + descriptor.plain_step *
            std::floor((value - descriptor.plain_min) / descriptor.plain_step + 0.5F);
        value = std::max(descriptor.plain_min, std::min(descriptor.plain_max, value));
    }
    return value;
}

inline std::uint32_t nearest_enum_index(const ParameterDescriptor& descriptor, float plain) noexcept {
    if (descriptor.enum_value_count == 0U) return 0U;
    if (descriptor.enum_plain_values == nullptr) {
        const auto index = static_cast<std::int32_t>(std::lround(plain - descriptor.plain_min));
        return static_cast<std::uint32_t>(std::max<std::int32_t>(0, std::min<std::int32_t>(
            static_cast<std::int32_t>(descriptor.enum_value_count - 1U), index)));
    }
    std::uint32_t best = 0U;
    float best_distance = std::abs(plain - descriptor.enum_plain_values[0]);
    for (std::uint32_t i = 1U; i < descriptor.enum_value_count; ++i) {
        const float distance = std::abs(plain - descriptor.enum_plain_values[i]);
        if (distance < best_distance) {
            best = i;
            best_distance = distance;
        }
    }
    return best;
}

} // namespace parameter_detail

inline constexpr std::size_t kParameterDescriptorCount =
    sizeof(parameter_detail::kDescriptors) / sizeof(parameter_detail::kDescriptors[0]);
static_assert(kParameterDescriptorCount == kParameterCount, "every parameter identity needs metadata");

inline const ParameterDescriptor* parameter_descriptor(ParameterId id) noexcept {
    for (const auto& descriptor : parameter_detail::kDescriptors) {
        if (descriptor.id == id) return &descriptor;
    }
    return nullptr;
}

inline const ParameterDescriptor* parameter_descriptor_at(std::size_t index) noexcept {
    return index < kParameterDescriptorCount ? &parameter_detail::kDescriptors[index] : nullptr;
}

inline bool parameter_supports_sample_accurate_events(const ParameterDescriptor& descriptor) noexcept {
    return (descriptor.flags & ParameterModulatable) != 0U
        && (descriptor.flags & (ParameterReadOnly | ParameterRequiresReconfigure)) == 0U;
}

inline bool parameter_supports_block_value(const ParameterDescriptor& descriptor) noexcept {
    return (descriptor.flags & ParameterReadOnly) == 0U
        && (descriptor.flags & (ParameterAutomatable | ParameterRequiresReconfigure)) != 0U;
}

inline float parameter_plain_from_normalized(const ParameterDescriptor& descriptor, float normalized) noexcept {
    normalized = parameter_detail::clamp01(normalized);
    if (descriptor.type == ParameterType::Boolean) return normalized >= 0.5F ? 1.0F : 0.0F;
    if (descriptor.type == ParameterType::Enum) {
        const auto count = descriptor.enum_value_count;
        if (count <= 1U) return descriptor.plain_min;
        const auto index = static_cast<std::uint32_t>(std::lround(normalized * static_cast<float>(count - 1U)));
        return descriptor.enum_plain_values == nullptr
            ? descriptor.plain_min + static_cast<float>(index)
            : descriptor.enum_plain_values[std::min(index, count - 1U)];
    }
    const float proportion = descriptor.skew == 1.0F || normalized <= 0.0F
        ? normalized
        : std::exp(std::log(normalized) / descriptor.skew);
    return parameter_detail::snap_plain(
        descriptor,
        descriptor.plain_min + (descriptor.plain_max - descriptor.plain_min) * proportion);
}

inline float parameter_normalized_from_plain(const ParameterDescriptor& descriptor, float plain) noexcept {
    if (descriptor.type == ParameterType::Boolean) return plain >= 0.5F ? 1.0F : 0.0F;
    if (descriptor.type == ParameterType::Enum) {
        if (descriptor.enum_value_count <= 1U) return 0.0F;
        return static_cast<float>(parameter_detail::nearest_enum_index(descriptor, plain)) /
            static_cast<float>(descriptor.enum_value_count - 1U);
    }
    const float snapped = parameter_detail::snap_plain(descriptor, plain);
    const float proportion = parameter_detail::clamp01(
        (snapped - descriptor.plain_min) / (descriptor.plain_max - descriptor.plain_min));
    return descriptor.skew == 1.0F ? proportion : std::pow(proportion, descriptor.skew);
}

inline float parameter_default_normalized(const ParameterDescriptor& descriptor) noexcept {
    return parameter_normalized_from_plain(descriptor, descriptor.plain_default);
}

inline bool get_parameter_plain(const Patch& patch, ParameterId id, float& value) noexcept {
#define BRK_GET(id_, expression_) case ParameterId::id_: value = static_cast<float>(expression_); return true
    switch (id) {
    BRK_GET(Coupling, patch.coupling);
    BRK_GET(ParallelMix, patch.parallel_mix);
    BRK_GET(CouplingSplit, patch.coupling_split);
    BRK_GET(ResonatorGainDb, patch.resonator_gain_db);
    BRK_GET(CouplingProfile, patch.coupling_profile);
    BRK_GET(MaxCouplingDetuneCents, patch.max_coupling_detune_cents);
    BRK_GET(ReleaseMode, patch.release_mode);
    BRK_GET(RetriggerDeclickMs, patch.retrigger_declick_ms);
    BRK_GET(OutputGainDb, patch.output_gain_db);
    BRK_GET(StereoMode, patch.stereo_mode);
    BRK_GET(StereoWidth, patch.stereo_width);
    BRK_GET(Polyphony, patch.polyphony);
    BRK_GET(AEnabled, patch.resonator_a.enabled);
    BRK_GET(AModel, patch.resonator_a.model);
    BRK_GET(APartials, patch.resonator_a.partials);
    BRK_GET(ADecaySeconds, patch.resonator_a.decay_seconds);
    BRK_GET(AMaterial, patch.resonator_a.material);
    BRK_GET(ATone, patch.resonator_a.tone);
    BRK_GET(AHitPosition, patch.resonator_a.hit_position);
    BRK_GET(AReleaseScale, patch.resonator_a.release_scale);
    BRK_GET(AInharmonicity, patch.resonator_a.inharmonicity);
    BRK_GET(AModelRatio, patch.resonator_a.ratio);
    BRK_GET(ALowCut, patch.resonator_a.low_cut);
    BRK_GET(ATubeRadius, patch.resonator_a.tube_radius);
    BRK_GET(ACoarseSemitones, patch.resonator_a.coarse_semitones);
    BRK_GET(AFineCents, patch.resonator_a.fine_cents);
    BRK_GET(ASpectralFocus, patch.resonator_a.spectral_focus);
    BRK_GET(AVelocityDecay, patch.resonator_a.upstream_velocity.decay);
    BRK_GET(AVelocityHitPosition, patch.resonator_a.upstream_velocity.hit_position);
    BRK_GET(AVelocityInharmonicity, patch.resonator_a.upstream_velocity.inharmonicity);
    BRK_GET(AVelocityMaterial, patch.resonator_a.upstream_velocity.material);
    BRK_GET(AVelocityTone, patch.resonator_a.upstream_velocity.tone);
    BRK_GET(BEnabled, patch.resonator_b.enabled);
    BRK_GET(BModel, patch.resonator_b.model);
    BRK_GET(BPartials, patch.resonator_b.partials);
    BRK_GET(BDecaySeconds, patch.resonator_b.decay_seconds);
    BRK_GET(BMaterial, patch.resonator_b.material);
    BRK_GET(BTone, patch.resonator_b.tone);
    BRK_GET(BHitPosition, patch.resonator_b.hit_position);
    BRK_GET(BReleaseScale, patch.resonator_b.release_scale);
    BRK_GET(BInharmonicity, patch.resonator_b.inharmonicity);
    BRK_GET(BModelRatio, patch.resonator_b.ratio);
    BRK_GET(BLowCut, patch.resonator_b.low_cut);
    BRK_GET(BTubeRadius, patch.resonator_b.tube_radius);
    BRK_GET(BCoarseSemitones, patch.resonator_b.coarse_semitones);
    BRK_GET(BFineCents, patch.resonator_b.fine_cents);
    BRK_GET(BSpectralFocus, patch.resonator_b.spectral_focus);
    BRK_GET(BVelocityDecay, patch.resonator_b.upstream_velocity.decay);
    BRK_GET(BVelocityHitPosition, patch.resonator_b.upstream_velocity.hit_position);
    BRK_GET(BVelocityInharmonicity, patch.resonator_b.upstream_velocity.inharmonicity);
    BRK_GET(BVelocityMaterial, patch.resonator_b.upstream_velocity.material);
    BRK_GET(BVelocityTone, patch.resonator_b.upstream_velocity.tone);
    BRK_GET(MalletDirect, patch.exciter.mallet_direct);
    BRK_GET(MalletResonator, patch.exciter.mallet_resonator);
    BRK_GET(MalletHardnessHz, patch.exciter.mallet_hardness_hz);
    BRK_GET(MalletKeytrack, patch.exciter.mallet_keytrack);
    BRK_GET(MalletVelocityDirect, patch.exciter.mallet_velocity_direct);
    BRK_GET(MalletVelocityResonator, patch.exciter.mallet_velocity_resonator);
    BRK_GET(MalletVelocityHardness, patch.exciter.mallet_velocity_hardness);
    BRK_GET(NoiseEngine, patch.exciter.use_upstream_noise);
    BRK_GET(NoiseDirect, patch.exciter.noise_direct);
    BRK_GET(NoiseResonator, patch.exciter.noise_resonator);
    BRK_GET(NoiseLegacyColor, patch.exciter.noise_color);
    BRK_GET(NoiseFilterMode, patch.exciter.noise_filter_mode);
    BRK_GET(NoiseFilterFrequencyHz, patch.exciter.noise_filter_frequency_hz);
    BRK_GET(NoiseFilterQ, patch.exciter.noise_filter_q);
    BRK_GET(NoiseAttackMs, patch.exciter.noise_attack_ms);
    BRK_GET(NoiseDecayMs, patch.exciter.noise_decay_ms);
    BRK_GET(NoiseSustain, patch.exciter.noise_sustain);
    BRK_GET(NoiseReleaseMs, patch.exciter.noise_release_ms);
    BRK_GET(NoiseAttackTension, patch.exciter.noise_attack_tension);
    BRK_GET(NoiseDecayTension, patch.exciter.noise_decay_tension);
    BRK_GET(NoiseReleaseTension, patch.exciter.noise_release_tension);
    BRK_GET(NoiseVelocityDirect, patch.exciter.noise_velocity_direct);
    BRK_GET(NoiseVelocityResonator, patch.exciter.noise_velocity_resonator);
    BRK_GET(NoiseVelocityFrequency, patch.exciter.noise_velocity_frequency);
    BRK_GET(NoiseVelocityQ, patch.exciter.noise_velocity_q);
    BRK_GET(NoiseVelocityAttack, patch.exciter.noise_velocity_attack);
    BRK_GET(NoiseVelocityDecay, patch.exciter.noise_velocity_decay);
    BRK_GET(NoiseVelocitySustain, patch.exciter.noise_velocity_sustain);
    BRK_GET(NoiseVelocityRelease, patch.exciter.noise_velocity_release);
    BRK_GET(VelocityResponse, patch.velocity.response);
    BRK_GET(VelocityCurve, patch.velocity.curve);
    BRK_GET(VelocityMalletHardness, patch.velocity.mallet_hardness_octaves);
    BRK_GET(VelocityNoiseColor, patch.velocity.noise_color);
    BRK_GET(VelocityDecay, patch.velocity.decay_octaves);
    BRK_GET(VelocityMaterial, patch.velocity.material);
    BRK_GET(VelocityTone, patch.velocity.tone);
    BRK_GET(VelocityInharmonicity, patch.velocity.inharmonicity);
    }
#undef BRK_GET
    return false;
}

inline bool set_parameter_plain(Patch& patch, ParameterId id, float plain) noexcept {
    const auto* descriptor = parameter_descriptor(id);
    if (descriptor == nullptr || !std::isfinite(plain)) return false;
    plain = parameter_plain_from_normalized(*descriptor, parameter_normalized_from_plain(*descriptor, plain));
#define BRK_SET(id_, target_) case ParameterId::id_: target_ = plain; return true
#define BRK_SET_BOOL(id_, target_) case ParameterId::id_: target_ = plain >= 0.5F; return true
#define BRK_SET_ENUM(id_, type_, target_) case ParameterId::id_: target_ = static_cast<type_>(static_cast<std::uint32_t>(std::lround(plain))); return true
#define BRK_SET_U8(id_, target_) case ParameterId::id_: target_ = static_cast<std::uint8_t>(std::lround(plain)); return true
    switch (id) {
    BRK_SET_ENUM(Coupling, Coupling, patch.coupling);
    BRK_SET(ParallelMix, patch.parallel_mix);
    BRK_SET(CouplingSplit, patch.coupling_split);
    BRK_SET(ResonatorGainDb, patch.resonator_gain_db);
    BRK_SET_ENUM(CouplingProfile, CouplingProfile, patch.coupling_profile);
    BRK_SET(MaxCouplingDetuneCents, patch.max_coupling_detune_cents);
    BRK_SET_ENUM(ReleaseMode, ReleaseMode, patch.release_mode);
    BRK_SET(RetriggerDeclickMs, patch.retrigger_declick_ms);
    BRK_SET(OutputGainDb, patch.output_gain_db);
    BRK_SET_ENUM(StereoMode, StereoMode, patch.stereo_mode);
    BRK_SET(StereoWidth, patch.stereo_width);
    BRK_SET_U8(Polyphony, patch.polyphony);
    BRK_SET_BOOL(AEnabled, patch.resonator_a.enabled);
    BRK_SET_ENUM(AModel, Model, patch.resonator_a.model);
    BRK_SET_U8(APartials, patch.resonator_a.partials);
    BRK_SET(ADecaySeconds, patch.resonator_a.decay_seconds);
    BRK_SET(AMaterial, patch.resonator_a.material);
    BRK_SET(ATone, patch.resonator_a.tone);
    BRK_SET(AHitPosition, patch.resonator_a.hit_position);
    BRK_SET(AReleaseScale, patch.resonator_a.release_scale);
    BRK_SET(AInharmonicity, patch.resonator_a.inharmonicity);
    BRK_SET(AModelRatio, patch.resonator_a.ratio);
    BRK_SET(ALowCut, patch.resonator_a.low_cut);
    BRK_SET(ATubeRadius, patch.resonator_a.tube_radius);
    BRK_SET(ACoarseSemitones, patch.resonator_a.coarse_semitones);
    BRK_SET(AFineCents, patch.resonator_a.fine_cents);
    BRK_SET(ASpectralFocus, patch.resonator_a.spectral_focus);
    BRK_SET(AVelocityDecay, patch.resonator_a.upstream_velocity.decay);
    BRK_SET(AVelocityHitPosition, patch.resonator_a.upstream_velocity.hit_position);
    BRK_SET(AVelocityInharmonicity, patch.resonator_a.upstream_velocity.inharmonicity);
    BRK_SET(AVelocityMaterial, patch.resonator_a.upstream_velocity.material);
    BRK_SET(AVelocityTone, patch.resonator_a.upstream_velocity.tone);
    BRK_SET_BOOL(BEnabled, patch.resonator_b.enabled);
    BRK_SET_ENUM(BModel, Model, patch.resonator_b.model);
    BRK_SET_U8(BPartials, patch.resonator_b.partials);
    BRK_SET(BDecaySeconds, patch.resonator_b.decay_seconds);
    BRK_SET(BMaterial, patch.resonator_b.material);
    BRK_SET(BTone, patch.resonator_b.tone);
    BRK_SET(BHitPosition, patch.resonator_b.hit_position);
    BRK_SET(BReleaseScale, patch.resonator_b.release_scale);
    BRK_SET(BInharmonicity, patch.resonator_b.inharmonicity);
    BRK_SET(BModelRatio, patch.resonator_b.ratio);
    BRK_SET(BLowCut, patch.resonator_b.low_cut);
    BRK_SET(BTubeRadius, patch.resonator_b.tube_radius);
    BRK_SET(BCoarseSemitones, patch.resonator_b.coarse_semitones);
    BRK_SET(BFineCents, patch.resonator_b.fine_cents);
    BRK_SET(BSpectralFocus, patch.resonator_b.spectral_focus);
    BRK_SET(BVelocityDecay, patch.resonator_b.upstream_velocity.decay);
    BRK_SET(BVelocityHitPosition, patch.resonator_b.upstream_velocity.hit_position);
    BRK_SET(BVelocityInharmonicity, patch.resonator_b.upstream_velocity.inharmonicity);
    BRK_SET(BVelocityMaterial, patch.resonator_b.upstream_velocity.material);
    BRK_SET(BVelocityTone, patch.resonator_b.upstream_velocity.tone);
    BRK_SET(MalletDirect, patch.exciter.mallet_direct);
    BRK_SET(MalletResonator, patch.exciter.mallet_resonator);
    BRK_SET(MalletHardnessHz, patch.exciter.mallet_hardness_hz);
    BRK_SET(MalletKeytrack, patch.exciter.mallet_keytrack);
    BRK_SET(MalletVelocityDirect, patch.exciter.mallet_velocity_direct);
    BRK_SET(MalletVelocityResonator, patch.exciter.mallet_velocity_resonator);
    BRK_SET(MalletVelocityHardness, patch.exciter.mallet_velocity_hardness);
    BRK_SET_BOOL(NoiseEngine, patch.exciter.use_upstream_noise);
    BRK_SET(NoiseDirect, patch.exciter.noise_direct);
    BRK_SET(NoiseResonator, patch.exciter.noise_resonator);
    BRK_SET(NoiseLegacyColor, patch.exciter.noise_color);
    BRK_SET_ENUM(NoiseFilterMode, NoiseFilterMode, patch.exciter.noise_filter_mode);
    BRK_SET(NoiseFilterFrequencyHz, patch.exciter.noise_filter_frequency_hz);
    BRK_SET(NoiseFilterQ, patch.exciter.noise_filter_q);
    BRK_SET(NoiseAttackMs, patch.exciter.noise_attack_ms);
    BRK_SET(NoiseDecayMs, patch.exciter.noise_decay_ms);
    BRK_SET(NoiseSustain, patch.exciter.noise_sustain);
    BRK_SET(NoiseReleaseMs, patch.exciter.noise_release_ms);
    BRK_SET(NoiseAttackTension, patch.exciter.noise_attack_tension);
    BRK_SET(NoiseDecayTension, patch.exciter.noise_decay_tension);
    BRK_SET(NoiseReleaseTension, patch.exciter.noise_release_tension);
    BRK_SET(NoiseVelocityDirect, patch.exciter.noise_velocity_direct);
    BRK_SET(NoiseVelocityResonator, patch.exciter.noise_velocity_resonator);
    BRK_SET(NoiseVelocityFrequency, patch.exciter.noise_velocity_frequency);
    BRK_SET(NoiseVelocityQ, patch.exciter.noise_velocity_q);
    BRK_SET(NoiseVelocityAttack, patch.exciter.noise_velocity_attack);
    BRK_SET(NoiseVelocityDecay, patch.exciter.noise_velocity_decay);
    BRK_SET(NoiseVelocitySustain, patch.exciter.noise_velocity_sustain);
    BRK_SET(NoiseVelocityRelease, patch.exciter.noise_velocity_release);
    BRK_SET(VelocityResponse, patch.velocity.response);
    BRK_SET(VelocityCurve, patch.velocity.curve);
    BRK_SET(VelocityMalletHardness, patch.velocity.mallet_hardness_octaves);
    BRK_SET(VelocityNoiseColor, patch.velocity.noise_color);
    BRK_SET(VelocityDecay, patch.velocity.decay_octaves);
    BRK_SET(VelocityMaterial, patch.velocity.material);
    BRK_SET(VelocityTone, patch.velocity.tone);
    BRK_SET(VelocityInharmonicity, patch.velocity.inharmonicity);
    }
#undef BRK_SET_U8
#undef BRK_SET_ENUM
#undef BRK_SET_BOOL
#undef BRK_SET
    return false;
}

inline bool get_parameter_normalized(const Patch& patch, ParameterId id, float& normalized) noexcept {
    const auto* descriptor = parameter_descriptor(id);
    float plain = 0.0F;
    if (descriptor == nullptr || !get_parameter_plain(patch, id, plain)) return false;
    normalized = parameter_normalized_from_plain(*descriptor, plain);
    return true;
}

inline bool set_parameter_normalized(Patch& patch, ParameterId id, float normalized) noexcept {
    const auto* descriptor = parameter_descriptor(id);
    return descriptor != nullptr && std::isfinite(normalized) &&
        set_parameter_plain(patch, id, parameter_plain_from_normalized(*descriptor, normalized));
}

} // namespace brk::modal
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace brk::modal {

// IDs are grouped by semantic ownership. Removed IDs are tombstoned and never reused.
// List order is descriptive only and is not identity.
#define BRK_MODAL_PARAMETER_IDENTITIES(X) \
    X(Coupling,                    0x0001u, "couple") \
    X(ParallelMix,                 0x0002u, "ab_mix") \
    X(CouplingSplit,               0x0003u, "ab_split") \
    X(ResonatorGainDb,             0x0004u, "gain") \
    X(CouplingProfile,             0x0010u, "brk.coupling_profile") \
    X(MaxCouplingDetuneCents,      0x0011u, "brk.max_coupling_detune_cents") \
    X(ReleaseMode,                 0x0012u, "brk.release_mode") \
    X(RetriggerDeclickMs,          0x0013u, "brk.retrigger_declick_ms") \
    X(OutputGainDb,                0x0014u, "brk.output_gain_db") \
    X(StereoMode,                  0x0015u, "brk.stereo_mode") \
    X(StereoWidth,                 0x0016u, "brk.stereo_width") \
    X(Polyphony,                   0x0017u, "brk.polyphony") \
    X(AEnabled,                    0x1000u, "a_on") \
    X(AModel,                      0x1001u, "a_model") \
    X(APartials,                   0x1002u, "a_partials") \
    X(ADecaySeconds,               0x1003u, "a_decay") \
    X(AMaterial,                   0x1004u, "a_damp") \
    X(ATone,                       0x1005u, "a_tone") \
    X(AHitPosition,                0x1006u, "a_hit") \
    X(AReleaseScale,               0x1007u, "a_rel") \
    X(AInharmonicity,              0x1008u, "a_inharm") \
    X(AModelRatio,                 0x1009u, "a_ratio") \
    X(ALowCut,                     0x100au, "a_cut") \
    X(ATubeRadius,                 0x100bu, "a_radius") \
    X(ACoarseSemitones,            0x100cu, "a_coarse") \
    X(AFineCents,                  0x100du, "a_fine") \
    X(ASpectralFocus,              0x1010u, "brk.a_spectral_focus") \
    X(AVelocityDecay,              0x1080u, "vel_a_decay") \
    X(AVelocityHitPosition,        0x1081u, "vel_a_hit") \
    X(AVelocityInharmonicity,      0x1082u, "vel_a_inharm") \
    X(AVelocityMaterial,           0x1083u, "vel_a_damp") \
    X(AVelocityTone,               0x1084u, "vel_a_tone") \
    X(BEnabled,                    0x2000u, "b_on") \
    X(BModel,                      0x2001u, "b_model") \
    X(BPartials,                   0x2002u, "b_partials") \
    X(BDecaySeconds,               0x2003u, "b_decay") \
    X(BMaterial,                   0x2004u, "b_damp") \
    X(BTone,                       0x2005u, "b_tone") \
    X(BHitPosition,                0x2006u, "b_hit") \
    X(BReleaseScale,               0x2007u, "b_rel") \
    X(BInharmonicity,              0x2008u, "b_inharm") \
    X(BModelRatio,                 0x2009u, "b_ratio") \
    X(BLowCut,                     0x200au, "b_cut") \
    X(BTubeRadius,                 0x200bu, "b_radius") \
    X(BCoarseSemitones,            0x200cu, "b_coarse") \
    X(BFineCents,                  0x200du, "b_fine") \
    X(BSpectralFocus,              0x2010u, "brk.b_spectral_focus") \
    X(BVelocityDecay,              0x2080u, "vel_b_decay") \
    X(BVelocityHitPosition,        0x2081u, "vel_b_hit") \
    X(BVelocityInharmonicity,      0x2082u, "vel_b_inharm") \
    X(BVelocityMaterial,           0x2083u, "vel_b_damp") \
    X(BVelocityTone,               0x2084u, "vel_b_tone") \
    X(MalletDirect,                0x3000u, "mallet_mix") \
    X(MalletResonator,             0x3001u, "mallet_res") \
    X(MalletHardnessHz,            0x3002u, "mallet_stiff") \
    X(MalletKeytrack,              0x3003u, "mallet_ktrack") \
    X(MalletVelocityDirect,        0x3080u, "vel_mallet_mix") \
    X(MalletVelocityResonator,     0x3081u, "vel_mallet_res") \
    X(MalletVelocityHardness,      0x3082u, "vel_mallet_stiff") \
    X(NoiseEngine,                 0x3100u, "brk.noise_engine") \
    X(NoiseDirect,                 0x3101u, "noise_mix") \
    X(NoiseResonator,              0x3102u, "noise_res") \
    X(NoiseLegacyColor,            0x3103u, "brk.noise_color") \
    X(NoiseFilterMode,             0x3110u, "noise_filter_mode") \
    X(NoiseFilterFrequencyHz,      0x3111u, "noise_filter_freq") \
    X(NoiseFilterQ,                0x3112u, "noise_filter_q") \
    X(NoiseAttackMs,               0x3120u, "noise_att") \
    X(NoiseDecayMs,                0x3121u, "noise_dec") \
    X(NoiseSustain,                0x3122u, "noise_sus") \
    X(NoiseReleaseMs,              0x3123u, "noise_rel") \
    X(NoiseAttackTension,          0x3124u, "noise_att_ten") \
    X(NoiseDecayTension,           0x3125u, "noise_dec_ten") \
    X(NoiseReleaseTension,         0x3126u, "noise_rel_ten") \
    X(NoiseVelocityDirect,         0x3180u, "vel_noise_mix") \
    X(NoiseVelocityResonator,      0x3181u, "vel_noise_res") \
    X(NoiseVelocityFrequency,      0x3182u, "vel_noise_freq") \
    X(NoiseVelocityQ,              0x3183u, "vel_noise_q") \
    X(NoiseVelocityAttack,         0x3184u, "vel_noise_att") \
    X(NoiseVelocityDecay,          0x3185u, "vel_noise_dec") \
    X(NoiseVelocitySustain,        0x3186u, "vel_noise_sus") \
    X(NoiseVelocityRelease,        0x3187u, "vel_noise_rel") \
    X(VelocityResponse,            0x4000u, "brk.velocity.response") \
    X(VelocityCurve,               0x4001u, "brk.velocity.curve") \
    X(VelocityMalletHardness,      0x4002u, "brk.velocity.mallet_hardness_octaves") \
    X(VelocityNoiseColor,          0x4003u, "brk.velocity.noise_color") \
    X(VelocityDecay,               0x4004u, "brk.velocity.decay_octaves") \
    X(VelocityMaterial,            0x4005u, "brk.velocity.material") \
    X(VelocityTone,                0x4006u, "brk.velocity.tone") \
    X(VelocityInharmonicity,       0x4007u, "brk.velocity.inharmonicity")

enum class ParameterId : std::uint32_t {
#define BRK_MODAL_DECLARE_PARAMETER(name, id, key) name = id,
    BRK_MODAL_PARAMETER_IDENTITIES(BRK_MODAL_DECLARE_PARAMETER)
#undef BRK_MODAL_DECLARE_PARAMETER
};

struct ParameterIdentity {
    ParameterId id;
    const char* key;
};

inline constexpr ParameterIdentity kParameterIdentities[] = {
#define BRK_MODAL_PARAMETER_IDENTITY(name, id, key) {ParameterId::name, key},
    BRK_MODAL_PARAMETER_IDENTITIES(BRK_MODAL_PARAMETER_IDENTITY)
#undef BRK_MODAL_PARAMETER_IDENTITY
};

inline constexpr std::size_t kParameterCount =
    sizeof(kParameterIdentities) / sizeof(kParameterIdentities[0]);

inline constexpr const char* parameter_key(ParameterId id) noexcept {
    for (const auto& identity : kParameterIdentities) {
        if (identity.id == id) return identity.key;
    }
    return nullptr;
}

inline bool parameter_id_from_key(const char* key, ParameterId& result) noexcept {
    if (key == nullptr) return false;
    for (const auto& identity : kParameterIdentities) {
        if (std::strcmp(identity.key, key) == 0) {
            result = identity.id;
            return true;
        }
    }
    return false;
}

#undef BRK_MODAL_PARAMETER_IDENTITIES

} // namespace brk::modal

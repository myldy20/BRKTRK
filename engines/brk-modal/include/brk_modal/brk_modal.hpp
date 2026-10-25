#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>

namespace brk::modal {

constexpr std::size_t kMaxVoices = 16;
constexpr std::size_t kMaxPartials = 64;
constexpr std::size_t kWaveguideFrames = 4096;
constexpr const char* kRipplerXUpstreamVersion = "1.5.18";

enum class Model : std::uint8_t {
    String = 0,
    Beam,
    Squared,
    Membrane,
    Plate,
    Drumhead,
    Marimba,
    OpenTube,
    ClosedTube,
    Marimba2,
    Bell,
    Djembe,
};

enum class Coupling : std::uint8_t {
    Parallel = 0,
    Serial = 1,
};

enum class CouplingProfile : std::uint8_t {
    Stable = 0,
    Reference = 1,
    Wild = 2,
};

enum class StereoMode : std::uint8_t {
    Mono = 0,
    Comb = 1,
    VoiceSpread = 2,
};

enum class ReleaseMode : std::uint8_t {
    Damped = 0,
    Natural = 1,
    OneShot = 2,
};

enum class NoiseFilterMode : std::uint8_t {
    LowPass = 0,
    BandPass = 1,
    HighPass = 2,
};

enum class FactoryPatch : std::uint8_t {
    GlassString = 0,
    WoodenBar,
    DeepMembrane,
    SoftPlate,
    BreathingTube,
    RitualBell,
};

// Runtime-only quality policy. It is deliberately not part of Patch state or ABI v1.
// Hosts may retain the untouched source Patch and reapply a profile at any time.
enum class QualityProfile : std::uint8_t {
    Full = 0,
    Balanced,
    Economy,
    Draft,
};

// Runtime-only modal processing policy. This is not serialized and is not part
// of ABI v1. Auto resolves to the best compiled four-lane kernel, while Scalar
// remains the correctness oracle and deterministic fallback.
enum class ModalKernel : std::uint8_t {
    Auto = 0,
    Scalar,
    Vector4,
};

// Runtime-only terminal-tail work policy. Conservative sleep is deliberately
// separate from modal quality profiles: it never removes authored modes or
// voices while they are audible. Disabled remains the exact no-sleep oracle.
enum class TailPolicy : std::uint8_t {
    Disabled = 0,
    Conservative,
};

// Runtime-only legacy Reference output-mode values. Normal is the production
// path. SafeHeadroom/RawHeadroom are retained temporarily as non-serialized
// compatibility aliases only; after physical acceptance on 2026-08-12 all three
// resolve to the same transparent fixed-headroom Reference signal path.
enum class ReferenceOutputMode : std::uint8_t {
    Normal = 0,
    SafeHeadroom,
    RawHeadroom,
};

struct TailSleepStats {
    std::uint64_t entries = 0;
    std::uint64_t recycled_voices = 0;
    std::uint64_t retired_voices = 0;
    std::uint64_t skipped_voice_frames = 0;
};

struct QualityProfileSpec {
    std::uint8_t modal_cap = static_cast<std::uint8_t>(kMaxPartials);
    std::uint8_t polyphony_cap = static_cast<std::uint8_t>(kMaxVoices);
    bool force_mono = false;
};

struct ResonatorVelocityPatch {
    float decay = 0.0F;
    float hit_position = 0.0F;
    float inharmonicity = 0.0F;
    float material = 0.0F;
    float tone = 0.0F;
};

struct ResonatorPatch {
    bool enabled = true;
    Model model = Model::String;
    std::uint8_t partials = 32;
    float decay_seconds = 1.0F;
    float material = 0.0F;
    float tone = 0.0F;
    float hit_position = 0.26F;
    float release_scale = 1.0F;
    float inharmonicity = 0.0001F;
    float ratio = 1.0F;
    float low_cut = 0.0F;
    float coarse_semitones = 0.0F;
    float fine_cents = 0.0F;
    float tube_radius = 0.5F;
    float spectral_focus = 0.25F;
    ResonatorVelocityPatch upstream_velocity{};

    // BRK patches default to level-stable modal normalization. Imported upstream
    // programs disable it so the original per-partial gain and A/B balance survive.
    bool normalize_modal_energy = true;

    // Runtime render budget. The authored partial count remains untouched so a host
    // can switch quality profiles without destructively editing the preset.
    std::uint8_t max_render_partials = static_cast<std::uint8_t>(kMaxPartials);
};

struct ExciterPatch {
    float mallet_direct = 0.0F;
    float mallet_resonator = 0.8F;
    float mallet_hardness_hz = 600.0F;
    float mallet_keytrack = 0.0F;
    float mallet_velocity_direct = 0.0F;
    float mallet_velocity_resonator = 0.0F;
    float mallet_velocity_hardness = 0.0F;

    // BRK legacy colored burst. Retained for existing downstream patches.
    bool use_upstream_noise = false;
    float noise_direct = 0.0F;
    float noise_resonator = 0.0F;
    float noise_decay_ms = 120.0F;
    float noise_color = 0.5F;

    // RipplerX-compatible filtered ADSR path.
    NoiseFilterMode noise_filter_mode = NoiseFilterMode::HighPass;
    float noise_filter_frequency_hz = 20.0F;
    float noise_filter_q = 0.707F;
    float noise_attack_ms = 1.0F;
    float noise_sustain = 0.0F;
    float noise_release_ms = 500.0F;
    float noise_attack_tension = 0.4F;
    float noise_decay_tension = 0.4F;
    float noise_release_tension = 0.4F;
    float noise_velocity_direct = 0.0F;
    float noise_velocity_resonator = 0.0F;
    float noise_velocity_frequency = 0.0F;
    float noise_velocity_q = 0.0F;
    float noise_velocity_attack = 0.0F;
    float noise_velocity_decay = 0.0F;
    float noise_velocity_sustain = 0.0F;
    float noise_velocity_release = 0.0F;
};

// Downstream BRK macro-velocity layer. Upstream routes above remain exact and separate.
struct VelocityPatch {
    float response = 0.85F;
    float curve = 1.0F;
    float mallet_hardness_octaves = 0.75F;
    float noise_color = 0.15F;
    float decay_octaves = 0.35F;
    float material = 0.15F;
    float tone = 0.20F;
    float inharmonicity = 0.012F;
};

struct Patch {
    ResonatorPatch resonator_a{};
    ResonatorPatch resonator_b{false, Model::Beam};
    ExciterPatch exciter{};
    VelocityPatch velocity{};
    Coupling coupling = Coupling::Parallel;
    CouplingProfile coupling_profile = CouplingProfile::Stable;
    ReleaseMode release_mode = ReleaseMode::Damped;
    float parallel_mix = 0.5F;
    float coupling_split = 0.01F;
    float max_coupling_detune_cents = 28.0F;
    float retrigger_declick_ms = 2.5F;
    float resonator_gain_db = 12.0F;
    float output_gain_db = -3.0F;
    StereoMode stereo_mode = StereoMode::Comb;
    float stereo_width = 1.0F;
    std::uint8_t polyphony = 12;
};

struct NoteOn {
    std::uint32_t note_id = 0;
    std::int16_t key = 60;
    float velocity = 1.0F;
    float tuning_semitones = 0.0F;
};

Patch make_factory_patch(FactoryPatch preset) noexcept;
const char* factory_patch_name(FactoryPatch preset) noexcept;

QualityProfileSpec quality_profile_spec(QualityProfile profile) noexcept;
const char* quality_profile_name(QualityProfile profile) noexcept;
Patch apply_quality_profile(const Patch& source, QualityProfile profile) noexcept;
std::size_t estimated_modal_work_units(const Patch& patch) noexcept;
const char* modal_kernel_name(ModalKernel kernel) noexcept;
bool modal_vector_kernel_available() noexcept;
const char* modal_vector_kernel_backend() noexcept;
const char* tail_policy_name(TailPolicy policy) noexcept;

class Engine {
public:
    Engine() noexcept;
    ~Engine() noexcept;
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;
    Engine(Engine&&) noexcept;
    Engine& operator=(Engine&&) noexcept;

    bool prepare(double sample_rate, std::uint32_t max_block_frames, std::uint64_t deterministic_seed) noexcept;
    void reset() noexcept;
    void set_patch(const Patch& patch) noexcept;
    // Internal live-automation specializations. They are not ABI/state surface.
    void set_live_decay_patch(const Patch& patch, bool update_a, bool update_b) noexcept;
    void set_live_performance_patch(
        const Patch& patch,
        bool update_a_decay, bool update_a_material, bool update_a_tone,
        bool update_b_decay, bool update_b_material, bool update_b_tone,
        bool update_width) noexcept;
    void set_live_gain_patch(
        const Patch& patch,
        bool update_resonator_gain,
        bool update_output_gain) noexcept;
    [[nodiscard]] const Patch& patch() const noexcept { return patch_; }

    // Kernel selection is runtime-only and may be changed between process calls.
    // Modal histories use one shared structure-of-arrays layout, so switching does
    // not reset voices or alter serialized state.
    void set_modal_kernel(ModalKernel kernel) noexcept;
    [[nodiscard]] ModalKernel modal_kernel() const noexcept;
    [[nodiscard]] ModalKernel active_modal_kernel() const noexcept;

    // Conservative tail sleeping is runtime-only and does not alter Patch or
    // state v1. Disabling the policy retires already-sleeping terminal tails
    // rather than resuming time-frozen sub-audible state.
    void set_tail_policy(TailPolicy policy) noexcept;
    [[nodiscard]] TailPolicy tail_policy() const noexcept;

    // Diagnostic-only Reference output A/B; outside Patch, ABI v1 and state v1.
    void set_reference_output_mode(ReferenceOutputMode mode) noexcept;
    [[nodiscard]] ReferenceOutputMode reference_output_mode() const noexcept;
    [[nodiscard]] std::size_t sleeping_voice_count() const noexcept;
    [[nodiscard]] TailSleepStats tail_sleep_stats() const noexcept;
    void clear_tail_sleep_stats() noexcept;

    void note_on(const NoteOn& note) noexcept;
    void note_off(std::uint32_t note_id) noexcept;
    void set_sustain(bool down) noexcept;
    [[nodiscard]] bool sustain() const noexcept;
    void choke(std::uint32_t note_id) noexcept;
    void all_notes_off() noexcept;

    void process(float* out_left, float* out_right, std::uint32_t frame_count) noexcept;

    [[nodiscard]] double sample_rate() const noexcept { return sample_rate_; }
    [[nodiscard]] std::uint32_t max_block_frames() const noexcept { return max_block_frames_; }
    [[nodiscard]] std::size_t active_voice_count() const noexcept;
    [[nodiscard]] std::size_t held_voice_count() const noexcept;
    [[nodiscard]] std::size_t sustained_voice_count() const noexcept;
    // Runtime-only voice-recycle diagnostics; not ABI/state surface.
    [[nodiscard]] std::size_t pending_voice_steal_count() const noexcept;
    [[nodiscard]] std::uint64_t voice_steal_count() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    Patch patch_{};
    double sample_rate_ = 48000.0;
    std::uint32_t max_block_frames_ = 128;
    bool prepared_ = false;

    std::size_t pick_voice() noexcept;
    void start_voice(std::size_t voice_index, const NoteOn& note) noexcept;
    void configure_voice_for_patch(std::size_t voice_index, bool released) noexcept;
    void begin_release(std::size_t voice_index, bool force_damped = false) noexcept;
    void trigger_declick() noexcept;
    static float db_to_gain(float db) noexcept;
    static float clamp(float value, float low, float high) noexcept;
};

} // namespace brk::modal

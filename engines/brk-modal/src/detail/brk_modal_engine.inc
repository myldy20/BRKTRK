struct Engine::Impl {
    std::array<Voice, kMaxVoices> voices{};
    std::array<float, kMaxPartials> ratios_a{};
    std::array<float, kMaxPartials> ratios_b{};
    std::array<float, kMaxPartials> gains_a{};
    std::array<float, kMaxPartials> gains_b{};
    CombStereoizer stereo{};
    UpstreamOutputLimiter output_limiter{};
    std::uint64_t seed = 0x42524b4d4f44414cULL;
    std::uint64_t age_counter = 0;
    std::uint64_t voice_steal_count = 0U;
    bool sustain_down = false;
    std::uint32_t declick_remaining = 0;
    std::uint32_t declick_total = 0;
    float declick_start_left = 0.0F;
    float declick_start_right = 0.0F;
    float last_left = 0.0F;
    float last_right = 0.0F;
    ModalKernel requested_modal_kernel = ModalKernel::Scalar;
    ModalKernel active_modal_kernel = ModalKernel::Scalar;
    TailPolicy tail_policy = TailPolicy::Disabled;
    TailSleepStats tail_sleep_stats{};
    std::uint32_t tail_dwell_frames = 2400U;
    std::uint32_t tail_retire_frames = 4800U;
    float tail_observer_decay = 0.9942601F;
    // Process-call invariants. Active ramps force one-frame Engine::process calls;
    // cache unchanged dB conversions instead of repeating pow() per sample.
    float resonator_gain = 1.0F;
    float output_gain = 1.0F;

    Impl() noexcept {
        apply_modal_kernel(ModalKernel::Scalar);
    }

    void apply_modal_kernel(ModalKernel requested) noexcept {
        requested_modal_kernel = requested;
        active_modal_kernel = resolve_modal_kernel(requested);
        for (auto& voice : voices) voice.set_modal_kernel(active_modal_kernel);
    }

    void refresh_tables(const Patch& patch) noexcept {
        ratios_a = build_ratios(patch.resonator_a.model, patch.resonator_a.ratio);
        ratios_b = build_ratios(patch.resonator_b.model, patch.resonator_b.ratio);
        gains_a = build_gains(patch.resonator_a.model);
        gains_b = build_gains(patch.resonator_b.model);
    }
};

float upstream_skew_level(float base, float route, float velocity) noexcept {
    constexpr float skew = 0.3F;
    const float normalized = std::pow(clampf(base, 0.0F, 1.0F), 1.0F / skew);
    return std::pow(clampf(normalized + route * velocity, 0.0F, 1.0F), skew);
}

Patch make_factory_patch(FactoryPatch preset) noexcept {
    Patch patch{};
    patch.coupling_profile = CouplingProfile::Stable;
    patch.stereo_mode = StereoMode::Comb;
    patch.stereo_width = 0.8F;
    patch.polyphony = 12;

    switch (preset) {
    case FactoryPatch::GlassString:
        patch.resonator_a.model = Model::String;
        patch.resonator_a.partials = 48;
        patch.resonator_a.decay_seconds = 2.6F;
        patch.resonator_a.material = -0.18F;
        patch.resonator_a.tone = 0.22F;
        patch.resonator_a.spectral_focus = 0.18F;
        patch.resonator_b.enabled = true;
        patch.resonator_b.model = Model::Beam;
        patch.resonator_b.partials = 20;
        patch.resonator_b.decay_seconds = 1.4F;
        patch.resonator_b.coarse_semitones = 12.0F;
        patch.parallel_mix = 0.18F;
        patch.exciter.mallet_hardness_hz = 1250.0F;
        patch.exciter.noise_resonator = 0.025F;
        patch.release_mode = ReleaseMode::Natural;
        patch.output_gain_db = -5.0F;
        break;
    case FactoryPatch::WoodenBar:
        patch.resonator_a.model = Model::Marimba;
        patch.resonator_a.partials = 18;
        patch.resonator_a.decay_seconds = 1.2F;
        patch.resonator_a.material = -0.42F;
        patch.resonator_a.tone = -0.18F;
        patch.resonator_a.spectral_focus = 0.42F;
        patch.exciter.mallet_hardness_hz = 520.0F;
        patch.exciter.noise_resonator = 0.035F;
        patch.exciter.noise_decay_ms = 20.0F;
        patch.release_mode = ReleaseMode::OneShot;
        patch.output_gain_db = -4.0F;
        break;
    case FactoryPatch::DeepMembrane:
        patch.resonator_a.model = Model::Membrane;
        patch.resonator_a.partials = 48;
        patch.resonator_a.decay_seconds = 2.2F;
        patch.resonator_a.material = -0.25F;
        patch.resonator_a.tone = -0.15F;
        patch.resonator_a.hit_position = 0.31F;
        patch.resonator_a.spectral_focus = 0.38F;
        patch.resonator_b.enabled = true;
        patch.resonator_b.model = Model::Drumhead;
        patch.resonator_b.partials = 32;
        patch.resonator_b.decay_seconds = 1.0F;
        patch.parallel_mix = 0.22F;
        patch.exciter.mallet_hardness_hz = 280.0F;
        patch.exciter.noise_resonator = 0.08F;
        patch.exciter.noise_decay_ms = 55.0F;
        patch.release_mode = ReleaseMode::Damped;
        patch.output_gain_db = -6.0F;
        break;
    case FactoryPatch::SoftPlate:
        patch.resonator_a.model = Model::Plate;
        patch.resonator_a.partials = 56;
        patch.resonator_a.decay_seconds = 3.8F;
        patch.resonator_a.material = -0.30F;
        patch.resonator_a.tone = -0.08F;
        patch.resonator_a.spectral_focus = 0.48F;
        patch.exciter.mallet_hardness_hz = 410.0F;
        patch.exciter.noise_resonator = 0.055F;
        patch.exciter.noise_decay_ms = 45.0F;
        patch.release_mode = ReleaseMode::Natural;
        patch.output_gain_db = -7.0F;
        break;
    case FactoryPatch::BreathingTube:
        patch.resonator_a.model = Model::ClosedTube;
        patch.resonator_a.decay_seconds = 2.8F;
        patch.resonator_a.tube_radius = 0.42F;
        patch.resonator_b.enabled = true;
        patch.resonator_b.model = Model::OpenTube;
        patch.resonator_b.decay_seconds = 1.8F;
        patch.resonator_b.coarse_semitones = 12.0F;
        patch.resonator_b.tube_radius = 0.58F;
        patch.parallel_mix = 0.34F;
        patch.exciter.mallet_resonator = 0.18F;
        patch.exciter.noise_resonator = 0.62F;
        patch.exciter.noise_decay_ms = 420.0F;
        patch.exciter.noise_color = 0.74F;
        patch.release_mode = ReleaseMode::Damped;
        patch.output_gain_db = -7.0F;
        break;
    case FactoryPatch::RitualBell:
        patch.resonator_a.model = Model::Plate;
        patch.resonator_a.partials = 64;
        patch.resonator_a.decay_seconds = 5.2F;
        patch.resonator_a.material = 0.10F;
        patch.resonator_a.tone = 0.10F;
        patch.resonator_a.inharmonicity = 0.006F;
        patch.resonator_a.spectral_focus = 0.30F;
        patch.resonator_b.enabled = true;
        patch.resonator_b.model = Model::Drumhead;
        patch.resonator_b.partials = 40;
        patch.resonator_b.decay_seconds = 2.9F;
        patch.resonator_b.ratio = 0.78F;
        patch.resonator_b.spectral_focus = 0.40F;
        patch.coupling = Coupling::Serial;
        patch.coupling_split = 0.028F;
        patch.max_coupling_detune_cents = 18.0F;
        patch.exciter.mallet_hardness_hz = 920.0F;
        patch.exciter.noise_resonator = 0.04F;
        patch.release_mode = ReleaseMode::OneShot;
        patch.output_gain_db = -9.0F;
        break;
    }
    return patch;
}

const char* factory_patch_name(FactoryPatch preset) noexcept {
    switch (preset) {
    case FactoryPatch::GlassString: return "Glass String";
    case FactoryPatch::WoodenBar: return "Wooden Bar";
    case FactoryPatch::DeepMembrane: return "Deep Membrane";
    case FactoryPatch::SoftPlate: return "Soft Plate";
    case FactoryPatch::BreathingTube: return "Breathing Tube";
    case FactoryPatch::RitualBell: return "Ritual Bell";
    }
    return "Unknown";
}

bool held_tail_sleep_candidate(const Patch& patch, const Voice& voice) noexcept {
    return patch.coupling_profile != CouplingProfile::Reference
        && !patch.exciter.use_upstream_noise
        && voice.active
        && voice.key_down
        && !voice.sustained
        && !voice.released
        && !voice.steal_fading;
}

void wake_sleeping_live_voice(Voice& voice) noexcept {
    if (!voice.tail_sleeping || voice.released) return;
    // A Conservative sleeper intentionally stopped advancing once its complete
    // voice energy was sub-audible for the dwell interval. If a live lifecycle
    // event needs that held/sustained voice again, keep note identity but discard
    // the frozen residual instead of resurrecting stale tail state.
    voice.tail_sleeping = false;
    voice.tail_sleep_frames = 0U;
    voice.tail_below_frames = 0U;
    voice.tail_observer = 0.0F;
    voice.tail_block_peak = 0.0F;
    voice.quiet_frames = 0U;
    voice.mallet_envelope = 0.0F;
    voice.noise_envelope = 0.0F;
    voice.noise_lowpass = 0.0F;
    voice.mallet_filter.reset();
    voice.upstream_noise.reset();
    voice.a.reset();
    voice.b.reset();
}

Engine::Engine() noexcept : impl_(std::make_unique<Impl>()) {}
Engine::~Engine() noexcept = default;
Engine::Engine(Engine&&) noexcept = default;
Engine& Engine::operator=(Engine&&) noexcept = default;

bool Engine::prepare(double sample_rate, std::uint32_t max_block_frames, std::uint64_t deterministic_seed) noexcept {
    if (!(sample_rate >= 8000.0 && sample_rate <= 384000.0) || max_block_frames == 0U) return false;
    sample_rate_ = sample_rate;
    max_block_frames_ = max_block_frames;
    impl_->seed = deterministic_seed == 0U ? 0x42524b4d4f44414cULL : deterministic_seed;
    impl_->tail_dwell_frames = std::max<std::uint32_t>(1U, static_cast<std::uint32_t>(
        std::llround(kTailSleepDwellSeconds * sample_rate_)));
    impl_->tail_retire_frames = std::max<std::uint32_t>(1U, static_cast<std::uint32_t>(
        std::llround(kTailRetireSeconds * sample_rate_)));
    impl_->tail_observer_decay = std::pow(
        0.001F,
        1.0F / std::max(1.0F, 0.025F * static_cast<float>(sample_rate_)));
    impl_->resonator_gain = db_to_gain(patch_.resonator_gain_db);
    impl_->output_gain = db_to_gain(patch_.output_gain_db);
    impl_->stereo.prepare(sample_rate_);
    impl_->output_limiter.prepare(sample_rate_);
    prepared_ = true;
    impl_->refresh_tables(patch_);
    reset();
    return true;
}

void Engine::set_modal_kernel(ModalKernel kernel) noexcept {
    if (!impl_) return;
    impl_->apply_modal_kernel(kernel);
}

ModalKernel Engine::modal_kernel() const noexcept {
    return impl_ ? impl_->requested_modal_kernel : ModalKernel::Scalar;
}

ModalKernel Engine::active_modal_kernel() const noexcept {
    return impl_ ? impl_->active_modal_kernel : ModalKernel::Scalar;
}

void Engine::set_tail_policy(TailPolicy policy) noexcept {
    if (!impl_ || impl_->tail_policy == policy) return;
    if (policy == TailPolicy::Disabled) {
        for (auto& voice : impl_->voices) {
            if (voice.tail_sleeping) {
                if (!voice.released) {
                    wake_sleeping_live_voice(voice);
                } else {
                    // Released sleepers have intentionally stopped advancing in
                    // time. Retire rather than resume frozen terminal state.
                    voice.reset();
                    ++impl_->tail_sleep_stats.retired_voices;
                }
            } else {
                voice.tail_below_frames = 0U;
                voice.tail_observer = 0.0F;
                voice.tail_block_peak = 0.0F;
            }
        }
    } else {
        for (auto& voice : impl_->voices) {
            voice.tail_below_frames = 0U;
            voice.tail_observer = 0.0F;
            voice.tail_block_peak = 0.0F;
        }
    }
    impl_->tail_policy = policy;
}

TailPolicy Engine::tail_policy() const noexcept {
    return impl_ ? impl_->tail_policy : TailPolicy::Disabled;
}

void Engine::set_reference_output_mode(ReferenceOutputMode mode) noexcept {
    if (!impl_) return;
    if (mode != ReferenceOutputMode::Normal
        && mode != ReferenceOutputMode::SafeHeadroom
        && mode != ReferenceOutputMode::RawHeadroom) {
        mode = ReferenceOutputMode::Normal;
    }
    impl_->output_limiter.set_reference_output_mode(mode);
}

ReferenceOutputMode Engine::reference_output_mode() const noexcept {
    return impl_ ? impl_->output_limiter.get_reference_output_mode()
                 : ReferenceOutputMode::Normal;
}

std::size_t Engine::sleeping_voice_count() const noexcept {
    std::size_t count = 0U;
    if (!impl_) return count;
    for (const auto& voice : impl_->voices) if (voice.active && voice.tail_sleeping) ++count;
    return count;
}

TailSleepStats Engine::tail_sleep_stats() const noexcept {
    return impl_ ? impl_->tail_sleep_stats : TailSleepStats{};
}

void Engine::clear_tail_sleep_stats() noexcept {
    if (impl_) impl_->tail_sleep_stats = {};
}

void Engine::reset() noexcept {
    if (!impl_) return;
    impl_->age_counter = 0;
    impl_->voice_steal_count = 0U;
    impl_->sustain_down = false;
    impl_->declick_remaining = 0;
    impl_->declick_total = 0;
    impl_->last_left = 0.0F;
    impl_->last_right = 0.0F;
    impl_->tail_sleep_stats = {};
    impl_->stereo.reset();
    impl_->output_limiter.reset();
    for (auto& voice : impl_->voices) voice.reset();
}

void Engine::trigger_declick() noexcept {
    if (!prepared_) return;
    const auto frames = static_cast<std::uint32_t>(std::llround(
        clamp(patch_.retrigger_declick_ms, 0.0F, 20.0F) * 0.001 * sample_rate_));
    if (frames == 0U) return;
    impl_->declick_total = std::max<std::uint32_t>(1U, frames);
    impl_->declick_remaining = impl_->declick_total;
    impl_->declick_start_left = impl_->last_left;
    impl_->declick_start_right = impl_->last_right;
}

void Engine::configure_voice_for_patch(std::size_t voice_index, bool released) noexcept {
    Voice& voice = impl_->voices[voice_index];
    voice.tail_below_frames = 0U;
    voice.tail_observer = 0.0F;
    voice.tail_block_peak = 0.0F;
    voice.ratios_a = impl_->ratios_a;
    voice.ratios_b = impl_->ratios_b;
    if (patch_.coupling == Coupling::Serial && patch_.resonator_a.enabled && patch_.resonator_b.enabled) {
        apply_serial_frequency_split(voice.ratios_a, voice.ratios_b, voice.frequency, patch_);
    }

    const float bipolar = 2.0F * voice.shaped_velocity - 1.0F;
    ResonatorPatch a_patch = patch_.resonator_a;
    ResonatorPatch b_patch = patch_.resonator_b;
    const auto apply_downstream_velocity = [&](ResonatorPatch& target) {
        target.decay_seconds = clamp(
            target.decay_seconds * std::pow(2.0F, patch_.velocity.decay_octaves * bipolar),
            0.01F,
            100.0F);
        target.material = clamp(target.material + patch_.velocity.material * bipolar, -1.0F, 1.0F);
        target.tone = clamp(target.tone + patch_.velocity.tone * bipolar, -1.0F, 1.0F);
        target.inharmonicity = clamp(
            target.inharmonicity + patch_.velocity.inharmonicity * std::max(0.0F, bipolar),
            0.0001F,
            1.0F);
    };
    apply_downstream_velocity(a_patch);
    apply_downstream_velocity(b_patch);

    voice.mallet_direct_gain = clamp(
        patch_.exciter.mallet_direct + patch_.exciter.mallet_velocity_direct * voice.velocity,
        0.0F,
        1.0F);
    voice.mallet_resonator_gain = clamp(
        patch_.exciter.mallet_resonator + patch_.exciter.mallet_velocity_resonator * voice.velocity,
        0.0F,
        1.0F);
    voice.noise_direct_gain = patch_.exciter.use_upstream_noise
        ? upstream_skew_level(patch_.exciter.noise_direct, patch_.exciter.noise_velocity_direct, voice.velocity)
        : patch_.exciter.noise_direct;
    voice.noise_resonator_gain = patch_.exciter.use_upstream_noise
        ? upstream_skew_level(patch_.exciter.noise_resonator, patch_.exciter.noise_velocity_resonator, voice.velocity)
        : patch_.exciter.noise_resonator;

    const float spread = patch_.stereo_width
        * (2.0F * (static_cast<float>(voice_index) + 0.5F) / static_cast<float>(kMaxVoices) - 1.0F);
    const float angle = 0.25F * kPi * (spread + 1.0F);
    voice.spread_left_gain = std::cos(angle);
    voice.spread_right_gain = std::sin(angle);

    const float resonator_velocity = patch_.exciter.use_upstream_noise ? voice.velocity : voice.shaped_velocity;
    voice.a.configure(sample_rate_, voice.frequency, resonator_velocity, released, a_patch, voice.ratios_a, impl_->gains_a);
    voice.b.configure(sample_rate_, voice.frequency, resonator_velocity, released, b_patch, voice.ratios_b, impl_->gains_b);
}

void Engine::set_patch(const Patch& patch) noexcept {
    const bool was_reference = patch_.coupling_profile == CouplingProfile::Reference;
    patch_ = patch;
    sanitize_patch_contract(patch_);
    const bool is_reference = patch_.coupling_profile == CouplingProfile::Reference;
    const auto clamp_resonator = [&](ResonatorPatch& target) {
        target.partials = static_cast<std::uint8_t>(std::clamp<int>(target.partials, 1, static_cast<int>(kMaxPartials)));
        target.max_render_partials = static_cast<std::uint8_t>(
            std::clamp<int>(target.max_render_partials, 1, static_cast<int>(kMaxPartials)));
        target.normalize_modal_energy = !is_reference;
        target.low_cut = clamp(target.low_cut, -1.0F, 1.0F);
        target.spectral_focus = clamp(target.spectral_focus, 0.0F, 1.0F);
        target.upstream_velocity.decay = clamp(target.upstream_velocity.decay, -1.0F, 1.0F);
        target.upstream_velocity.hit_position = clamp(target.upstream_velocity.hit_position, -1.0F, 1.0F);
        target.upstream_velocity.inharmonicity = clamp(target.upstream_velocity.inharmonicity, -1.0F, 1.0F);
        target.upstream_velocity.material = clamp(target.upstream_velocity.material, -1.0F, 1.0F);
        target.upstream_velocity.tone = clamp(target.upstream_velocity.tone, -1.0F, 1.0F);
    };
    clamp_resonator(patch_.resonator_a);
    clamp_resonator(patch_.resonator_b);

    patch_.exciter.mallet_velocity_direct = clamp(patch_.exciter.mallet_velocity_direct, -1.0F, 1.0F);
    patch_.exciter.mallet_velocity_resonator = clamp(patch_.exciter.mallet_velocity_resonator, -1.0F, 1.0F);
    patch_.exciter.mallet_velocity_hardness = clamp(patch_.exciter.mallet_velocity_hardness, -1.0F, 1.0F);
    patch_.exciter.noise_filter_frequency_hz = clamp(patch_.exciter.noise_filter_frequency_hz, 20.0F, 20000.0F);
    patch_.exciter.noise_filter_q = clamp(patch_.exciter.noise_filter_q, 0.707F, 4.0F);
    patch_.exciter.noise_attack_ms = clamp(patch_.exciter.noise_attack_ms, 1.0F, 20000.0F);
    patch_.exciter.noise_decay_ms = clamp(patch_.exciter.noise_decay_ms, 1.0F, 20000.0F);
    patch_.exciter.noise_sustain = clamp(patch_.exciter.noise_sustain, 0.0F, 1.0F);
    patch_.exciter.noise_release_ms = clamp(patch_.exciter.noise_release_ms, 1.0F, 20000.0F);
    patch_.exciter.noise_attack_tension = clamp(patch_.exciter.noise_attack_tension, -1.0F, 1.0F);
    patch_.exciter.noise_decay_tension = clamp(patch_.exciter.noise_decay_tension, -1.0F, 1.0F);
    patch_.exciter.noise_release_tension = clamp(patch_.exciter.noise_release_tension, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_direct = clamp(patch_.exciter.noise_velocity_direct, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_resonator = clamp(patch_.exciter.noise_velocity_resonator, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_frequency = clamp(patch_.exciter.noise_velocity_frequency, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_q = clamp(patch_.exciter.noise_velocity_q, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_attack = clamp(patch_.exciter.noise_velocity_attack, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_decay = clamp(patch_.exciter.noise_velocity_decay, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_sustain = clamp(patch_.exciter.noise_velocity_sustain, -1.0F, 1.0F);
    patch_.exciter.noise_velocity_release = clamp(patch_.exciter.noise_velocity_release, -1.0F, 1.0F);

    patch_.velocity.response = clamp(patch_.velocity.response, 0.0F, 1.0F);
    patch_.velocity.curve = clamp(patch_.velocity.curve, 0.25F, 4.0F);
    patch_.velocity.mallet_hardness_octaves = clamp(patch_.velocity.mallet_hardness_octaves, -4.0F, 4.0F);
    patch_.velocity.noise_color = clamp(patch_.velocity.noise_color, -1.0F, 1.0F);
    patch_.velocity.decay_octaves = clamp(patch_.velocity.decay_octaves, -4.0F, 4.0F);
    patch_.velocity.material = clamp(patch_.velocity.material, -1.0F, 1.0F);
    patch_.velocity.tone = clamp(patch_.velocity.tone, -1.0F, 1.0F);
    patch_.velocity.inharmonicity = clamp(patch_.velocity.inharmonicity, 0.0F, 1.0F);
    patch_.polyphony = static_cast<std::uint8_t>(std::clamp<int>(patch_.polyphony, 1, static_cast<int>(kMaxVoices)));
    patch_.parallel_mix = clamp(patch_.parallel_mix, 0.0F, 1.0F);
    patch_.coupling_split = clamp(patch_.coupling_split, 0.0001F, 1.0F);
    patch_.max_coupling_detune_cents = clamp(patch_.max_coupling_detune_cents, 0.0F, 200.0F);
    patch_.retrigger_declick_ms = clamp(patch_.retrigger_declick_ms, 0.0F, 20.0F);
    patch_.stereo_width = clamp(patch_.stereo_width, 0.0F, 1.0F);
    impl_->resonator_gain = db_to_gain(patch_.resonator_gain_db);
    impl_->output_gain = db_to_gain(patch_.output_gain_db);

    bool dropped_voice = false;
    const std::size_t voice_limit = std::max<std::size_t>(1U, patch_.polyphony);
    for (std::size_t i = voice_limit; i < impl_->voices.size(); ++i) {
        if (impl_->voices[i].active) {
            impl_->voices[i].reset();
            dropped_voice = true;
        }
    }
    if (dropped_voice) trigger_declick();
    if (was_reference != is_reference) impl_->output_limiter.reset();
    impl_->refresh_tables(patch_);
    for (std::size_t i = 0; i < voice_limit; ++i) {
        Voice& voice = impl_->voices[i];
        if (!voice.active) continue;
        if (voice.tail_sleeping && voice.released) {
            voice.reset();
            ++impl_->tail_sleep_stats.retired_voices;
            continue;
        }
        if (voice.tail_sleeping) wake_sleeping_live_voice(voice);
        configure_voice_for_patch(i, voice.released);
    }
}

void Engine::set_live_decay_patch(
    const Patch& patch,
    bool update_a,
    bool update_b) noexcept {

    set_live_performance_patch(
        patch,
        update_a, false, false,
        update_b, false, false,
        false);
}

void Engine::set_live_performance_patch(
    const Patch& patch,
    bool update_a_decay,
    bool update_a_material,
    bool update_a_tone,
    bool update_b_decay,
    bool update_b_material,
    bool update_b_tone,
    bool update_width) noexcept {

    if (!impl_) return;
    const bool update_a = update_a_decay || update_a_material || update_a_tone;
    const bool update_b = update_b_decay || update_b_material || update_b_tone;
    if (!update_a && !update_b && !update_width) return;

    if (update_a_decay) {
        patch_.resonator_a.decay_seconds =
            clamp(patch.resonator_a.decay_seconds, 0.01F, 100.0F);
    }
    if (update_a_material) {
        patch_.resonator_a.material = clamp(patch.resonator_a.material, -1.0F, 1.0F);
    }
    if (update_a_tone) {
        patch_.resonator_a.tone = clamp(patch.resonator_a.tone, -1.0F, 1.0F);
    }
    if (update_b_decay) {
        patch_.resonator_b.decay_seconds =
            clamp(patch.resonator_b.decay_seconds, 0.01F, 100.0F);
    }
    if (update_b_material) {
        patch_.resonator_b.material = clamp(patch.resonator_b.material, -1.0F, 1.0F);
    }
    if (update_b_tone) {
        patch_.resonator_b.tone = clamp(patch.resonator_b.tone, -1.0F, 1.0F);
    }
    if (update_width) {
        patch_.stereo_width = clamp(patch.stereo_width, 0.0F, 1.0F);
    }

    const bool a_decay_only = update_a_decay && !update_a_material && !update_a_tone;
    const bool b_decay_only = update_b_decay && !update_b_material && !update_b_tone;
    const bool a_tone_only = update_a_tone && !update_a_decay && !update_a_material;
    const bool b_tone_only = update_b_tone && !update_b_decay && !update_b_material;
    const std::size_t voice_limit = std::max<std::size_t>(1U, patch_.polyphony);
    for (std::size_t i = 0U; i < voice_limit; ++i) {
        Voice& voice = impl_->voices[i];
        if (!voice.active) continue;

        // Generic set_patch resets these observers for any live patch edit. Keep
        // that lifecycle behavior while avoiding unrelated table/bank rebuilds.
        voice.tail_below_frames = 0U;
        voice.tail_observer = 0.0F;
        voice.tail_block_peak = 0.0F;
        if (voice.tail_sleeping && voice.released) {
            voice.reset();
            ++impl_->tail_sleep_stats.retired_voices;
            continue;
        }
        if (voice.tail_sleeping) wake_sleeping_live_voice(voice);

        bool fallback = false;
        if (update_a || update_b) {
            const float bipolar = 2.0F * voice.shaped_velocity - 1.0F;
            const float resonator_velocity = patch_.exciter.use_upstream_noise
                ? voice.velocity : voice.shaped_velocity;
            const auto adjusted = [&](const ResonatorPatch& source) noexcept {
                ResonatorPatch target = source;
                target.decay_seconds = clamp(
                    target.decay_seconds
                        * std::pow(2.0F, patch_.velocity.decay_octaves * bipolar),
                    0.01F,
                    100.0F);
                target.material = clamp(
                    target.material + patch_.velocity.material * bipolar,
                    -1.0F,
                    1.0F);
                target.tone = clamp(
                    target.tone + patch_.velocity.tone * bipolar,
                    -1.0F,
                    1.0F);
                target.inharmonicity = clamp(
                    target.inharmonicity
                        + patch_.velocity.inharmonicity * std::max(0.0F, bipolar),
                    0.0001F,
                    1.0F);
                return target;
            };

            if (update_a) {
                ResonatorPatch target = adjusted(patch_.resonator_a);
                if (a_decay_only) {
                    fallback = !voice.a.reconfigure_decay(
                        sample_rate_, resonator_velocity, voice.released, target);
                } else if (a_tone_only) {
                    fallback = !voice.a.reconfigure_tone(
                        sample_rate_, resonator_velocity, target);
                } else {
                    voice.a.configure(
                        sample_rate_, voice.frequency, resonator_velocity,
                        voice.released, target, voice.ratios_a, impl_->gains_a);
                }
            }
            if (update_b && !fallback) {
                ResonatorPatch target = adjusted(patch_.resonator_b);
                if (b_decay_only) {
                    fallback = !voice.b.reconfigure_decay(
                        sample_rate_, resonator_velocity, voice.released, target);
                } else if (b_tone_only) {
                    fallback = !voice.b.reconfigure_tone(
                        sample_rate_, resonator_velocity, target);
                } else {
                    voice.b.configure(
                        sample_rate_, voice.frequency, resonator_velocity,
                        voice.released, target, voice.ratios_b, impl_->gains_b);
                }
            }
        }

        if (fallback) {
            configure_voice_for_patch(i, voice.released);
            continue;
        }

        // Comb width is a single output-stage multiplier and must not touch modal
        // state. VoiceSpread does depend on cached per-voice trigonometry, so only
        // refresh those gains when that mode is actually selected.
        if (update_width && patch_.stereo_mode == StereoMode::VoiceSpread) {
            const float spread = patch_.stereo_width
                * (2.0F * (static_cast<float>(i) + 0.5F)
                    / static_cast<float>(kMaxVoices) - 1.0F);
            const float angle = 0.25F * kPi * (spread + 1.0F);
            voice.spread_left_gain = std::cos(angle);
            voice.spread_right_gain = std::sin(angle);
        }
    }
}

void Engine::begin_release(std::size_t voice_index, bool force_damped) noexcept {
    Voice& voice = impl_->voices[voice_index];
    if (!voice.active || voice.released) return;
    if (voice.tail_sleeping) wake_sleeping_live_voice(voice);
    voice.key_down = false;
    voice.sustained = false;
    voice.released = true;
    voice.release_age = ++impl_->age_counter;
    voice.tail_below_frames = 0U;
    voice.tail_sleep_frames = 0U;
    voice.tail_observer = 0.0F;
    voice.tail_block_peak = 0.0F;
    voice.tail_sleeping = false;
    if (patch_.exciter.use_upstream_noise) voice.upstream_noise.release();
    else voice.noise_decay = std::pow(0.001F, 1.0F / (0.02F * static_cast<float>(sample_rate_)));
    if (force_damped || patch_.release_mode == ReleaseMode::Damped) {
        configure_voice_for_patch(voice_index, true);
    }
}

std::size_t Engine::pick_voice() noexcept {
    const std::size_t voice_limit = std::max<std::size_t>(1U, patch_.polyphony);
    for (std::size_t i = 0; i < voice_limit; ++i) {
        if (!impl_->voices[i].active) return i;
    }

    std::size_t best_released = voice_limit;
    if (patch_.coupling_profile == CouplingProfile::Reference) {
        // Pinned RipplerX recycles the oldest released voice, not the quietest
        // one. release_age is runtime-only chronology; one-shot voices use their
        // start age because they enter released state immediately.
        std::uint64_t oldest_release = std::numeric_limits<std::uint64_t>::max();
        for (std::size_t i = 0; i < voice_limit; ++i) {
            const Voice& voice = impl_->voices[i];
            if (!voice.released) continue;
            const std::uint64_t release_order = voice.release_age != 0U ? voice.release_age : voice.age;
            if (release_order < oldest_release) {
                oldest_release = release_order;
                best_released = i;
            }
        }
    } else {
        float best_energy = std::numeric_limits<float>::max();
        for (std::size_t i = 0; i < voice_limit; ++i) {
            const Voice& voice = impl_->voices[i];
            if (!voice.released) continue;
            const float noise_energy = patch_.exciter.use_upstream_noise ? voice.upstream_noise.envelope.value : voice.noise_envelope;
            const float energy = voice.a.energy() + voice.b.energy() + voice.mallet_envelope + noise_energy;
            if (energy < best_energy) {
                best_energy = energy;
                best_released = i;
            }
        }
    }
    if (best_released != voice_limit) {
        return best_released;
    }

    std::size_t oldest = 0U;
    for (std::size_t i = 1; i < voice_limit; ++i) {
        if (impl_->voices[i].age < impl_->voices[oldest].age) oldest = i;
    }
    return oldest;
}

void Engine::start_voice(std::size_t voice_index, const NoteOn& note) noexcept {
    Voice& voice = impl_->voices[voice_index];
    voice.reset();
    voice.active = true;
    voice.key_down = patch_.release_mode != ReleaseMode::OneShot;
    voice.released = patch_.release_mode == ReleaseMode::OneShot;
    voice.note_id = note.note_id;
    voice.key = note.key;
    voice.velocity = clamp(note.velocity, 0.0F, 1.0F);
    voice.shaped_velocity = velocity_shape(voice.velocity, patch_.velocity);
    voice.excitation_gain = (1.0F - patch_.velocity.response) + patch_.velocity.response * voice.shaped_velocity;
    voice.tuning = note.tuning_semitones;
    voice.frequency = midi_to_hz(note.key, note.tuning_semitones);
    voice.age = ++impl_->age_counter;
    voice.release_age = voice.released ? voice.age : 0U;
    voice.rng = static_cast<std::uint32_t>((impl_->seed ^ (static_cast<std::uint64_t>(note.note_id) * 0x9e3779b97f4a7c15ULL) ^ voice.age) & 0xffffffffU);
    if (voice.rng == 0U) voice.rng = kDefaultSeed;

    const float log_hardness_span = std::log(5000.0F) - std::log(100.0F);
    const float upstream_hardness = std::exp(
        std::log(clamp(patch_.exciter.mallet_hardness_hz, 100.0F, 5000.0F))
        + voice.velocity * patch_.exciter.mallet_velocity_hardness * 2.0F * log_hardness_span);
    const float hardness_velocity = 2.0F * voice.shaped_velocity - 1.0F;
    const float hardness = clamp(
        upstream_hardness
            * std::pow(2.0F, (static_cast<float>(note.key) - 60.0F) * patch_.exciter.mallet_keytrack / 12.0F)
            * std::pow(2.0F, patch_.velocity.mallet_hardness_octaves * hardness_velocity),
        80.0F,
        static_cast<float>(sample_rate_) * 0.45F);
    voice.mallet_filter.bandpass(static_cast<float>(sample_rate_), hardness, 0.707F);
    voice.mallet_envelope = voice.excitation_gain;
    voice.mallet_decay = std::exp(-100.0F / static_cast<float>(sample_rate_));

    if (patch_.exciter.use_upstream_noise) {
        voice.upstream_noise.configure(static_cast<float>(sample_rate_), patch_.exciter, voice.velocity);
        voice.upstream_noise.trigger();
        voice.noise_envelope = 0.0F;
    } else {
        voice.noise_envelope = voice.excitation_gain;
        voice.noise_color = clamp(
            patch_.exciter.noise_color + patch_.velocity.noise_color * hardness_velocity,
            0.0F,
            1.0F);
        const float noise_seconds = clamp(patch_.exciter.noise_decay_ms * 0.001F, 0.001F, 20.0F);
        voice.noise_decay = std::pow(0.001F, 1.0F / (noise_seconds * static_cast<float>(sample_rate_)));
    }
    configure_voice_for_patch(voice_index, false);
}

void Engine::note_on(const NoteOn& note) noexcept {
    if (!prepared_ || note.note_id == 0U) return;

    for (std::size_t i = 0; i < impl_->voices.size(); ++i) {
        Voice& previous = impl_->voices[i];
        if (previous.active && previous.note_id == note.note_id && (previous.key_down || previous.sustained)) {
            begin_release(i);
        }
    }

    if (patch_.coupling_profile != CouplingProfile::Reference) {
        // Stable/Wild retain BRK's historical pre-release behavior. Reference
        // follows pinned RipplerX: when every voice is still pressed, select the
        // oldest pressed voice directly and run the same 1 ms voice-local recycle
        // fade; do not damp/reconfigure it before the fade.
        while (held_voice_count() >= patch_.polyphony) {
            std::size_t oldest = kMaxVoices;
            for (std::size_t i = 0; i < impl_->voices.size(); ++i) {
                const Voice& voice = impl_->voices[i];
                if (!voice.key_down) continue;
                if (oldest == kMaxVoices || voice.age < impl_->voices[oldest].age) oldest = i;
            }
            if (oldest == kMaxVoices) break;
            begin_release(oldest, true);
        }
    }

    const std::size_t voice_index = pick_voice();
    Voice& voice = impl_->voices[voice_index];
    if (!voice.active) {
        start_voice(voice_index, note);
        return;
    }

    if (voice.tail_sleeping) {
        ++impl_->tail_sleep_stats.recycled_voices;
        start_voice(voice_index, note);
        return;
    }

    ++impl_->voice_steal_count;
    if (patch_.coupling_profile == CouplingProfile::Reference) {
        // RipplerX 1.5.18 does not destroy an audible selected voice on the
        // NoteOn sample. It fades only that voice for REPEAT_NOTE_FADE_MS=1
        // and clears/restarts it after the fade. Preserve that lifecycle here;
        // other voices and the full stereo mix remain untouched.
        const auto frames = std::max<std::uint32_t>(1U, static_cast<std::uint32_t>(
            std::llround(0.001 * sample_rate_)));
        voice.steal_fading = true;
        voice.steal_fade_total = frames;
        voice.steal_fade_remaining = frames;
        voice.pending_note = note;
        voice.quiet_frames = 0U;
        voice.tail_below_frames = 0U;
        voice.tail_observer = 0.0F;
        voice.tail_block_peak = 0.0F;
        return;
    }

    // Stable/Wild retain the established BRK whole-output declick behavior.
    trigger_declick();
    start_voice(voice_index, note);
}

void Engine::note_off(std::uint32_t note_id) noexcept {
    if (patch_.release_mode == ReleaseMode::OneShot) return;
    for (std::size_t i = 0; i < impl_->voices.size(); ++i) {
        Voice& voice = impl_->voices[i];
        if (!voice.active || voice.note_id != note_id || !voice.key_down) continue;
        if (impl_->sustain_down) {
            if (voice.tail_sleeping) wake_sleeping_live_voice(voice);
            voice.key_down = false;
            voice.sustained = true;
        } else {
            begin_release(i);
        }
    }
}

void Engine::set_sustain(bool down) noexcept {
    if (impl_->sustain_down == down) return;
    impl_->sustain_down = down;
    if (down) return;
    for (std::size_t i = 0; i < impl_->voices.size(); ++i) {
        if (impl_->voices[i].active && impl_->voices[i].sustained) begin_release(i);
    }
}

bool Engine::sustain() const noexcept { return impl_ && impl_->sustain_down; }

void Engine::choke(std::uint32_t note_id) noexcept {
    bool removed = false;
    for (auto& voice : impl_->voices) {
        if (voice.active && voice.note_id == note_id) {
            voice.reset();
            removed = true;
        }
    }
    if (removed) trigger_declick();
}

void Engine::all_notes_off() noexcept {
    for (std::size_t i = 0; i < impl_->voices.size(); ++i) {
        Voice& voice = impl_->voices[i];
        if (!voice.active || voice.released) continue;
        begin_release(i, patch_.release_mode == ReleaseMode::Damped);
    }
    impl_->sustain_down = false;
}

void Engine::process(float* out_left, float* out_right, std::uint32_t frame_count) noexcept {
    if (!prepared_ || out_left == nullptr || out_right == nullptr) return;
    const std::uint32_t frames = std::min(frame_count, max_block_frames_);
    std::fill_n(out_left, frames, 0.0F);
    std::fill_n(out_right, frames, 0.0F);

    const float resonator_gain = impl_->resonator_gain;
    const float output_gain = impl_->output_gain;
    const bool reference_profile = patch_.coupling_profile == CouplingProfile::Reference;
    const bool held_tail_sleep_enabled = !reference_profile && !patch_.exciter.use_upstream_noise;
    const float mallet_reference_gain = reference_profile ? 2.0F : 1.0F;
    const std::size_t voice_limit = std::max<std::size_t>(1U, patch_.polyphony);
    const bool serial_pair = patch_.coupling == Coupling::Serial
        && patch_.resonator_a.enabled && patch_.resonator_b.enabled;
    const bool both_resonators = patch_.resonator_a.enabled && patch_.resonator_b.enabled;
    const bool voice_spread = patch_.stereo_mode == StereoMode::VoiceSpread;
    // Stereo width is constant for this Engine::process call. Active
    // sample-accurate ramps already split processing to one-frame calls,
    // so this is exactly the same float expression as the old per-sample path.
    const float comb_amount = patch_.stereo_mode == StereoMode::Comb
        ? 0.33F * clampf(patch_.stereo_width, 0.0F, 1.0F)
        : 0.0F;
    bool observe_sleep_candidates = false;
    if (impl_->tail_policy == TailPolicy::Conservative) {
        for (std::size_t index = 0; index < voice_limit; ++index) {
            Voice& voice = impl_->voices[index];
            if (!voice.active) continue;
            if (voice.tail_sleeping) {
                if (!voice.released) {
                    // Held Conservative sleepers retain their note identity and
                    // remain asleep until a lifecycle event explicitly wakes them.
                    impl_->tail_sleep_stats.skipped_voice_frames += frames;
                } else {
                    const std::uint32_t remaining = impl_->tail_retire_frames > voice.tail_sleep_frames
                        ? impl_->tail_retire_frames - voice.tail_sleep_frames
                        : 0U;
                    impl_->tail_sleep_stats.skipped_voice_frames += std::min<std::uint32_t>(frames, remaining);
                    if (frames >= remaining) {
                        voice.reset();
                        ++impl_->tail_sleep_stats.retired_voices;
                    } else {
                        voice.tail_sleep_frames += frames;
                    }
                }
            } else {
                voice.tail_block_peak = 0.0F;
                observe_sleep_candidates = observe_sleep_candidates
                    || voice.released
                    || (held_tail_sleep_enabled && held_tail_sleep_candidate(patch_, voice));
            }
        }
    }

    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        float mono = 0.0F;
        float spread_left = 0.0F;
        float spread_right = 0.0F;

        for (std::size_t index = 0; index < voice_limit; ++index) {
            Voice& voice = impl_->voices[index];
            if (!voice.active) continue;
            if (impl_->tail_policy == TailPolicy::Conservative && voice.tail_sleeping) continue;

            float voice_steal_gain = 1.0F;
            if (voice.steal_fading) {
                if (voice.steal_fade_remaining > 0U) --voice.steal_fade_remaining;
                if (voice.steal_fade_remaining == 0U) {
                    const NoteOn pending = voice.pending_note;
                    start_voice(index, pending);
                } else {
                    voice_steal_gain = static_cast<float>(voice.steal_fade_remaining)
                        / static_cast<float>(std::max<std::uint32_t>(1U, voice.steal_fade_total));
                }
            }

            const float mallet = voice.mallet_filter.process(voice.mallet_envelope) * mallet_reference_gain;
            voice.mallet_envelope *= voice.mallet_decay;
            if (voice.mallet_envelope < 1.0e-7F) voice.mallet_envelope = 0.0F;

            float noise = 0.0F;
            if (patch_.exciter.use_upstream_noise) {
                noise = voice.upstream_noise.process(voice.rng);
            } else {
                const float raw_noise = random_bipolar(voice.rng);
                voice.noise_lowpass += (0.01F + 0.49F * voice.noise_color) * (raw_noise - voice.noise_lowpass);
                noise = (voice.noise_color * voice.noise_lowpass + (1.0F - voice.noise_color) * raw_noise) * voice.noise_envelope;
                voice.noise_envelope *= voice.noise_decay;
                if (voice.noise_envelope < 1.0e-7F) voice.noise_envelope = 0.0F;
            }

            const float direct = mallet * voice.mallet_direct_gain + noise * voice.noise_direct_gain;
            const float resonator_input = mallet * voice.mallet_resonator_gain + noise * voice.noise_resonator_gain;
            const float a = voice.a.process(resonator_input, serial_pair);
            const float b_input = serial_pair ? a : resonator_input;
            const float b = voice.b.process(b_input);

            float resonated = 0.0F;
            if (both_resonators) {
                resonated = serial_pair ? b : a * (1.0F - patch_.parallel_mix) + b * patch_.parallel_mix;
            } else {
                resonated = a + b;
            }

            const float sample = (direct + resonator_gain * resonated) * voice_steal_gain;
            mono += sample;
            if (voice_spread) {
                spread_left += sample * voice.spread_left_gain;
                spread_right += sample * voice.spread_right_gain;
            }

            const float noise_energy = patch_.exciter.use_upstream_noise ? voice.upstream_noise.envelope.value : voice.noise_envelope;
            const float energy = std::abs(sample) + voice.a.energy() + voice.b.energy() + voice.mallet_envelope + noise_energy;
            const bool held_sleep_candidate_now = held_tail_sleep_enabled
                && voice.key_down && !voice.sustained && !voice.released && !voice.steal_fading;
            if (impl_->tail_policy == TailPolicy::Conservative
                && (voice.released || held_sleep_candidate_now)) {
                voice.tail_block_peak = std::max(voice.tail_block_peak, energy);
            }
            if (!voice.steal_fading && voice.released && energy < kSilenceThreshold) {
                ++voice.quiet_frames;
                if (voice.quiet_frames > static_cast<std::uint32_t>(sample_rate_ * 0.1)) voice.reset();
            } else {
                voice.quiet_frames = 0;
            }
        }

        float left = mono;
        float right = mono;
        if (patch_.stereo_mode == StereoMode::Comb) {
            std::tie(left, right) = impl_->stereo.process_with_amount(mono, comb_amount);
        } else if (patch_.stereo_mode == StereoMode::VoiceSpread) {
            left = spread_left;
            right = spread_right;
        }

        float target_left = 0.0F;
        float target_right = 0.0F;
        if (reference_profile) {
            const auto limited = impl_->output_limiter.process(left * output_gain, right * output_gain);
            target_left = std::isfinite(limited.first) ? limited.first : 0.0F;
            target_right = std::isfinite(limited.second) ? limited.second : 0.0F;
        } else {
            target_left = std::isfinite(left) ? std::tanh(left * output_gain) : 0.0F;
            target_right = std::isfinite(right) ? std::tanh(right * output_gain) : 0.0F;
        }
        if (impl_->declick_remaining > 0U) {
            const float progress = 1.0F - static_cast<float>(impl_->declick_remaining) / static_cast<float>(impl_->declick_total);
            target_left = impl_->declick_start_left * (1.0F - progress) + target_left * progress;
            target_right = impl_->declick_start_right * (1.0F - progress) + target_right * progress;
            --impl_->declick_remaining;
        }
        impl_->last_left = target_left;
        impl_->last_right = target_right;
        out_left[frame] = target_left;
        out_right[frame] = target_right;
    }

    if (impl_->tail_policy == TailPolicy::Conservative && observe_sleep_candidates) {
        const float observer_decay = std::pow(impl_->tail_observer_decay, static_cast<float>(frames));
        for (std::size_t index = 0; index < voice_limit; ++index) {
            Voice& voice = impl_->voices[index];
            if (!voice.active || voice.tail_sleeping) continue;
            const float noise_energy = patch_.exciter.use_upstream_noise
                ? voice.upstream_noise.envelope.value
                : voice.noise_envelope;
            const bool released_terminal = voice.released && !voice.key_down && !voice.sustained;
            const bool held_terminal = held_tail_sleep_enabled && held_tail_sleep_candidate(patch_, voice);
            const bool terminal = released_terminal || held_terminal;
            const bool exciter_quiet = voice.mallet_envelope <= 0.25F * kTailSleepThreshold
                && noise_energy <= 0.25F * kTailSleepThreshold;
            if (!voice.steal_fading && terminal && exciter_quiet) {
                voice.tail_observer = std::max(voice.tail_block_peak, voice.tail_observer * observer_decay);
                if (voice.tail_observer <= kTailSleepThreshold) {
                    voice.tail_below_frames = std::min<std::uint32_t>(
                        impl_->tail_dwell_frames,
                        voice.tail_below_frames + frames);
                } else if (voice.tail_observer >= kTailWakeThreshold) {
                    voice.tail_below_frames = 0U;
                }
                if (voice.tail_below_frames >= impl_->tail_dwell_frames) {
                    voice.tail_sleeping = true;
                    voice.tail_sleep_frames = 0U;
                    voice.quiet_frames = 0U;
                    ++impl_->tail_sleep_stats.entries;
                }
            } else {
                voice.tail_below_frames = 0U;
                voice.tail_observer = 0.0F;
            }
        }
    }
}

std::size_t Engine::active_voice_count() const noexcept {
    std::size_t count = 0;
    if (!impl_) return count;
    for (const auto& voice : impl_->voices) if (voice.active) ++count;
    return count;
}

std::size_t Engine::held_voice_count() const noexcept {
    std::size_t count = 0;
    if (!impl_) return count;
    for (const auto& voice : impl_->voices) if (voice.active && voice.key_down) ++count;
    return count;
}

std::size_t Engine::sustained_voice_count() const noexcept {
    std::size_t count = 0;
    if (!impl_) return count;
    for (const auto& voice : impl_->voices) if (voice.active && voice.sustained) ++count;
    return count;
}

std::size_t Engine::pending_voice_steal_count() const noexcept {
    std::size_t count = 0U;
    if (!impl_) return count;
    for (const auto& voice : impl_->voices) if (voice.active && voice.steal_fading) ++count;
    return count;
}

std::uint64_t Engine::voice_steal_count() const noexcept {
    return impl_ ? impl_->voice_steal_count : 0U;
}

float Engine::db_to_gain(float db) noexcept { return std::pow(10.0F, db / 20.0F); }
float Engine::clamp(float value, float low, float high) noexcept { return clampf(value, low, high); }

// GPL-3.0 upstream-aligned filter/envelope behavior from RipplerX 1.5.18.
struct RbjFilter {
    float a1 = 0.0F;
    float a2 = 0.0F;
    float b0 = 1.0F;
    float b1 = 0.0F;
    float b2 = 0.0F;
    float x0 = 0.0F;
    float x1 = 0.0F;
    float y0 = 0.0F;
    float y1 = 0.0F;

    void lowpass(float sample_rate, float frequency, float q) noexcept {
        const float w0 = kTwoPi * std::min(frequency / sample_rate, 0.49F);
        const float alpha = std::sin(w0) / (2.0F * std::max(0.001F, q));
        const float scale = 1.0F / (1.0F + alpha);
        a1 = -2.0F * std::cos(w0) * scale;
        a2 = (1.0F - alpha) * scale;
        b2 = b0 = (1.0F + a1 + a2) * 0.25F;
        b1 = b0 * 2.0F;
    }

    void bandpass(float sample_rate, float frequency, float q) noexcept {
        const float w0 = kTwoPi * std::min(frequency / sample_rate, 0.49F);
        const float alpha = std::sin(w0) / (2.0F * std::max(0.001F, q));
        const float scale = 1.0F / (1.0F + alpha);
        a1 = -2.0F * std::cos(w0) * scale;
        a2 = (1.0F - alpha) * scale;
        b0 = (1.0F - a2) * 0.5F * q;
        b1 = 0.0F;
        b2 = -b0;
    }

    void highpass(float sample_rate, float frequency, float q) noexcept {
        const float w0 = kTwoPi * std::min(frequency / sample_rate, 0.49F);
        const float alpha = std::sin(w0) / (2.0F * std::max(0.001F, q));
        const float scale = 1.0F / (1.0F + alpha);
        a1 = -2.0F * std::cos(w0) * scale;
        a2 = (1.0F - alpha) * scale;
        b2 = b0 = (1.0F - a1 + a2) * 0.25F;
        b1 = -2.0F * b0;
    }

    void configure(NoiseFilterMode mode, float sample_rate, float frequency, float q) noexcept {
        if (mode == NoiseFilterMode::LowPass) lowpass(sample_rate, frequency, q);
        else if (mode == NoiseFilterMode::BandPass) bandpass(sample_rate, frequency, q);
        else highpass(sample_rate, frequency, q);
    }

    void clear(float input = 0.0F) noexcept {
        x0 = x1 = input;
        const float divisor = 1.0F + a1 + a2;
        y0 = y1 = std::abs(divisor) > 1.0e-9F ? input / divisor * (b0 + b1 + b2) : 0.0F;
    }

    float process(float sample) noexcept {
        const float x2 = x1;
        x1 = x0;
        x0 = sample;
        const float y2 = y1;
        y1 = y0;
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        return y0;
    }
};

struct ShapedEnvelope {
    float sample_rate = 48000.0F;
    float attack_frames = 48.0F;
    float decay_frames = 24000.0F;
    float sustain_gain = 0.0F;
    float release_frames = 24000.0F;
    float scale = 0.0F;
    float value = 0.0F;
    float attack_b = 0.0F;
    float attack_c = 0.0F;
    float decay_b = 0.0F;
    float decay_c = 0.0F;
    float release_b = 0.0F;
    float release_c = 0.0F;
    float tension_attack = 100.0F;
    float tension_decay = 100.0F;
    float tension_release = 100.0F;
    std::uint8_t state = 0U;

    static float normalize_tension(float tension) noexcept {
        const float shifted = tension + 1.0F;
        if (std::abs(shifted - 1.0F) < 1.0e-7F) return 100.0F;
        return shifted > 1.0F ? 3.001F - shifted : 0.001F + shifted;
    }

    static std::pair<float, float> coefficients(
        float target_b1,
        float target_b2,
        float target_c,
        float rate,
        float tension,
        float multiplier) noexcept {

        rate = std::max(1.0F, rate);
        if (tension > 1.0F) {
            const float t = std::pow(tension - 1.0F, 3.0F);
            const float c = std::exp(std::log((target_c + t) / t) / rate);
            const float b = (target_b1 - multiplier * t) * (1.0F - c);
            return {b, c};
        }
        const float t = std::pow(std::max(0.001F, tension), 3.0F);
        const float c = std::exp(-std::log((target_c + t) / t) / rate);
        const float b = (target_b2 + multiplier * t) * (1.0F - c);
        return {b, c};
    }

    void configure(
        float new_sample_rate,
        float attack_ms,
        float decay_ms,
        float sustain,
        float release_ms,
        float attack_tension,
        float decay_tension,
        float release_tension) noexcept {

        sample_rate = new_sample_rate;
        attack_frames = std::max(1.0F, attack_ms) * 0.001F * sample_rate;
        decay_frames = std::max(1.0F, decay_ms) * 0.001F * sample_rate;
        const float sustain_db = clampf(sustain, 0.0F, 1.0F) * 60.0F - 60.0F;
        sustain_gain = std::pow(10.0F, std::min(0.0F, sustain_db) / 20.0F);
        release_frames = std::max(1.0F, release_ms) * 0.001F * sample_rate;
        tension_attack = normalize_tension(attack_tension);
        tension_decay = normalize_tension(-decay_tension);
        tension_release = normalize_tension(-release_tension);
    }

    void reset() noexcept {
        state = 0U;
        value = 0.0F;
    }

    void trigger(float new_scale = 1.0F) noexcept {
        scale = new_scale;
        std::tie(attack_b, attack_c) = coefficients(0.0F, scale, scale, attack_frames, tension_attack, 1.0F);
        std::tie(decay_b, decay_c) = coefficients(1.0F, sustain_gain * scale, (1.0F - sustain_gain) * scale, decay_frames, tension_decay, -1.0F);
        state = 1U;
    }

    void release() noexcept {
        const float start = std::max(value, sustain_gain) * scale;
        std::tie(release_b, release_c) = coefficients(start, 0.0F, start, release_frames, tension_release, -1.0F);
        state = 8U;
    }

    float process() noexcept {
        if (state == 0U) return 0.0F;
        if (state == 1U) {
            value = attack_b + value * attack_c;
            if (value >= scale) {
                value = scale;
                state = 2U;
            }
        } else if (state == 2U) {
            value = decay_b + value * decay_c;
            if (value <= sustain_gain * scale) {
                value = sustain_gain * scale;
                state = 4U;
            }
        } else if (state == 8U) {
            value = release_b + value * release_c;
            if (value <= 0.0F || !std::isfinite(value)) reset();
        }
        return value;
    }

    [[nodiscard]] bool active() const noexcept { return state != 0U; }
};

struct UpstreamNoise {
    RbjFilter filter{};
    ShapedEnvelope envelope{};
    bool filter_active = false;

    void configure(float sample_rate, const ExciterPatch& patch, float velocity) noexcept {
        const float log_span = std::log(20000.0F) - std::log(20.0F);
        const float frequency = clampf(
            std::exp(std::log(clampf(patch.noise_filter_frequency_hz, 20.0F, 20000.0F))
                + velocity * patch.noise_velocity_frequency * log_span),
            20.0F,
            20000.0F);
        const float q = clampf(
            patch.noise_filter_q + velocity * patch.noise_velocity_q * (4.0F - 0.707F),
            0.707F,
            4.0F);
        filter_active = patch.noise_filter_mode == NoiseFilterMode::BandPass
            || (patch.noise_filter_mode == NoiseFilterMode::LowPass && frequency < 20000.0F)
            || (patch.noise_filter_mode == NoiseFilterMode::HighPass && frequency > 20.0F);
        filter.configure(patch.noise_filter_mode, sample_rate, frequency, q);
        filter.clear();

        const auto routed_time = [velocity, log_span](float value, float route) noexcept {
            return clampf(std::exp(std::log(clampf(value, 1.0F, 20000.0F)) + velocity * route * log_span), 1.0F, 20000.0F);
        };
        envelope.configure(
            sample_rate,
            routed_time(patch.noise_attack_ms, patch.noise_velocity_attack),
            routed_time(patch.noise_decay_ms, patch.noise_velocity_decay),
            clampf(patch.noise_sustain + velocity * patch.noise_velocity_sustain, 0.0F, 1.0F),
            routed_time(patch.noise_release_ms, patch.noise_velocity_release),
            patch.noise_attack_tension,
            patch.noise_decay_tension,
            patch.noise_release_tension);
    }

    void trigger() noexcept { envelope.trigger(1.0F); }
    void release() noexcept { envelope.release(); }
    void reset() noexcept { envelope.reset(); filter.clear(); }

    float process(std::uint32_t& rng) noexcept {
        if (!envelope.active()) return 0.0F;
        const float env = envelope.process();
        float sample = random_bipolar(rng);
        if (filter_active) sample = filter.process(sample);
        if (!envelope.active()) filter.clear();
        return sample * env;
    }
};

// BSD-3-Clause / GPL-compatible port of the RipplerX 1.5.18
// FairlyChildish-derived output limiter. Reference keeps the upstream limiter
// topology. Stable and Wild retain the BRK tanh output stage.
//
// Physical matched-headroom A/B on 2026-08-11 isolated the former BRK-only
// post-limiter safety knee as an audible crackle/overload source. A subsequent
// owner clean-Normal session on 2026-08-12 ran ~104 s with 680 note commands,
// zero deadline overruns, zero output-boundary hits and no audible click/crackle.
// The nonlinear knee is therefore removed from production. Canonical 28-preset
// stress keeps a transparent fixed 0.43 post-limiter gain (-7.33 dB), with Sink
// as the worst pinned Reference program at ~0.940 FS. Legacy runtime mode values
// remain temporarily as compatibility aliases only; no mode selects a nonlinear
// Reference post-limiter boundary.

struct UpstreamOutputLimiter {
    ReferenceOutputMode reference_output_mode = ReferenceOutputMode::Normal;
    double run_db = 0.0;
    double run_average = 0.0;
    double attack_coefficient = 0.0;
    double release_coefficient = 0.0;

    void prepare(double sample_rate) noexcept {
        run_db = 0.0;
        run_average = 0.0;
        attack_coefficient = std::exp(-1.0 / (0.0002 * sample_rate));
        release_coefficient = std::exp(-1.0 / (0.3 * sample_rate));
    }

    void reset() noexcept {
        run_db = 0.0;
        run_average = 0.0;
    }

    void set_reference_output_mode(ReferenceOutputMode mode) noexcept {
        reference_output_mode = mode;
    }

    [[nodiscard]] ReferenceOutputMode get_reference_output_mode() const noexcept {
        return reference_output_mode;
    }

    std::pair<float, float> process(float left, float right) noexcept {
        constexpr double log_to_db = 8.685889638065036553;
        constexpr double db_to_log = 0.1151292546497022842;
        constexpr double ratio = 20.0;
        constexpr double bias = 56.0; // 80% of the upstream default 70 control.

        // left/right arrive as binary32 values. Converting them to double is exact,
        // and the old square was also exact because a 24-bit significand squared fits
        // inside binary64's 53-bit significand. sqrt(x*x) therefore reconstructs the
        // same non-negative binary32 value exactly; use it directly and avoid a hot sqrt.
        const double detector = std::max(
            std::abs(static_cast<double>(left)),
            std::abs(static_cast<double>(right)));

        // RipplerX 1.5.18 initializes its RMS coefficient before assigning the
        // requested window, which makes the effective coefficient zero. Preserve the
        // exact old runtime state even though detector no longer needs square -> sqrt.
        run_average = detector * detector;
        const double over_db = detector > 1.0
            ? log_to_db * std::log(detector)
            : 0.0;

        if (over_db > run_db) run_db = over_db + attack_coefficient * (run_db - over_db);
        else run_db = over_db + release_coefficient * (run_db - over_db);

        constexpr float reference_headroom = 0.43F;
        // If both the current detector and compressor history are exactly zero dB,
        // the old path computes sqrt(0), reduction -0 and exp(-0) == 1.0 exactly.
        if (run_db == 0.0) {
            return {
                reference_headroom * left,
                reference_headroom * right,
            };
        }

        const double positive_over_db = std::max(0.0, run_db);
        const double compression_ratio = bias == 0.0
            ? ratio
            : 1.0 + (ratio - 1.0) * std::sqrt(positive_over_db / bias);
        const double reduction_db = -positive_over_db * (compression_ratio - 1.0) / compression_ratio;
        const float gain = static_cast<float>(std::exp(reduction_db * db_to_log));
        const float processed_left = left * gain;
        const float processed_right = right * gain;
        // The owner physically accepted this transparent topology. Legacy
        // ReferenceOutputMode values are compatibility aliases and deliberately
        // do not alter the production signal path.
        return {
            reference_headroom * processed_left,
            reference_headroom * processed_right,
        };
    }
};

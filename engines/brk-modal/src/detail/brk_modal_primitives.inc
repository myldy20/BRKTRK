struct ModalBank {
    struct Candidate {
        std::size_t source_index = 0U;
        float amplitude = 0.0F;
        float frequency = 0.0F;
        float decay = 0.0F;
        float damping_scale = 1.0F;
        float importance = 0.0F;
        float tone_negative_base = 1.0F;
        float tone_positive_base = 1.0F;
        float tone_hit_gain = 0.0F;
        float tone_model_gain = 0.0F;
        float tone_focus_gain = 0.0F;
    };

    alignas(16) std::array<float, kMaxPartials> b0{};
    alignas(16) std::array<float, kMaxPartials> b2{};
    alignas(16) std::array<float, kMaxPartials> a1{};
    alignas(16) std::array<float, kMaxPartials> a2{};
    // Runtime-only invariants for exact decay-only coefficient refresh.
    alignas(16) std::array<float, kMaxPartials> decay_damping_scale{};
    alignas(16) std::array<float, kMaxPartials> decay_b0_numerator{};
    alignas(16) std::array<float, kMaxPartials> decay_b2_numerator{};
    alignas(16) std::array<float, kMaxPartials> decay_a1_numerator{};
    // Runtime-only invariants for exact Tone-only refresh. These retain the
    // original configure() floating-point expression order while avoiding
    // frequency/decay/table reconstruction when topology is unchanged.
    alignas(16) std::array<float, kMaxPartials> tone_negative_base{};
    alignas(16) std::array<float, kMaxPartials> tone_positive_base{};
    alignas(16) std::array<float, kMaxPartials> tone_hit_gain{};
    alignas(16) std::array<float, kMaxPartials> tone_model_gain{};
    alignas(16) std::array<float, kMaxPartials> tone_focus_gain{};
    alignas(16) std::array<float, kMaxPartials> tone_a0{};
    alignas(16) std::array<float, kMaxPartials> tone_amplitude_scratch{};
    alignas(16) std::array<float, kMaxPartials> x1{};
    alignas(16) std::array<float, kMaxPartials> x2{};
    alignas(16) std::array<float, kMaxPartials> y1{};
    alignas(16) std::array<float, kMaxPartials> y2{};
    std::array<std::size_t, kMaxPartials> source_indices{};
    std::size_t active_partials = 0;
    float energy = 0.0F;
    ModalKernel kernel = ModalKernel::Scalar;
    bool decay_fast_path_eligible = false;
    bool tone_fast_path_eligible = false;
    // Number of consecutive exact-zero bank inputs immediately preceding the
    // current sample, saturated at two. Once it reaches two, x1/x2 are both
    // guaranteed exact zero for every mode and the feed-forward DFI terms can
    // be skipped without thresholding or removing modal state.
    std::uint32_t zero_input_frames = 2U;

    void reset() noexcept {
        x1.fill(0.0F);
        x2.fill(0.0F);
        y1.fill(0.0F);
        y2.fill(0.0F);
        source_indices.fill(kMaxPartials);
        energy = 0.0F;
        decay_fast_path_eligible = false;
        tone_fast_path_eligible = false;
        zero_input_frames = 2U;
    }

    void configure(
        double sample_rate,
        float base_frequency,
        float velocity,
        bool released,
        const ResonatorPatch& patch,
        const std::array<float, kMaxPartials>& ratios,
        const std::array<float, kMaxPartials>& gains) noexcept {

        const std::size_t previous_active = active_partials;
        const std::size_t requested = std::max<std::size_t>(1U, std::min<std::size_t>(patch.partials, kMaxPartials));
        const std::size_t budget = std::max<std::size_t>(
            1U,
            std::min<std::size_t>(requested, patch.max_render_partials));
        const float frequency_guard = std::min(20000.0F, static_cast<float>(sample_rate) * 0.47F);
        const float fundamental = base_frequency * pitch_factor(patch);
        const auto modal_ratio = [&](std::size_t index) noexcept {
            if (patch.model == Model::Djembe) {
                return 1.0F + (200.0F * static_cast<float>(index) * clampf(patch.ratio, 0.1F, 10.0F))
                    / std::max(1.0F, fundamental);
            }
            return std::max(1.0e-5F, ratios[index]);
        };
        const float ratio_max = modal_ratio(kMaxPartials - 1U);
        const float upstream_inharm = clampf(
            std::exp(std::log(clampf(patch.inharmonicity, 0.0001F, 1.0F))
                + velocity * patch.upstream_velocity.inharmonicity * -std::log(0.0001F)) - 0.0001F,
            0.0F,
            1.0F);
        float decay_base = clampf(
            std::exp(std::log(clampf(patch.decay_seconds, 0.01F, 100.0F))
                + velocity * patch.upstream_velocity.decay * (std::log(100.0F) - std::log(0.01F))),
            0.01F,
            100.0F);
        if (released) decay_base *= clampf(patch.release_scale, 0.001F, 1.0F);
        const float material = clampf(patch.material + patch.upstream_velocity.material * 2.0F * velocity, -1.0F, 1.0F);
        const float tone = clampf(patch.tone + patch.upstream_velocity.tone * 2.0F * velocity, -1.0F, 1.0F);
        const float hit = clampf(patch.hit_position + patch.upstream_velocity.hit_position * velocity * 0.5F, 0.02F, 0.5F);
        const float focus = clampf(patch.spectral_focus, 0.0F, 1.0F);
        const float alpha = kTwoPi / static_cast<float>(sample_rate);

        std::array<Candidate, kMaxPartials> candidates{};
        std::size_t candidate_count = 0U;
        float full_amplitude_energy = 0.0F;

        for (std::size_t index = 0; index < requested; ++index) {
            const float ratio = modal_ratio(index);
            const float inharmonic_scale = std::sqrt(1.0F + upstream_inharm * (ratio - 1.0F) * (ratio - 1.0F));
            const float frequency = fundamental * ratio * inharmonic_scale;
            if (!(frequency > 1.0F && frequency < frequency_guard)) continue;

            // RipplerX uses model[63] as ratio_max even when fewer partials are rendered,
            // and applies the current partial's inharmonic scale to that upper reference.
            const float max_frequency = std::min(20000.0F, fundamental * ratio_max * inharmonic_scale);
            const float damping_scale = material <= 0.0F
                ? std::pow(std::max(1.0e-5F, fundamental / frequency), material * 2.0F)
                : std::pow(std::max(1.0e-5F, max_frequency / frequency), material * 2.0F);
            const float raw_decay = decay_base / std::max(1.0e-12F, damping_scale);
            const float decay = patch.normalize_modal_energy
                ? clampf(raw_decay, 0.002F, 100.0F)
                : std::max(1.0e-6F, raw_decay);

            const float tone_negative_base = std::max(1.0e-5F, frequency / fundamental);
            const float tone_positive_base = std::max(1.0e-5F, frequency / max_frequency);
            const float tone_gain = tone <= 0.0F
                ? std::pow(tone_negative_base, tone * 2.0F)
                : std::pow(tone_positive_base, tone * 2.0F);

            const float hit_gain = std::abs(std::sin(kPi * static_cast<float>(index + 1U) * hit));
            const float focus_gain = std::pow(static_cast<float>(index + 1U), -0.75F * focus);
            const float amplitude = hit_gain * tone_gain * gains[index] * focus_gain;
            const float frequency_weight = 1.0F / std::sqrt(1.0F + frequency / 12000.0F);
            float importance = amplitude * amplitude * std::sqrt(std::max(1.0e-6F, decay)) * frequency_weight;
            if (candidate_count == 0U) importance = std::numeric_limits<float>::max();

            candidates[candidate_count] = {
                index, amplitude, frequency, decay, damping_scale, importance,
                tone_negative_base, tone_positive_base, hit_gain, gains[index], focus_gain
            };
            full_amplitude_energy += amplitude * amplitude;
            ++candidate_count;
        }

        if (candidate_count == 0U) {
            active_partials = 0U;
            decay_fast_path_eligible = false;
            tone_fast_path_eligible = false;
            return;
        }

        const std::size_t selected_count = std::min(budget, candidate_count);
        // Decay affects importance ranking. Only specialize when all valid modes
        // are retained, so selected topology cannot change with Decay.
        decay_fast_path_eligible = selected_count == candidate_count;
        // Tone can change importance ranking when a quality profile drops modes.
        // Specialize only when every valid mode is retained, so topology and
        // source order are provably invariant under Tone.
        tone_fast_path_eligible = selected_count == candidate_count;
        if (selected_count < candidate_count) {
            // Full/Reference normally keeps every valid mode. Preserve the already
            // canonical source order and avoid two O(N log N) sorts on every attack
            // and damped release. Reduced profiles pay the ranking cost only when
            // they actually need to discard modes.
            std::partial_sort(
                candidates.begin(),
                candidates.begin() + static_cast<std::ptrdiff_t>(selected_count),
                candidates.begin() + static_cast<std::ptrdiff_t>(candidate_count),
                [](const Candidate& left, const Candidate& right) {
                    if (left.importance == right.importance) return left.source_index < right.source_index;
                    return left.importance > right.importance;
                });
            std::sort(
                candidates.begin(),
                candidates.begin() + static_cast<std::ptrdiff_t>(selected_count),
                [](const Candidate& left, const Candidate& right) {
                    return left.source_index < right.source_index;
                });
        }

        float selected_amplitude_energy = 0.0F;
        for (std::size_t index = 0; index < selected_count; ++index) {
            selected_amplitude_energy += candidates[index].amplitude * candidates[index].amplitude;
        }

        float normalization = 35.0F;
        float velocity_gain = 1.0F;
        if (patch.normalize_modal_energy) {
            normalization = selected_amplitude_energy > 1.0e-9F
                ? 35.0F / std::sqrt(selected_amplitude_energy)
                : 0.0F;
            velocity_gain = 0.70F + 0.30F * clampf(velocity, 0.0F, 1.0F);
        } else if (selected_count < candidate_count && selected_amplitude_energy > 1.0e-9F) {
            // Quality profiles retain approximate bank level while dropping low-value modes.
            normalization *= std::sqrt(full_amplitude_energy / selected_amplitude_energy);
        }

        for (std::size_t index = 0; index < selected_count; ++index) {
            const Candidate& candidate = candidates[index];
            if (index >= previous_active || source_indices[index] != candidate.source_index) {
                x1[index] = x2[index] = y1[index] = y2[index] = 0.0F;
            }
            source_indices[index] = candidate.source_index;
            const float omega = kTwoPi * candidate.frequency / static_cast<float>(sample_rate);
            const float a0 = 1.0F + alpha / candidate.decay;
            tone_negative_base[index] = candidate.tone_negative_base;
            tone_positive_base[index] = candidate.tone_positive_base;
            tone_hit_gain[index] = candidate.tone_hit_gain;
            tone_model_gain[index] = candidate.tone_model_gain;
            tone_focus_gain[index] = candidate.tone_focus_gain;
            tone_a0[index] = a0;
            const float amplitude = candidate.amplitude * normalization * velocity_gain;
            const float b0_numerator = alpha * amplitude;
            const float b2_numerator = -alpha * amplitude;
            const float a1_numerator = -2.0F * std::cos(omega);
            decay_damping_scale[index] = candidate.damping_scale;
            decay_b0_numerator[index] = b0_numerator;
            decay_b2_numerator[index] = b2_numerator;
            decay_a1_numerator[index] = a1_numerator;
            b0[index] = b0_numerator / a0;
            b2[index] = b2_numerator / a0;
            a1[index] = a1_numerator / a0;
            a2[index] = (1.0F - alpha / candidate.decay) / a0;
        }
        for (std::size_t index = selected_count; index < previous_active; ++index) {
            x1[index] = x2[index] = y1[index] = y2[index] = 0.0F;
            source_indices[index] = kMaxPartials;
        }
        active_partials = selected_count;
    }

    bool reconfigure_decay(
        double sample_rate,
        float velocity,
        bool released,
        const ResonatorPatch& patch) noexcept {

        if (!decay_fast_path_eligible || active_partials == 0U) return false;
        float decay_base = clampf(
            std::exp(std::log(clampf(patch.decay_seconds, 0.01F, 100.0F))
                + velocity * patch.upstream_velocity.decay
                    * (std::log(100.0F) - std::log(0.01F))),
            0.01F,
            100.0F);
        if (released) decay_base *= clampf(patch.release_scale, 0.001F, 1.0F);
        const float alpha = kTwoPi / static_cast<float>(sample_rate);

        for (std::size_t index = 0; index < active_partials; ++index) {
            const float raw_decay = decay_base
                / std::max(1.0e-12F, decay_damping_scale[index]);
            const float decay = patch.normalize_modal_energy
                ? clampf(raw_decay, 0.002F, 100.0F)
                : std::max(1.0e-6F, raw_decay);
            const float a0 = 1.0F + alpha / decay;
            tone_a0[index] = a0;
            b0[index] = decay_b0_numerator[index] / a0;
            b2[index] = decay_b2_numerator[index] / a0;
            a1[index] = decay_a1_numerator[index] / a0;
            a2[index] = (1.0F - alpha / decay) / a0;
        }
        return true;
    }

    bool reconfigure_tone(
        double sample_rate,
        float velocity,
        const ResonatorPatch& patch) noexcept {

        if (!tone_fast_path_eligible || active_partials == 0U) return false;
        const float tone = clampf(
            patch.tone + patch.upstream_velocity.tone * 2.0F * velocity,
            -1.0F,
            1.0F);

        float selected_amplitude_energy = 0.0F;
        for (std::size_t index = 0; index < active_partials; ++index) {
            const float tone_gain = tone <= 0.0F
                ? std::pow(tone_negative_base[index], tone * 2.0F)
                : std::pow(tone_positive_base[index], tone * 2.0F);
            const float amplitude = tone_hit_gain[index] * tone_gain
                * tone_model_gain[index] * tone_focus_gain[index];
            tone_amplitude_scratch[index] = amplitude;
            selected_amplitude_energy += amplitude * amplitude;
        }

        float normalization = 35.0F;
        float velocity_gain = 1.0F;
        if (patch.normalize_modal_energy) {
            normalization = selected_amplitude_energy > 1.0e-9F
                ? 35.0F / std::sqrt(selected_amplitude_energy)
                : 0.0F;
            velocity_gain = 0.70F + 0.30F * clampf(velocity, 0.0F, 1.0F);
        }

        const float alpha = kTwoPi / static_cast<float>(sample_rate);
        for (std::size_t index = 0; index < active_partials; ++index) {
            const float amplitude = tone_amplitude_scratch[index] * normalization * velocity_gain;
            const float b0_numerator = alpha * amplitude;
            const float b2_numerator = -alpha * amplitude;
            decay_b0_numerator[index] = b0_numerator;
            decay_b2_numerator[index] = b2_numerator;
            b0[index] = b0_numerator / tone_a0[index];
            b2[index] = b2_numerator / tone_a0[index];
        }
        return true;
    }

    void set_kernel(ModalKernel requested) noexcept {
        kernel = resolve_modal_kernel(requested);
    }

    float process_scalar(float input) noexcept {
        float output = 0.0F;
        const bool homogeneous = input == 0.0F && zero_input_frames >= 2U;
        for (std::size_t index = 0; index < active_partials; ++index) {
            float y = 0.0F;
            if (homogeneous) {
                // Preserve the old left-to-right recurrence once b0*x and b2*x2
                // are both provably exact zero. x1/x2 are already zero and stay zero.
                y = 0.0F - a1[index] * y1[index];
                y = y - a2[index] * y2[index];
            } else {
                y = b0[index] * input + b2[index] * x2[index] - a1[index] * y1[index] - a2[index] * y2[index];
                x2[index] = x1[index];
                x1[index] = input;
            }
            y2[index] = y1[index];
            y1[index] = y;
            output += y;
        }
        return output;
    }

#if defined(BRK_MODAL_VECTOR_WASM) || defined(BRK_MODAL_VECTOR_NEON) || defined(BRK_MODAL_VECTOR_SSE2)
    float process_vector4(float input, bool preserve_sum_order) noexcept {
        float output = 0.0F;
        std::size_t index = 0U;
        alignas(16) float lanes[4]{};
        std::size_t groups_in_chunk = 0U;
        const bool homogeneous = input == 0.0F && zero_input_frames >= 2U;

#if defined(BRK_MODAL_VECTOR_WASM)
        const v128_t input_vector = wasm_f32x4_splat(input);
        v128_t output_vector = wasm_f32x4_splat(0.0F);
        for (; index + 4U <= active_partials; index += 4U) {
            const v128_t previous_y1 = wasm_v128_load(y1.data() + index);
            v128_t y;
            if (homogeneous) {
                y = wasm_f32x4_splat(0.0F);
                y = wasm_f32x4_sub(y, wasm_f32x4_mul(wasm_v128_load(a1.data() + index), previous_y1));
                y = wasm_f32x4_sub(y, wasm_f32x4_mul(wasm_v128_load(a2.data() + index), wasm_v128_load(y2.data() + index)));
            } else {
                const v128_t previous_x1 = wasm_v128_load(x1.data() + index);
                y = wasm_f32x4_mul(wasm_v128_load(b0.data() + index), input_vector);
                y = wasm_f32x4_add(y, wasm_f32x4_mul(wasm_v128_load(b2.data() + index), wasm_v128_load(x2.data() + index)));
                y = wasm_f32x4_sub(y, wasm_f32x4_mul(wasm_v128_load(a1.data() + index), previous_y1));
                y = wasm_f32x4_sub(y, wasm_f32x4_mul(wasm_v128_load(a2.data() + index), wasm_v128_load(y2.data() + index)));
                wasm_v128_store(x2.data() + index, previous_x1);
                wasm_v128_store(x1.data() + index, input_vector);
            }
            wasm_v128_store(y2.data() + index, previous_y1);
            wasm_v128_store(y1.data() + index, y);
            if (preserve_sum_order) {
                wasm_v128_store(lanes, y);
                output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
            } else {
                output_vector = wasm_f32x4_add(output_vector, y);
            }
            if (!preserve_sum_order && ++groups_in_chunk == 4U) {
                wasm_v128_store(lanes, output_vector);
                output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
                output_vector = wasm_f32x4_splat(0.0F);
                groups_in_chunk = 0U;
            }
        }
        if (!preserve_sum_order && groups_in_chunk != 0U) {
            wasm_v128_store(lanes, output_vector);
            output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
        }
#elif defined(BRK_MODAL_VECTOR_NEON)
        const float32x4_t input_vector = vdupq_n_f32(input);
        float32x4_t output_vector = vdupq_n_f32(0.0F);
        for (; index + 4U <= active_partials; index += 4U) {
            const float32x4_t previous_y1 = vld1q_f32(y1.data() + index);
            float32x4_t y;
            if (homogeneous) {
                y = vdupq_n_f32(0.0F);
                y = vsubq_f32(y, vmulq_f32(vld1q_f32(a1.data() + index), previous_y1));
                y = vsubq_f32(y, vmulq_f32(vld1q_f32(a2.data() + index), vld1q_f32(y2.data() + index)));
            } else {
                const float32x4_t previous_x1 = vld1q_f32(x1.data() + index);
                y = vmulq_f32(vld1q_f32(b0.data() + index), input_vector);
                y = vaddq_f32(y, vmulq_f32(vld1q_f32(b2.data() + index), vld1q_f32(x2.data() + index)));
                y = vsubq_f32(y, vmulq_f32(vld1q_f32(a1.data() + index), previous_y1));
                y = vsubq_f32(y, vmulq_f32(vld1q_f32(a2.data() + index), vld1q_f32(y2.data() + index)));
                vst1q_f32(x2.data() + index, previous_x1);
                vst1q_f32(x1.data() + index, input_vector);
            }
            vst1q_f32(y2.data() + index, previous_y1);
            vst1q_f32(y1.data() + index, y);
            if (preserve_sum_order) {
                vst1q_f32(lanes, y);
                output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
            } else {
                output_vector = vaddq_f32(output_vector, y);
            }
            if (!preserve_sum_order && ++groups_in_chunk == 4U) {
                vst1q_f32(lanes, output_vector);
                output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
                output_vector = vdupq_n_f32(0.0F);
                groups_in_chunk = 0U;
            }
        }
        if (!preserve_sum_order && groups_in_chunk != 0U) {
            vst1q_f32(lanes, output_vector);
            output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
        }
#elif defined(BRK_MODAL_VECTOR_SSE2)
        const __m128 input_vector = _mm_set1_ps(input);
        __m128 output_vector = _mm_setzero_ps();
        for (; index + 4U <= active_partials; index += 4U) {
            const __m128 previous_y1 = _mm_loadu_ps(y1.data() + index);
            __m128 y;
            if (homogeneous) {
                y = _mm_setzero_ps();
                y = _mm_sub_ps(y, _mm_mul_ps(_mm_loadu_ps(a1.data() + index), previous_y1));
                y = _mm_sub_ps(y, _mm_mul_ps(_mm_loadu_ps(a2.data() + index), _mm_loadu_ps(y2.data() + index)));
            } else {
                const __m128 previous_x1 = _mm_loadu_ps(x1.data() + index);
                y = _mm_mul_ps(_mm_loadu_ps(b0.data() + index), input_vector);
                y = _mm_add_ps(y, _mm_mul_ps(_mm_loadu_ps(b2.data() + index), _mm_loadu_ps(x2.data() + index)));
                y = _mm_sub_ps(y, _mm_mul_ps(_mm_loadu_ps(a1.data() + index), previous_y1));
                y = _mm_sub_ps(y, _mm_mul_ps(_mm_loadu_ps(a2.data() + index), _mm_loadu_ps(y2.data() + index)));
                _mm_storeu_ps(x2.data() + index, previous_x1);
                _mm_storeu_ps(x1.data() + index, input_vector);
            }
            _mm_storeu_ps(y2.data() + index, previous_y1);
            _mm_storeu_ps(y1.data() + index, y);
            if (preserve_sum_order) {
                _mm_store_ps(lanes, y);
                output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
            } else {
                output_vector = _mm_add_ps(output_vector, y);
            }
            if (!preserve_sum_order && ++groups_in_chunk == 4U) {
                _mm_store_ps(lanes, output_vector);
                output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
                output_vector = _mm_setzero_ps();
                groups_in_chunk = 0U;
            }
        }
        if (!preserve_sum_order && groups_in_chunk != 0U) {
            _mm_store_ps(lanes, output_vector);
            output += lanes[0]; output += lanes[1]; output += lanes[2]; output += lanes[3];
        }
#endif

        for (; index < active_partials; ++index) {
            float y = 0.0F;
            if (homogeneous) {
                y = 0.0F - a1[index] * y1[index];
                y = y - a2[index] * y2[index];
            } else {
                y = b0[index] * input + b2[index] * x2[index] - a1[index] * y1[index] - a2[index] * y2[index];
                x2[index] = x1[index];
                x1[index] = input;
            }
            y2[index] = y1[index];
            y1[index] = y;
            output += y;
        }
        return output;
    }
#endif

    float process(float input, bool preserve_sum_order = false) noexcept {
        (void)preserve_sum_order;
        float output = 0.0F;
#if defined(BRK_MODAL_VECTOR_WASM) || defined(BRK_MODAL_VECTOR_NEON) || defined(BRK_MODAL_VECTOR_SSE2)
        output = kernel == ModalKernel::Vector4 ? process_vector4(input, preserve_sum_order) : process_scalar(input);
#else
        output = process_scalar(input);
#endif
        if (input == 0.0F) {
            zero_input_frames = std::min<std::uint32_t>(2U, zero_input_frames + 1U);
        } else {
            zero_input_frames = 0U;
        }
        energy = 0.9995F * energy + 0.0005F * std::abs(output);
        return output;
    }
};

struct Waveguide {
    std::array<float, kWaveguideFrames> buffer{};
    std::size_t write_index = 0;
    float read_position = 0.0F;
    float feedback = 0.0F;
    float lowpass_state = 0.0F;
    float radius = 0.5F;
    bool closed = false;
    float energy = 0.0F;

    void reset() noexcept {
        buffer.fill(0.0F);
        write_index = 0;
        read_position = 0.0F;
        lowpass_state = 0.0F;
        energy = 0.0F;
    }

    void configure(
        double sample_rate,
        float base_frequency,
        float velocity,
        bool released,
        const ResonatorPatch& patch,
        float model_ratio) noexcept {

        closed = patch.model == Model::ClosedTube;
        radius = clampf(patch.tube_radius, 0.0F, 1.0F);
        const float tuned_frequency = std::max(12.0F, base_frequency * pitch_factor(patch) * model_ratio);
        float delay_frames = static_cast<float>(sample_rate) / tuned_frequency;
        if (closed) delay_frames *= 0.5F;
        delay_frames = clampf(delay_frames, 2.0F, static_cast<float>(kWaveguideFrames - 2U));
        read_position = static_cast<float>(write_index) - delay_frames;
        while (read_position < 0.0F) read_position += static_cast<float>(kWaveguideFrames);

        float decay_seconds = clampf(
            std::exp(std::log(clampf(patch.decay_seconds, 0.01F, 100.0F))
                + velocity * patch.upstream_velocity.decay * (std::log(100.0F) - std::log(0.01F))),
            0.005F,
            100.0F);
        if (released) decay_seconds *= clampf(patch.release_scale, 0.001F, 1.0F);
        const float denominator = static_cast<float>(sample_rate) * decay_seconds / 125000.0F;
        feedback = denominator > 0.0F
            ? std::exp(-kPi / std::max(1.0F, tuned_frequency) / denominator)
            : 0.0F;
    }

    float process(float input) noexcept {
        const auto i0 = static_cast<std::size_t>(read_position);
        const auto i1 = (i0 + 1U) % kWaveguideFrames;
        const float frac = read_position - static_cast<float>(i0);
        const float delayed = buffer[i0] * (1.0F - frac) + buffer[i1] * frac;
        lowpass_state = radius * delayed + (1.0F - radius) * lowpass_state;
        const float reflected = lowpass_state * feedback * (closed ? -1.0F : 1.0F);
        buffer[write_index] = input + reflected;
        write_index = (write_index + 1U) % kWaveguideFrames;
        read_position += 1.0F;
        if (read_position >= static_cast<float>(kWaveguideFrames)) read_position -= static_cast<float>(kWaveguideFrames);
        energy = 0.9995F * energy + 0.0005F * std::abs(reflected);
        return reflected;
    }
};

struct Resonator {
    ModalBank modal{};
    Waveguide waveguide{};
    RbjFilter output_filter{};
    bool enabled = false;
    bool tube = false;
    float low_cut = 0.0F;

    void reset() noexcept {
        modal.reset();
        waveguide.reset();
        output_filter.clear();
    }

    void configure(
        double sample_rate,
        float frequency,
        float velocity,
        bool released,
        const ResonatorPatch& patch,
        const std::array<float, kMaxPartials>& ratios,
        const std::array<float, kMaxPartials>& gains) noexcept {

        enabled = patch.enabled;
        tube = patch.model == Model::OpenTube || patch.model == Model::ClosedTube;
        low_cut = clampf(patch.low_cut, -1.0F, 1.0F);
        const float cutoff_hz = 20.0F * std::pow(1000.0F, low_cut < 0.0F ? 1.0F + low_cut : low_cut);
        if (low_cut < 0.0F) output_filter.lowpass(static_cast<float>(sample_rate), cutoff_hz, 0.707F);
        else output_filter.highpass(static_cast<float>(sample_rate), cutoff_hz, 0.707F);
        if (!enabled) return;
        if (tube) waveguide.configure(sample_rate, frequency, velocity, released, patch, ratios[0]);
        else modal.configure(sample_rate, frequency, velocity, released, patch, ratios, gains);
    }

    bool reconfigure_decay(
        double sample_rate,
        float velocity,
        bool released,
        const ResonatorPatch& patch) noexcept {
        if (!enabled) return true;
        if (tube) return false;
        return modal.reconfigure_decay(sample_rate, velocity, released, patch);
    }

    bool reconfigure_tone(
        double sample_rate,
        float velocity,
        const ResonatorPatch& patch) noexcept {
        if (!enabled) return true;
        if (tube) return false;
        return modal.reconfigure_tone(sample_rate, velocity, patch);
    }

    void set_modal_kernel(ModalKernel kernel) noexcept {
        modal.set_kernel(kernel);
    }

    float process(float input, bool preserve_sum_order = false) noexcept {
        if (!enabled) return 0.0F;
        float output = tube ? waveguide.process(input) : modal.process(input, preserve_sum_order);
        if (low_cut != 0.0F) output = output_filter.process(output);
        return output;
    }

    float energy() const noexcept { return tube ? waveguide.energy : modal.energy; }
};

struct CombStereoizer {
    std::array<float, kStereoDelayFrames> buffer{};
    std::size_t write_index = 0;
    std::size_t active_frames = 960;

    void prepare(double sample_rate) noexcept {
        // RipplerX 1.5.18 allocates int(20 ms * sample_rate) samples,
        // writes the current sample, advances the cursor, then reads
        // the new cursor. Therefore the effective delayed sample is
        // active_frames - 1 frames old (959 at 48 kHz), not a rounded
        // exact 20-ms tap. Preserve that source behavior for Reference
        // parity; width remains a BRK host extension over the same tap.
        active_frames = std::clamp<std::size_t>(
            static_cast<std::size_t>(0.020 * sample_rate),
            2U,
            kStereoDelayFrames);
        reset();
    }

    void reset() noexcept {
        buffer.fill(0.0F);
        write_index = 0;
    }

    std::pair<float, float> process_with_amount(float input, float amount) noexcept {
        buffer[write_index] = input;
        ++write_index;
        if (write_index == active_frames) write_index = 0U;
        const float delayed = buffer[write_index];
        return {input + delayed * amount, input - delayed * amount};
    }

    std::pair<float, float> process(float input, float width) noexcept {
        return process_with_amount(input, 0.33F * clampf(width, 0.0F, 1.0F));
    }
};

struct Voice {
    bool active = false;
    bool key_down = false;
    bool sustained = false;
    bool released = false;
    std::uint32_t note_id = 0;
    std::int16_t key = 60;
    float velocity = 0.0F;
    float shaped_velocity = 0.0F;
    float excitation_gain = 0.0F;
    float tuning = 0.0F;
    float frequency = 261.625565F;
    float noise_color = 0.5F;
    std::uint64_t age = 0;
    std::uint64_t release_age = 0;
    std::uint32_t quiet_frames = 0;
    std::uint32_t tail_below_frames = 0;
    std::uint32_t tail_sleep_frames = 0;
    float tail_observer = 0.0F;
    float tail_block_peak = 0.0F;
    bool tail_sleeping = false;
    std::uint32_t rng = 1U;

    // Pinned RipplerX recycles an audible selected voice by fading that voice
    // for 1 ms before clearing/restarting it. Keep the pending note entirely
    // runtime-local; authored state and ABI v1 remain untouched.
    bool steal_fading = false;
    std::uint32_t steal_fade_total = 0U;
    std::uint32_t steal_fade_remaining = 0U;
    NoteOn pending_note{};

    float mallet_envelope = 0.0F;
    float mallet_decay = 0.0F;
    float noise_envelope = 0.0F;
    float noise_decay = 0.0F;
    float noise_lowpass = 0.0F;

    // Patch + fixed-note-velocity invariants. They are refreshed by
    // configure_voice_for_patch(), including sample-accurate patch/ramp updates.
    float mallet_direct_gain = 0.0F;
    float mallet_resonator_gain = 0.0F;
    float noise_direct_gain = 0.0F;
    float noise_resonator_gain = 0.0F;
    float spread_left_gain = 1.0F;
    float spread_right_gain = 1.0F;
    Biquad mallet_filter{};
    UpstreamNoise upstream_noise{};
    Resonator a{};
    Resonator b{};
    std::array<float, kMaxPartials> ratios_a{};
    std::array<float, kMaxPartials> ratios_b{};

    void set_modal_kernel(ModalKernel kernel) noexcept {
        a.set_modal_kernel(kernel);
        b.set_modal_kernel(kernel);
    }

    void reset() noexcept {
        active = false;
        key_down = false;
        sustained = false;
        released = false;
        note_id = 0;
        release_age = 0;
        quiet_frames = 0;
        tail_below_frames = 0;
        tail_sleep_frames = 0;
        tail_observer = 0.0F;
        tail_block_peak = 0.0F;
        tail_sleeping = false;
        steal_fading = false;
        steal_fade_total = 0U;
        steal_fade_remaining = 0U;
        pending_note = {};
        shaped_velocity = 0.0F;
        excitation_gain = 0.0F;
        mallet_envelope = 0.0F;
        noise_envelope = 0.0F;
        noise_lowpass = 0.0F;
        mallet_direct_gain = 0.0F;
        mallet_resonator_gain = 0.0F;
        noise_direct_gain = 0.0F;
        noise_resonator_gain = 0.0F;
        spread_left_gain = 1.0F;
        spread_right_gain = 1.0F;
        mallet_filter.reset();
        upstream_noise.reset();
        a.reset();
        b.reset();
    }
};

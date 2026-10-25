#include "brk_modal/auto_quality.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>

namespace {

brk::modal::Patch make_dense_crash_like() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Plate;
    patch.resonator_a.partials = 64U;
    patch.resonator_a.decay_seconds = 5.39F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Plate;
    patch.resonator_b.partials = 64U;
    patch.resonator_b.decay_seconds = 9.53F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.noise_resonator = 0.1448F;
    patch.coupling = Coupling::Parallel;
    return patch;
}

brk::modal::Patch make_serial_bell_like() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 12U;
    patch.resonator_a.model = Model::Plate;
    patch.resonator_a.partials = 64U;
    patch.resonator_a.decay_seconds = 5.2F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Drumhead;
    patch.resonator_b.partials = 40U;
    patch.resonator_b.decay_seconds = 2.9F;
    patch.coupling = Coupling::Serial;
    return patch;
}

brk::modal::Patch make_gong_like() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Drumhead;
    patch.resonator_a.partials = 64U;
    patch.resonator_a.decay_seconds = 17.17F;
    patch.resonator_b.enabled = false;
    return patch;
}

brk::modal::Patch make_tolerant_bar() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Marimba;
    patch.resonator_a.partials = 48U;
    patch.resonator_b.enabled = false;
    return patch;
}

brk::modal::Patch make_dense_audio_parity_crash() {
    using namespace brk::modal;
    Patch patch{};
    patch.polyphony = 16U;
    patch.resonator_a.model = Model::Plate;
    patch.resonator_a.partials = 64U;
    patch.resonator_a.decay_seconds = 5.39F;
    patch.resonator_a.material = 0.19F;
    patch.resonator_a.tone = 0.36F;
    patch.resonator_a.ratio = 0.78F;
    patch.resonator_a.coarse_semitones = -12.0F;
    patch.resonator_a.fine_cents = 14.0F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Plate;
    patch.resonator_b.partials = 64U;
    patch.resonator_b.decay_seconds = 9.53F;
    patch.resonator_b.tone = 0.30F;
    patch.resonator_b.ratio = 0.78F;
    patch.resonator_b.coarse_semitones = -3.0F;
    patch.resonator_b.fine_cents = 33.0F;
    patch.coupling = Coupling::Parallel;
    patch.parallel_mix = 0.5F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.mallet_direct = 0.0F;
    patch.exciter.mallet_resonator = 0.8F;
    patch.exciter.mallet_hardness_hz = 670.0F;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.1448F;
    patch.exciter.noise_filter_mode = NoiseFilterMode::BandPass;
    patch.exciter.noise_filter_frequency_hz = 1315.0F;
    patch.exciter.noise_filter_q = 2.017F;
    patch.exciter.noise_attack_ms = 12.0F;
    patch.exciter.noise_decay_ms = 1356.0F;
    patch.exciter.noise_release_ms = 1227.0F;
    patch.release_mode = ReleaseMode::OneShot;
    patch.resonator_gain_db = 10.32F;
    patch.output_gain_db = -2.5F;
    return patch;
}

bool near(float a, float b, float tolerance = 1.0e-5F) {
    return std::abs(a - b) <= tolerance;
}

double dense_full_balanced_audio_max_abs_error() {
    using namespace brk::modal;
    constexpr std::uint32_t sample_rate = 48000U;
    constexpr std::uint32_t block_size = 128U;
    constexpr std::uint32_t render_frames = sample_rate * 2U;
    constexpr std::uint64_t seed = 0x5034374400000002ULL;

    const Patch source = make_dense_audio_parity_crash();
    const Patch full = apply_auto_quality_profile(source, QualityProfile::Full);
    const Patch balanced = apply_auto_quality_profile(source, QualityProfile::Balanced);

    Engine full_engine;
    Engine balanced_engine;
    if (!full_engine.prepare(sample_rate, block_size, seed)
        || !balanced_engine.prepare(sample_rate, block_size, seed)) {
        return 1.0;
    }
    full_engine.set_patch(full);
    balanced_engine.set_patch(balanced);
    full_engine.note_on({1U, 52, 0.82F, 0.0F});
    balanced_engine.note_on({1U, 52, 0.82F, 0.0F});

    std::array<float, block_size> full_left{};
    std::array<float, block_size> full_right{};
    std::array<float, block_size> balanced_left{};
    std::array<float, block_size> balanced_right{};
    double max_abs_error = 0.0;

    for (std::uint32_t offset = 0U; offset < render_frames; offset += block_size) {
        full_engine.process(full_left.data(), full_right.data(), block_size);
        balanced_engine.process(balanced_left.data(), balanced_right.data(), block_size);
        for (std::uint32_t index = 0U; index < block_size; ++index) {
            const double full_sample = 0.5 * static_cast<double>(full_left[index] + full_right[index]);
            const double balanced_sample = 0.5 * static_cast<double>(balanced_left[index] + balanced_right[index]);
            if (!std::isfinite(full_sample) || !std::isfinite(balanced_sample)) return 1.0;
            const double error = std::abs(balanced_sample - full_sample);
            if (error > max_abs_error) max_abs_error = error;
        }
    }
    return max_abs_error;
}

} // namespace

int main() {
    using namespace brk::modal;

    const Patch crash = make_dense_crash_like();
    const Patch bell = make_serial_bell_like();
    const Patch gong = make_gong_like();
    const Patch bar = make_tolerant_bar();

    const PatchStructureMetrics crash_metrics = analyze_patch_structure(crash);
    const PatchStructureMetrics bell_metrics = analyze_patch_structure(bell);
    const PatchStructureMetrics gong_metrics = analyze_patch_structure(gong);
    const PatchStructureMetrics bar_metrics = analyze_patch_structure(bar);

    if (crash_metrics.spectrum_class != PatchSpectrumClass::Dense) return 1;
    if (!crash_metrics.dense_spectrum_guard) return 2;
    if (crash_metrics.authored_modal_count != 128U) return 3;
    if (bell_metrics.spectrum_class != PatchSpectrumClass::Dense) return 4;
    if (!bell_metrics.dense_spectrum_guard || !bell_metrics.serial_coupling) return 5;
    if (bell_metrics.authored_modal_count != 104U) return 6;
    if (gong_metrics.spectrum_class != PatchSpectrumClass::General) return 7;
    if (gong_metrics.dense_spectrum_guard) return 8;
    if (bar_metrics.spectrum_class != PatchSpectrumClass::Sparse) return 9;

    const Patch crash_balanced = apply_auto_quality_profile(crash, QualityProfile::Balanced);
    const Patch gong_balanced = apply_auto_quality_profile(gong, QualityProfile::Balanced);
    const Patch bar_balanced = apply_auto_quality_profile(bar, QualityProfile::Balanced);
    if (crash_balanced.resonator_a.max_render_partials != 64U
        || crash_balanced.resonator_b.max_render_partials != 64U) return 10;
    if (crash_balanced.polyphony != 12U) return 11;
    if (gong_balanced.resonator_a.max_render_partials != 32U) return 12;
    if (bar_balanced.resonator_a.max_render_partials != 24U) return 13;

    const Patch crash_economy = apply_auto_quality_profile(crash, QualityProfile::Economy);
    const Patch bell_economy = apply_auto_quality_profile(bell, QualityProfile::Economy);
    const Patch gong_economy = apply_auto_quality_profile(gong, QualityProfile::Economy);
    const Patch bar_economy = apply_auto_quality_profile(bar, QualityProfile::Economy);
    if (crash_economy.resonator_a.max_render_partials != 24U
        || crash_economy.resonator_b.max_render_partials != 24U) return 14;
    if (crash_economy.polyphony != 8U) return 15;
    if (bell_economy.resonator_a.max_render_partials != 32U
        || bell_economy.resonator_b.max_render_partials != 32U) return 16;
    if (bell_economy.polyphony != 8U) return 17;
    if (gong_economy.resonator_a.max_render_partials != 20U) return 18;
    if (bar_economy.resonator_a.max_render_partials != 16U) return 19;

    const QualityApplicationReport crash_report =
        describe_auto_quality_application(crash, QualityProfile::Balanced);
    const QualityApplicationReport gong_report =
        describe_auto_quality_application(gong, QualityProfile::Balanced);
    const QualityApplicationReport bar_report =
        describe_auto_quality_application(bar, QualityProfile::Balanced);
    if (!crash_report.dense_spectrum_guard || crash_report.spectral_reduction) return 20;
    if (!crash_report.polyphony_reduction) return 21;
    if (!near(crash_report.modal_retention_ratio, 1.0F)) return 22;
    if (!near(crash_report.estimated_work_ratio, 0.75F)) return 23;
    if (!gong_report.spectral_reduction || !near(gong_report.modal_retention_ratio, 0.5F)) return 24;
    if (!bar_report.spectral_reduction || !near(bar_report.modal_retention_ratio, 0.5F)) return 25;

    const QualityApplicationReport crash_economy_report =
        describe_auto_quality_application(crash, QualityProfile::Economy);
    const QualityApplicationReport bell_economy_report =
        describe_auto_quality_application(bell, QualityProfile::Economy);
    const QualityApplicationReport gong_economy_report =
        describe_auto_quality_application(gong, QualityProfile::Economy);
    const QualityApplicationReport bar_economy_report =
        describe_auto_quality_application(bar, QualityProfile::Economy);
    if (!crash_economy_report.dense_spectrum_guard) return 26;
    if (!bell_economy_report.dense_spectrum_guard) return 27;
    if (!near(crash_economy_report.modal_retention_ratio, 0.375F)) return 28;
    if (!near(crash_economy_report.estimated_work_ratio, 0.1875F)) return 29;
    if (!near(bell_economy_report.modal_retention_ratio, 64.0F / 104.0F)) return 30;
    if (!near(bell_economy_report.estimated_work_ratio, 512.0F / 1248.0F)) return 31;
    if (!near(gong_economy_report.modal_retention_ratio, 20.0F / 64.0F)) return 32;
    if (!near(bar_economy_report.modal_retention_ratio, 16.0F / 48.0F)) return 33;

    AutoQualityConfig config{};
    config.smoothing = 1.0F;
    config.degrade_after_blocks = 4U;
    config.recover_after_blocks = 8U;
    config.minimum_dwell_blocks = 6U;
    AutoQualityController controller(config);

    for (std::uint32_t index = 0; index < 3U; ++index) {
        if (controller.observe_deadline_headroom(0.05F).changed) return 34;
    }
    const AutoQualityDecision degrade = controller.observe_deadline_headroom(0.05F);
    if (!degrade.changed || degrade.profile != QualityProfile::Balanced) return 35;

    for (std::uint32_t index = 0; index < 7U; ++index) {
        if (controller.observe_deadline_headroom(0.60F).changed) return 36;
    }
    const AutoQualityDecision recover = controller.observe_deadline_headroom(0.60F);
    if (!recover.changed || recover.profile != QualityProfile::Full) return 37;

    controller.reset();
    for (std::uint32_t index = 0; index < 400U; ++index) {
        const float headroom = (index & 1U) == 0U ? 0.20F : 0.30F;
        if (controller.observe_deadline_headroom(headroom).changed) return 38;
    }
    if (controller.state().transitions != 0U) return 39;

    AutoQualityConfig deep_config = config;
    deep_config.minimum_profile = QualityProfile::Economy;
    AutoQualityController deep_controller(deep_config);
    for (std::uint32_t index = 0; index < 4U; ++index) {
        deep_controller.observe_deadline_headroom(0.0F);
    }
    if (deep_controller.current_profile() != QualityProfile::Balanced) return 40;
    for (std::uint32_t index = 0; index < 6U; ++index) {
        deep_controller.observe_deadline_headroom(0.0F);
    }
    for (std::uint32_t index = 0; index < 4U; ++index) {
        deep_controller.observe_deadline_headroom(0.0F);
    }
    if (deep_controller.current_profile() != QualityProfile::Economy) return 41;

    const double crash_audio_max_abs_error = dense_full_balanced_audio_max_abs_error();
    if (crash_audio_max_abs_error > 1.0e-7) return 42;

    std::cout << "dense_guard=ok\n";
    std::cout << "auto_hysteresis=ok\n";
    std::cout << "crash_balanced_work_ratio=" << crash_report.estimated_work_ratio << '\n';
    std::cout << "crash_economy_work_ratio=" << crash_economy_report.estimated_work_ratio << '\n';
    std::cout << "bell_economy_work_ratio=" << bell_economy_report.estimated_work_ratio << '\n';
    std::cout << "gong_economy_modal_retention=" << gong_economy_report.modal_retention_ratio << '\n';
    std::cout << "bar_economy_modal_retention=" << bar_economy_report.modal_retention_ratio << '\n';
    std::cout << "dense_full_balanced_audio_max_abs_error=" << crash_audio_max_abs_error << '\n';
    return 0;
}

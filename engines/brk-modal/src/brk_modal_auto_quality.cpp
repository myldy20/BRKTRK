#include "brk_modal/auto_quality.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace brk::modal {
namespace {

bool is_tube(Model model) noexcept {
    return model == Model::OpenTube || model == Model::ClosedTube;
}

bool is_dense_family(Model model) noexcept {
    switch (model) {
    case Model::Squared:
    case Model::Membrane:
    case Model::Plate:
    case Model::Drumhead:
    case Model::Bell:
    case Model::Djembe:
        return true;
    case Model::String:
    case Model::Beam:
    case Model::Marimba:
    case Model::OpenTube:
    case Model::ClosedTube:
    case Model::Marimba2:
        return false;
    }
    return false;
}

bool is_tolerant_family(Model model) noexcept {
    switch (model) {
    case Model::String:
    case Model::Beam:
    case Model::Marimba:
    case Model::Marimba2:
        return true;
    default:
        return false;
    }
}

std::uint16_t authored_modal_count(const ResonatorPatch& resonator) noexcept {
    if (!resonator.enabled || is_tube(resonator.model)) return 0U;
    return static_cast<std::uint16_t>(
        std::min<std::size_t>(resonator.partials, kMaxPartials));
}

std::uint16_t retained_modal_count(const ResonatorPatch& resonator) noexcept {
    if (!resonator.enabled || is_tube(resonator.model)) return 0U;
    return static_cast<std::uint16_t>(std::min<std::size_t>(
        resonator.partials,
        resonator.max_render_partials));
}

float clampf(float value, float low, float high) noexcept {
    return std::max(low, std::min(value, high));
}

std::uint8_t profile_rank(QualityProfile profile) noexcept {
    return static_cast<std::uint8_t>(profile);
}

QualityProfile profile_from_rank(std::uint8_t rank) noexcept {
    return static_cast<QualityProfile>(std::min<std::uint8_t>(rank, 3U));
}

AutoQualityConfig sanitize_config(AutoQualityConfig config) noexcept {
    config.degrade_headroom = clampf(config.degrade_headroom, -1.0F, 0.95F);
    config.recover_headroom = clampf(config.recover_headroom, -0.95F, 1.0F);
    if (config.recover_headroom <= config.degrade_headroom) {
        config.recover_headroom = std::min(1.0F, config.degrade_headroom + 0.05F);
    }
    config.smoothing = clampf(config.smoothing, 0.001F, 1.0F);
    config.degrade_after_blocks = std::max<std::uint32_t>(1U, config.degrade_after_blocks);
    config.recover_after_blocks = std::max<std::uint32_t>(1U, config.recover_after_blocks);
    config.minimum_dwell_blocks = std::max<std::uint32_t>(1U, config.minimum_dwell_blocks);

    const std::uint8_t best = std::min(profile_rank(config.maximum_profile), profile_rank(config.minimum_profile));
    const std::uint8_t worst = std::max(profile_rank(config.maximum_profile), profile_rank(config.minimum_profile));
    config.maximum_profile = profile_from_rank(best);
    config.minimum_profile = profile_from_rank(worst);
    return config;
}

QualityProfile clamp_profile_to_config(QualityProfile profile, const AutoQualityConfig& config) noexcept {
    const std::uint8_t rank = std::max(
        profile_rank(config.maximum_profile),
        std::min(profile_rank(profile), profile_rank(config.minimum_profile)));
    return profile_from_rank(rank);
}

} // namespace

const char* patch_spectrum_class_name(PatchSpectrumClass value) noexcept {
    switch (value) {
    case PatchSpectrumClass::Sparse: return "sparse";
    case PatchSpectrumClass::General: return "general";
    case PatchSpectrumClass::Dense: return "dense";
    }
    return "general";
}

PatchStructureMetrics analyze_patch_structure(const Patch& source) noexcept {
    PatchStructureMetrics metrics{};
    metrics.serial_coupling = source.coupling == Coupling::Serial;
    metrics.noise_drive = std::max(
        std::abs(source.exciter.noise_direct),
        std::abs(source.exciter.noise_resonator));

    const ResonatorPatch* resonators[] = {&source.resonator_a, &source.resonator_b};
    bool all_modal_resonators_tolerant = true;
    for (const ResonatorPatch* resonator : resonators) {
        if (!resonator->enabled) continue;
        ++metrics.active_resonators;
        metrics.longest_decay_seconds = std::max(
            metrics.longest_decay_seconds,
            resonator->decay_seconds);

        const std::uint16_t modes = authored_modal_count(*resonator);
        metrics.authored_modal_count = static_cast<std::uint16_t>(
            metrics.authored_modal_count + modes);
        if (modes == 0U) continue;

        const bool dense = is_dense_family(resonator->model) && modes >= 32U;
        if (dense) ++metrics.dense_resonators;
        if (!is_tolerant_family(resonator->model)) all_modal_resonators_tolerant = false;

        metrics.density_score += static_cast<float>(modes) / 32.0F;
        if (dense) metrics.density_score += 1.0F;
        if (resonator->decay_seconds >= 4.0F) metrics.density_score += 0.5F;
        if (std::abs(resonator->inharmonicity) >= 0.01F) metrics.density_score += 0.5F;
        if (resonator->spectral_focus >= 0.60F) metrics.density_score += 0.25F;
    }

    if (metrics.active_resonators >= 2U) metrics.density_score += 0.5F;
    if (metrics.serial_coupling) metrics.density_score += 0.5F;
    if (metrics.noise_drive >= 0.08F) metrics.density_score += 0.75F;

    metrics.dense_spectrum_guard =
        metrics.active_resonators >= 2U
        && metrics.dense_resonators >= 2U
        && metrics.authored_modal_count >= 96U
        && (metrics.noise_drive >= 0.08F
            || metrics.serial_coupling
            || metrics.longest_decay_seconds >= 4.0F);

    if (metrics.dense_spectrum_guard) {
        metrics.spectrum_class = PatchSpectrumClass::Dense;
    } else if (metrics.authored_modal_count <= 24U
               || (all_modal_resonators_tolerant
                   && metrics.authored_modal_count <= 64U)) {
        metrics.spectrum_class = PatchSpectrumClass::Sparse;
    } else {
        metrics.spectrum_class = PatchSpectrumClass::General;
    }
    return metrics;
}

Patch apply_auto_quality_profile(const Patch& source, QualityProfile profile) noexcept {
    Patch result = apply_quality_profile(source, profile);
    if (profile != QualityProfile::Balanced && profile != QualityProfile::Economy) {
        return result;
    }

    const PatchStructureMetrics metrics = analyze_patch_structure(source);
    std::uint8_t modal_cap = quality_profile_spec(profile).modal_cap;
    if (profile == QualityProfile::Balanced) {
        switch (metrics.spectrum_class) {
        case PatchSpectrumClass::Sparse:
            modal_cap = 24U;
            break;
        case PatchSpectrumClass::General:
            modal_cap = 32U;
            break;
        case PatchSpectrumClass::Dense:
            modal_cap = static_cast<std::uint8_t>(kMaxPartials);
            break;
        }
    } else {
        // P8A hardening: Economy remains materially cheaper than Balanced, but
        // its modal budget now follows patch structure rather than blindly
        // forcing every resonator to 16 modes. Dense noise-driven spectra need
        // some extra support, while a two-stage serial pair receives a larger
        // per-stage floor because pruning either stage acts as a spectral
        // bottleneck for the complete chain. Sparse/tolerant models keep the
        // original 16-mode budget.
        switch (metrics.spectrum_class) {
        case PatchSpectrumClass::Sparse:
            modal_cap = 16U;
            break;
        case PatchSpectrumClass::General:
            modal_cap = 20U;
            break;
        case PatchSpectrumClass::Dense:
            modal_cap = 24U;
            break;
        }
        if (metrics.serial_coupling && metrics.active_resonators >= 2U) {
            modal_cap = std::max<std::uint8_t>(modal_cap, 32U);
        }
        if (metrics.noise_drive >= 0.10F && metrics.authored_modal_count >= 96U) {
            modal_cap = std::max<std::uint8_t>(modal_cap, 24U);
        }
    }

    if (result.resonator_a.enabled && !is_tube(result.resonator_a.model)) {
        result.resonator_a.max_render_partials = modal_cap;
    }
    if (result.resonator_b.enabled && !is_tube(result.resonator_b.model)) {
        result.resonator_b.max_render_partials = modal_cap;
    }
    return result;
}

QualityApplicationReport describe_auto_quality_application(
    const Patch& source,
    QualityProfile profile) noexcept {
    const PatchStructureMetrics metrics = analyze_patch_structure(source);
    const Patch applied = apply_auto_quality_profile(source, profile);

    QualityApplicationReport report{};
    report.selected_profile = profile;
    report.spectrum_class = metrics.spectrum_class;
    report.source_work_units = estimated_modal_work_units(source);
    report.applied_work_units = estimated_modal_work_units(applied);
    report.authored_modal_count = metrics.authored_modal_count;
    report.retained_modal_count = static_cast<std::uint16_t>(
        retained_modal_count(applied.resonator_a)
        + retained_modal_count(applied.resonator_b));
    report.estimated_work_ratio = report.source_work_units == 0U
        ? 1.0F
        : static_cast<float>(report.applied_work_units)
            / static_cast<float>(report.source_work_units);
    report.modal_retention_ratio = report.authored_modal_count == 0U
        ? 1.0F
        : static_cast<float>(report.retained_modal_count)
            / static_cast<float>(report.authored_modal_count);
    report.dense_spectrum_guard =
        (profile == QualityProfile::Balanced || profile == QualityProfile::Economy)
        && metrics.dense_spectrum_guard;
    report.spectral_reduction = report.retained_modal_count < report.authored_modal_count;
    report.polyphony_reduction = applied.polyphony < source.polyphony;
    return report;
}

AutoQualityController::AutoQualityController(AutoQualityConfig config) noexcept
    : config_(sanitize_config(config)) {
    reset(config_.maximum_profile);
}

void AutoQualityController::reset(QualityProfile initial_profile) noexcept {
    state_ = {};
    state_.profile = clamp_profile_to_config(initial_profile, config_);
    state_.filtered_headroom = 1.0F;
    state_.blocks_since_transition = config_.minimum_dwell_blocks;
    has_observation_ = false;
}

AutoQualityDecision AutoQualityController::observe_deadline_headroom(float headroom) noexcept {
    if (!std::isfinite(headroom)) headroom = -1.0F;
    headroom = clampf(headroom, -1.0F, 1.0F);

    if (!has_observation_) {
        state_.filtered_headroom = headroom;
        has_observation_ = true;
    } else {
        state_.filtered_headroom += config_.smoothing
            * (headroom - state_.filtered_headroom);
    }

    ++state_.observed_blocks;
    if (state_.blocks_since_transition < std::numeric_limits<std::uint32_t>::max()) {
        ++state_.blocks_since_transition;
    }

    if (state_.filtered_headroom <= config_.degrade_headroom) {
        if (state_.low_headroom_streak < std::numeric_limits<std::uint32_t>::max()) {
            ++state_.low_headroom_streak;
        }
        state_.high_headroom_streak = 0U;
    } else if (state_.filtered_headroom >= config_.recover_headroom) {
        if (state_.high_headroom_streak < std::numeric_limits<std::uint32_t>::max()) {
            ++state_.high_headroom_streak;
        }
        state_.low_headroom_streak = 0U;
    } else {
        state_.low_headroom_streak = 0U;
        state_.high_headroom_streak = 0U;
    }

    bool changed = false;
    const bool dwell_complete = state_.blocks_since_transition >= config_.minimum_dwell_blocks;
    const std::uint8_t current = profile_rank(state_.profile);
    const std::uint8_t best = profile_rank(config_.maximum_profile);
    const std::uint8_t worst = profile_rank(config_.minimum_profile);

    if (dwell_complete
        && state_.low_headroom_streak >= config_.degrade_after_blocks
        && current < worst) {
        state_.profile = profile_from_rank(static_cast<std::uint8_t>(current + 1U));
        ++state_.transitions;
        ++state_.degradations;
        state_.blocks_since_transition = 0U;
        state_.low_headroom_streak = 0U;
        state_.high_headroom_streak = 0U;
        changed = true;
    } else if (dwell_complete
               && state_.high_headroom_streak >= config_.recover_after_blocks
               && current > best) {
        state_.profile = profile_from_rank(static_cast<std::uint8_t>(current - 1U));
        ++state_.transitions;
        ++state_.recoveries;
        state_.blocks_since_transition = 0U;
        state_.low_headroom_streak = 0U;
        state_.high_headroom_streak = 0U;
        changed = true;
    }

    return {state_.profile, state_.filtered_headroom, changed};
}

Patch AutoQualityController::apply(const Patch& source) const noexcept {
    return apply_auto_quality_profile(source, state_.profile);
}

QualityApplicationReport AutoQualityController::describe(const Patch& source) const noexcept {
    return describe_auto_quality_application(source, state_.profile);
}

} // namespace brk::modal
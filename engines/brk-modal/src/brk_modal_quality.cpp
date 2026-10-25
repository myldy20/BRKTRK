#include "brk_modal/brk_modal.hpp"

#include <algorithm>

namespace brk::modal {
namespace {

bool is_tube(Model model) noexcept {
    return model == Model::OpenTube || model == Model::ClosedTube;
}

std::size_t resonator_work_units(const ResonatorPatch& resonator) noexcept {
    if (!resonator.enabled) return 0U;
    if (is_tube(resonator.model)) return 1U;
    return std::max<std::size_t>(
        1U,
        std::min<std::size_t>(resonator.partials, resonator.max_render_partials));
}

} // namespace

QualityProfileSpec quality_profile_spec(QualityProfile profile) noexcept {
    switch (profile) {
    case QualityProfile::Full:
        return {64U, 16U, false};
    case QualityProfile::Balanced:
        return {32U, 12U, false};
    case QualityProfile::Economy:
        return {16U, 8U, false};
    case QualityProfile::Draft:
        return {8U, 6U, true};
    }
    return {64U, 16U, false};
}

const char* quality_profile_name(QualityProfile profile) noexcept {
    switch (profile) {
    case QualityProfile::Full: return "Full";
    case QualityProfile::Balanced: return "Balanced";
    case QualityProfile::Economy: return "Economy";
    case QualityProfile::Draft: return "Draft";
    }
    return "Full";
}

Patch apply_quality_profile(const Patch& source, QualityProfile profile) noexcept {
    Patch result = source;
    const QualityProfileSpec spec = quality_profile_spec(profile);

    result.resonator_a.max_render_partials = spec.modal_cap;
    result.resonator_b.max_render_partials = spec.modal_cap;
    result.polyphony = static_cast<std::uint8_t>(
        std::min<unsigned int>(result.polyphony, spec.polyphony_cap));

    if (spec.force_mono) result.stereo_mode = StereoMode::Mono;

    // Transparent near-zero branch removal saves a complete resonator with no
    // meaningful audible contribution. Serial routing is never simplified.
    if (result.coupling == Coupling::Parallel
        && result.resonator_a.enabled
        && result.resonator_b.enabled) {
        if (result.parallel_mix <= 0.001F) result.resonator_b.enabled = false;
        else if (result.parallel_mix >= 0.999F) result.resonator_a.enabled = false;
    }

    return result;
}

std::size_t estimated_modal_work_units(const Patch& patch) noexcept {
    const std::size_t per_voice = resonator_work_units(patch.resonator_a)
        + resonator_work_units(patch.resonator_b);
    return per_voice * std::max<std::size_t>(1U, patch.polyphony);
}

} // namespace brk::modal

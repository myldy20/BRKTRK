#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>

namespace {

bool render_profile(brk::modal::QualityProfile profile, float& peak) {
    constexpr std::uint32_t sample_rate = 48000U;
    constexpr std::uint32_t block_size = 128U;
    brk::modal::Engine engine;
    if (!engine.prepare(sample_rate, block_size, 0x5155414c495459ULL)) return false;

    const auto source = brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell);
    engine.set_patch(brk::modal::apply_quality_profile(source, profile));
    engine.note_on({1U, 52, 0.82F, 0.0F});

    std::array<float, block_size> left{};
    std::array<float, block_size> right{};
    peak = 0.0F;
    for (std::uint32_t frame = 0; frame < sample_rate / 2U; frame += block_size) {
        engine.process(left.data(), right.data(), block_size);
        for (std::uint32_t index = 0; index < block_size; ++index) {
            if (!std::isfinite(left[index]) || !std::isfinite(right[index])) return false;
            peak = std::max({peak, std::abs(left[index]), std::abs(right[index])});
        }
    }
    return peak > 1.0e-7F && peak <= 1.0F;
}

bool hard_voice_budget_is_enforced() {
    using namespace brk::modal;
    Engine engine;
    if (!engine.prepare(48000.0, 128U, 0x564f494345434150ULL)) return false;

    Patch source = make_factory_patch(FactoryPatch::RitualBell);
    source.polyphony = 16U;
    engine.set_patch(apply_quality_profile(source, QualityProfile::Full));
    for (std::uint32_t note = 1U; note <= 16U; ++note) {
        engine.note_on({note, static_cast<std::int16_t>(35 + note), 0.8F, 0.0F});
    }
    if (engine.active_voice_count() != 16U) return false;

    engine.set_patch(apply_quality_profile(source, QualityProfile::Draft));
    if (engine.active_voice_count() > 6U) return false;
    for (std::uint32_t note = 17U; note <= 32U; ++note) {
        engine.note_on({note, static_cast<std::int16_t>(35 + note), 0.8F, 0.0F});
        if (engine.active_voice_count() > 6U) return false;
    }
    return true;
}

} // namespace

int main() {
    using namespace brk::modal;

    const auto full_spec = quality_profile_spec(QualityProfile::Full);
    const auto balanced_spec = quality_profile_spec(QualityProfile::Balanced);
    const auto economy_spec = quality_profile_spec(QualityProfile::Economy);
    const auto draft_spec = quality_profile_spec(QualityProfile::Draft);
    if (full_spec.modal_cap != 64U || full_spec.polyphony_cap != 16U || full_spec.force_mono) return 1;
    if (balanced_spec.modal_cap != 32U || balanced_spec.polyphony_cap != 12U || balanced_spec.force_mono) return 2;
    if (economy_spec.modal_cap != 16U || economy_spec.polyphony_cap != 8U || economy_spec.force_mono) return 3;
    if (draft_spec.modal_cap != 8U || draft_spec.polyphony_cap != 6U || !draft_spec.force_mono) return 4;

    Patch source{};
    source.resonator_a.partials = 64U;
    source.resonator_b.enabled = true;
    source.resonator_b.partials = 64U;
    source.polyphony = 16U;
    source.stereo_mode = StereoMode::Comb;

    const Patch full = apply_quality_profile(source, QualityProfile::Full);
    const Patch balanced = apply_quality_profile(source, QualityProfile::Balanced);
    const Patch economy = apply_quality_profile(source, QualityProfile::Economy);
    const Patch draft = apply_quality_profile(source, QualityProfile::Draft);

    if (full.resonator_a.partials != 64U || balanced.resonator_a.partials != 64U) return 5;
    if (balanced.resonator_a.max_render_partials != 32U || balanced.polyphony != 12U) return 6;
    if (economy.resonator_a.max_render_partials != 16U || economy.polyphony != 8U) return 7;
    if (draft.resonator_a.max_render_partials != 8U || draft.polyphony != 6U) return 8;
    if (draft.stereo_mode != StereoMode::Mono || source.stereo_mode != StereoMode::Comb) return 9;

    const std::size_t full_work = estimated_modal_work_units(full);
    const std::size_t balanced_work = estimated_modal_work_units(balanced);
    const std::size_t economy_work = estimated_modal_work_units(economy);
    const std::size_t draft_work = estimated_modal_work_units(draft);
    if (!(full_work == 2048U && balanced_work == 768U && economy_work == 256U && draft_work == 96U)) return 10;
    if (!(full_work > balanced_work && balanced_work > economy_work && economy_work > draft_work)) return 11;

    std::array<float, 4> peaks{};
    for (std::size_t index = 0; index < peaks.size(); ++index) {
        if (!render_profile(static_cast<QualityProfile>(index), peaks[index])) return 12;
    }
    if (!hard_voice_budget_is_enforced()) return 13;

    std::cout << "quality_work_units="
              << full_work << ',' << balanced_work << ',' << economy_work << ',' << draft_work << '\n';
    std::cout << "quality_peaks="
              << peaks[0] << ',' << peaks[1] << ',' << peaks[2] << ',' << peaks[3] << '\n';
    std::cout << "hard_voice_budget=ok\n";
    return 0;
}

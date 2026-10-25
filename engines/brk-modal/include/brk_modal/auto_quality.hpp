#pragma once

#include "brk_modal/brk_modal.hpp"

#include <cstddef>
#include <cstdint>

namespace brk::modal {

enum class PatchSpectrumClass : std::uint8_t {
    Sparse = 0,
    General,
    Dense,
};

struct PatchStructureMetrics {
    std::uint16_t authored_modal_count = 0;
    std::uint8_t active_resonators = 0;
    std::uint8_t dense_resonators = 0;
    float density_score = 0.0F;
    float noise_drive = 0.0F;
    float longest_decay_seconds = 0.0F;
    PatchSpectrumClass spectrum_class = PatchSpectrumClass::Sparse;
    bool serial_coupling = false;
    bool dense_spectrum_guard = false;
};

struct QualityApplicationReport {
    QualityProfile selected_profile = QualityProfile::Full;
    PatchSpectrumClass spectrum_class = PatchSpectrumClass::Sparse;
    std::size_t source_work_units = 0;
    std::size_t applied_work_units = 0;
    std::uint16_t authored_modal_count = 0;
    std::uint16_t retained_modal_count = 0;
    float estimated_work_ratio = 1.0F;
    float modal_retention_ratio = 1.0F;
    bool dense_spectrum_guard = false;
    bool spectral_reduction = false;
    bool polyphony_reduction = false;
};

const char* patch_spectrum_class_name(PatchSpectrumClass value) noexcept;
PatchStructureMetrics analyze_patch_structure(const Patch& source) noexcept;
Patch apply_auto_quality_profile(const Patch& source, QualityProfile profile) noexcept;
QualityApplicationReport describe_auto_quality_application(
    const Patch& source,
    QualityProfile profile) noexcept;

struct AutoQualityConfig {
    float degrade_headroom = 0.15F;
    float recover_headroom = 0.35F;
    float smoothing = 0.125F;
    std::uint32_t degrade_after_blocks = 16U;
    std::uint32_t recover_after_blocks = 128U;
    std::uint32_t minimum_dwell_blocks = 64U;
    QualityProfile maximum_profile = QualityProfile::Full;
    QualityProfile minimum_profile = QualityProfile::Balanced;
};

struct AutoQualityState {
    QualityProfile profile = QualityProfile::Full;
    float filtered_headroom = 1.0F;
    std::uint64_t observed_blocks = 0U;
    std::uint64_t transitions = 0U;
    std::uint64_t degradations = 0U;
    std::uint64_t recoveries = 0U;
    std::uint32_t low_headroom_streak = 0U;
    std::uint32_t high_headroom_streak = 0U;
    std::uint32_t blocks_since_transition = 0U;
};

struct AutoQualityDecision {
    QualityProfile profile = QualityProfile::Full;
    float filtered_headroom = 1.0F;
    bool changed = false;
};

class AutoQualityController {
public:
    explicit AutoQualityController(AutoQualityConfig config = {}) noexcept;

    void reset(QualityProfile initial_profile = QualityProfile::Full) noexcept;
    AutoQualityDecision observe_deadline_headroom(float headroom) noexcept;

    [[nodiscard]] const AutoQualityConfig& config() const noexcept { return config_; }
    [[nodiscard]] const AutoQualityState& state() const noexcept { return state_; }
    [[nodiscard]] QualityProfile current_profile() const noexcept { return state_.profile; }

    [[nodiscard]] Patch apply(const Patch& source) const noexcept;
    [[nodiscard]] QualityApplicationReport describe(const Patch& source) const noexcept;

private:
    AutoQualityConfig config_{};
    AutoQualityState state_{};
    bool has_observation_ = false;
};

} // namespace brk::modal

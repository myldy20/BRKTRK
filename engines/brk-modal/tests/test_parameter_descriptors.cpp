#include "brk_modal/parameter_descriptors.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>

namespace {

bool close_enough(float a, float b, float tolerance = 1.0e-5F) {
    const float scale = std::max(1.0F, std::max(std::abs(a), std::abs(b)));
    return std::abs(a - b) <= tolerance * scale;
}

bool descriptor_strings_valid(const brk::modal::ParameterDescriptor& descriptor) {
    return descriptor.key != nullptr && descriptor.key[0] != '\0'
        && descriptor.display_name != nullptr && descriptor.display_name[0] != '\0'
        && descriptor.unit != nullptr
        && descriptor.group_key != nullptr && descriptor.group_key[0] != '\0';
}

bool automation_contract() {
    using namespace brk::modal;
    constexpr std::array<ParameterId, 9> sample_accurate{{
        ParameterId::ADecaySeconds,
        ParameterId::AMaterial,
        ParameterId::ATone,
        ParameterId::BDecaySeconds,
        ParameterId::BMaterial,
        ParameterId::BTone,
        ParameterId::StereoWidth,
        ParameterId::ResonatorGainDb,
        ParameterId::OutputGainDb,
    }};
    for (const auto id : sample_accurate) {
        const auto* descriptor = parameter_descriptor(id);
        if (descriptor == nullptr || !parameter_supports_sample_accurate_events(*descriptor)
            || !parameter_supports_block_value(*descriptor)) return false;
    }

    constexpr std::array<ParameterId, 4> block_only{{
        ParameterId::AHitPosition,
        ParameterId::BInharmonicity,
        ParameterId::MalletHardnessHz,
        ParameterId::NoiseFilterFrequencyHz,
    }};
    for (const auto id : block_only) {
        const auto* descriptor = parameter_descriptor(id);
        if (descriptor == nullptr || !parameter_supports_block_value(*descriptor)
            || parameter_supports_sample_accurate_events(*descriptor)
            || (descriptor->flags & ParameterAutomatable) == 0U) return false;
    }

    const auto* structural = parameter_descriptor(ParameterId::APartials);
    return structural != nullptr
        && parameter_supports_block_value(*structural)
        && !parameter_supports_sample_accurate_events(*structural)
        && (structural->flags & ParameterRequiresReconfigure) != 0U;
}

} // namespace

int main() {
    using namespace brk::modal;

    static_assert(kParameterDescriptorCount == 89U);
    if (kParameterDescriptorCount != kParameterCount) return 1;

    Patch defaults{};
    for (std::size_t i = 0; i < kParameterDescriptorCount; ++i) {
        const auto* descriptor = parameter_descriptor_at(i);
        if (descriptor == nullptr || !descriptor_strings_valid(*descriptor)) return 2;
        if (descriptor->id != kParameterIdentities[i].id) return 3;
        if (std::strcmp(descriptor->key, kParameterIdentities[i].key) != 0) return 4;
        if (!(descriptor->plain_max > descriptor->plain_min)) return 5;
        if (!(descriptor->skew > 0.0F)) return 6;
        if (parameter_descriptor(descriptor->id) != descriptor) return 7;

        float default_plain = 0.0F;
        if (!get_parameter_plain(defaults, descriptor->id, default_plain)) return 8;
        if (!close_enough(default_plain, descriptor->plain_default)) {
            std::cerr << "default mismatch: " << descriptor->key << " patch=" << default_plain
                      << " descriptor=" << descriptor->plain_default << '\n';
            return 9;
        }

        const float default_normalized = parameter_default_normalized(*descriptor);
        if (!(default_normalized >= 0.0F && default_normalized <= 1.0F)) return 10;

        constexpr std::array<float, 7> probes = {-0.5F, 0.0F, 0.125F, 0.5F, 0.875F, 1.0F, 1.5F};
        for (float probe : probes) {
            Patch patch = defaults;
            const float expected_plain = parameter_plain_from_normalized(*descriptor, probe);
            if (!set_parameter_normalized(patch, descriptor->id, probe)) return 11;
            float actual_plain = 0.0F;
            if (!get_parameter_plain(patch, descriptor->id, actual_plain)) return 12;
            if (!close_enough(actual_plain, expected_plain)) {
                std::cerr << "plain mismatch: " << descriptor->key << " expected=" << expected_plain
                          << " actual=" << actual_plain << '\n';
                return 13;
            }
            float actual_normalized = -1.0F;
            if (!get_parameter_normalized(patch, descriptor->id, actual_normalized)) return 14;
            const float expected_normalized = parameter_normalized_from_plain(*descriptor, expected_plain);
            if (!close_enough(actual_normalized, expected_normalized, 3.0e-5F)) return 15;
        }
    }

    const auto* stiffness = parameter_descriptor(ParameterId::MalletHardnessHz);
    const auto* decay = parameter_descriptor(ParameterId::ADecaySeconds);
    const auto* split = parameter_descriptor(ParameterId::CouplingSplit);
    if (stiffness == nullptr || decay == nullptr || split == nullptr) return 16;
    const float expected_stiffness = 100.0F + 4900.0F * std::pow(0.5F, 1.0F / 0.3F);
    if (!close_enough(parameter_plain_from_normalized(*stiffness, 0.5F), std::round(expected_stiffness), 2.0e-4F)) return 17;
    const float expected_decay = 0.01F + 99.99F * std::pow(0.5F, 1.0F / 0.2F);
    const float snapped_decay = 0.01F + 0.01F * std::floor((expected_decay - 0.01F) / 0.01F + 0.5F);
    if (!close_enough(parameter_plain_from_normalized(*decay, 0.5F), snapped_decay, 2.0e-4F)) return 18;
    const float expected_split = 0.01F + 0.99F * std::pow(0.5F, 1.0F / 0.5F);
    const float snapped_split = 0.01F + 0.001F * std::floor((expected_split - 0.01F) / 0.001F + 0.5F);
    if (!close_enough(parameter_plain_from_normalized(*split, 0.5F), snapped_split, 2.0e-4F)) return 19;

    const auto* partials = parameter_descriptor(ParameterId::APartials);
    if (partials == nullptr || partials->enum_value_count != 7U) return 20;
    constexpr std::array<float, 7> expected_partials = {4, 8, 16, 32, 64, 1, 2};
    for (std::size_t i = 0; i < expected_partials.size(); ++i) {
        const float normalized = static_cast<float>(i) / static_cast<float>(expected_partials.size() - 1U);
        if (!close_enough(parameter_plain_from_normalized(*partials, normalized), expected_partials[i])) return 21;
        if (!close_enough(parameter_normalized_from_plain(*partials, expected_partials[i]), normalized)) return 22;
    }

    Patch unchanged{};
    const Patch snapshot = unchanged;
    const auto unknown = static_cast<ParameterId>(0xdeadbeefU);
    float value = 0.0F;
    if (parameter_descriptor(unknown) != nullptr) return 23;
    if (get_parameter_plain(unchanged, unknown, value)) return 24;
    if (set_parameter_plain(unchanged, unknown, 0.5F)) return 25;
    if (set_parameter_normalized(unchanged, ParameterId::ADecaySeconds,
                                 std::numeric_limits<float>::quiet_NaN())) return 26;
    float before = 0.0F;
    float after = 0.0F;
    if (!get_parameter_plain(snapshot, ParameterId::ADecaySeconds, before)
        || !get_parameter_plain(unchanged, ParameterId::ADecaySeconds, after)
        || !close_enough(before, after)) return 27;

    if (!automation_contract()) return 28;

    std::cout << "parameter_descriptors=" << kParameterDescriptorCount << '\n';
    std::cout << "juce_skew_roundtrips=3\n";
    std::cout << "patch_roundtrip_probes=" << kParameterDescriptorCount * 7U << '\n';
    std::cout << "sample_accurate_parameter_count=9\n";
    std::cout << "modal_automation_descriptor_contract=PASS\n";
    return 0;
}
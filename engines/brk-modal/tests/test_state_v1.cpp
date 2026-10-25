#include "brk_modal/state_v1.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>

namespace {

using StateBytes = std::array<std::uint8_t, brk::modal::kStateV1Size>;

bool close_enough(float a, float b) {
    return std::abs(a - b) <= 4.0e-5F * std::max(1.0F, std::max(std::abs(a), std::abs(b)));
}

bool patches_equal(const brk::modal::Patch& a, const brk::modal::Patch& b) {
    for (std::size_t i = 0; i < brk::modal::kParameterDescriptorCount; ++i) {
        const auto* descriptor = brk::modal::parameter_descriptor_at(i);
        if (descriptor == nullptr) return false;
        float av = 0.0F;
        float bv = 0.0F;
        if (!brk::modal::get_parameter_normalized(a, descriptor->id, av)
            || !brk::modal::get_parameter_normalized(b, descriptor->id, bv)
            || !close_enough(av, bv)) return false;
    }
    return true;
}

bool roundtrip(const brk::modal::Patch& source) {
    StateBytes first{};
    StateBytes second{};
    if (!brk::modal::write_state_v1(source, first.data(), first.size())) return false;
    if (!brk::modal::write_state_v1(source, second.data(), second.size())) return false;
    if (first != second) return false;

    brk::modal::Patch restored{};
    if (brk::modal::read_state_v1(restored, first.data(), first.size())
        != brk::modal::StateReadResult::Ok) return false;
    return patches_equal(source, restored);
}

} // namespace

int main() {
    using namespace brk::modal;

    static_assert(kStateHeaderSize == 56U);
    static_assert(kStateParameterRecordSize == 8U);
    static_assert(kStateV1Size == 768U);
    static_assert(kStateEngineIdHash == fnv1a32("brk-modal"));

    if (!roundtrip(Patch{})) return 1;
    for (std::uint32_t i = 0; i < 6U; ++i) {
        if (!roundtrip(make_factory_patch(static_cast<FactoryPatch>(i)))) return 2;
    }

    Patch exhaustive{};
    for (std::size_t i = 0; i < kParameterDescriptorCount; ++i) {
        const auto* descriptor = parameter_descriptor_at(i);
        if (descriptor == nullptr) return 3;
        const float normalized = static_cast<float>((i * 37U + 11U) % 101U) / 100.0F;
        if (!set_parameter_normalized(exhaustive, descriptor->id, normalized)) return 4;
    }
    if (!roundtrip(exhaustive)) return 5;

    StateBytes valid{};
    if (!write_state_v1(exhaustive, valid.data(), valid.size())) return 6;
    if (state_detail::read_u32(valid.data()) != kStateMagic) return 7;
    if (state_detail::read_u16(valid.data() + 4U) != kStateSchemaMajor) return 8;
    if (state_detail::read_u32(valid.data() + 12U) != kStateV1Size) return 9;
    if (state_detail::read_u32(valid.data() + 16U) != kStateEngineIdHash) return 10;
    if (state_detail::read_u32(valid.data() + 20U) != kParameterDescriptorCount) return 11;

    Patch target = make_factory_patch(FactoryPatch::RitualBell);
    const Patch target_before = target;
    StateBytes broken = valid;
    broken[0] ^= 0x01U;
    if (read_state_v1(target, broken.data(), broken.size()) != StateReadResult::BadMagic
        || !patches_equal(target, target_before)) return 12;

    broken = valid;
    broken[4] = 2U;
    if (read_state_v1(target, broken.data(), broken.size()) != StateReadResult::BadSchema
        || !patches_equal(target, target_before)) return 13;

    broken = valid;
    broken[16] ^= 0x80U;
    if (read_state_v1(target, broken.data(), broken.size()) != StateReadResult::BadEngine
        || !patches_equal(target, target_before)) return 14;

    broken = valid;
    broken[kStateHeaderSize + 7U] ^= 0x01U;
    if (read_state_v1(target, broken.data(), broken.size()) != StateReadResult::BadCrc
        || !patches_equal(target, target_before)) return 15;

    broken = valid;
    state_detail::write_u32(broken.data() + kStateHeaderSize, 0xdeadbeefU);
    state_detail::write_u32(
        broken.data() + 24U,
        state_detail::crc32(broken.data() + kStateHeaderSize, kStateV1Size - kStateHeaderSize));
    if (read_state_v1(target, broken.data(), broken.size()) != StateReadResult::NonCanonical
        || !patches_equal(target, target_before)) return 16;

    broken = valid;
    state_detail::write_u32(broken.data() + kStateHeaderSize + 4U, 0x7fc00000U);
    state_detail::write_u32(
        broken.data() + 24U,
        state_detail::crc32(broken.data() + kStateHeaderSize, kStateV1Size - kStateHeaderSize));
    if (read_state_v1(target, broken.data(), broken.size()) != StateReadResult::BadParameter
        || !patches_equal(target, target_before)) return 17;

    if (read_state_v1(target, valid.data(), valid.size() - 1U) != StateReadResult::BadSize
        || !patches_equal(target, target_before)) return 18;
    if (write_state_v1(exhaustive, valid.data(), valid.size() - 1U)) return 19;
    if (read_state_v1(target, nullptr, valid.size()) != StateReadResult::InvalidArgument) return 20;

    std::cout << "state_v1_bytes=" << kStateV1Size << '\n';
    std::cout << "state_records=" << kParameterDescriptorCount << '\n';
    std::cout << "engine_hash=0x" << std::hex << kStateEngineIdHash << std::dec << '\n';
    std::cout << "atomic_rejection_cases=7\n";
    return 0;
}

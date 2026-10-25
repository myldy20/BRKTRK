#include "brk_modal/ripplerx_programs.hpp"
#include "brk_modal/state_v1.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>

#ifndef BRK_MODAL_PROGRAM_BANK_INCLUDE
#error "BRK_MODAL_PROGRAM_BANK_INCLUDE must name the generated .inc file"
#endif

namespace brk::modal {
#include BRK_MODAL_PROGRAM_BANK_INCLUDE
} // namespace brk::modal

namespace {

bool patches_equal(const brk::modal::Patch& a, const brk::modal::Patch& b) {
    for (std::size_t i = 0; i < brk::modal::kParameterDescriptorCount; ++i) {
        const auto* descriptor = brk::modal::parameter_descriptor_at(i);
        if (descriptor == nullptr) return false;
        float av = 0.0F;
        float bv = 0.0F;
        if (!brk::modal::get_parameter_normalized(a, descriptor->id, av)
            || !brk::modal::get_parameter_normalized(b, descriptor->id, bv)
            || std::abs(av - bv) > 4.0e-5F) return false;
    }
    return true;
}

} // namespace

int main() {
    std::array<std::uint8_t, brk::modal::kStateV1Size> state{};
    for (std::size_t i = 0; i < brk::modal::kRipplerXProgramCount; ++i) {
        const auto program = static_cast<brk::modal::RipplerXProgram>(i);
        const auto source = brk::modal::make_ripplerx_program(program);
        if (!brk::modal::write_state_v1(source, state.data(), state.size())) return 1;
        brk::modal::Patch restored{};
        if (brk::modal::read_state_v1(restored, state.data(), state.size())
            != brk::modal::StateReadResult::Ok) return 2;
        if (!patches_equal(source, restored)) {
            std::cerr << "state mismatch: " << brk::modal::ripplerx_program_name(program) << '\n';
            return 3;
        }
    }
    std::cout << "ripplerx_state_roundtrips=" << brk::modal::kRipplerXProgramCount << '\n';
    std::cout << "state_bytes=" << brk::modal::kStateV1Size << '\n';
    return 0;
}

#include "brk_modal/state_v1.hpp"

#include <array>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
    if (argc != 2) return 1;
    std::array<std::uint8_t, brk::modal::kStateV1Size> state{};
    const auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::GlassString);
    if (!brk::modal::write_state_v1(patch, state.data(), state.size())) return 2;
    std::ofstream output(argv[1], std::ios::binary);
    if (!output) return 3;
    output.write(reinterpret_cast<const char*>(state.data()), state.size());
    if (!output) return 4;
    std::cout << "p4_state_bytes=" << state.size() << '\n';
    return 0;
}

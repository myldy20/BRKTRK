#include "brk_modal/parameter_descriptors.hpp"

#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>

namespace {

void write_patch(std::ostream& output, const char* name, const brk::modal::Patch& patch, bool comma) {
    output << "    {\n      \"name\": \"" << name << "\",\n      \"parameters\": [\n";
    for (std::size_t i = 0; i < brk::modal::kParameterDescriptorCount; ++i) {
        const auto* descriptor = brk::modal::parameter_descriptor_at(i);
        float plain = 0.0F;
        float normalized = 0.0F;
        if (descriptor == nullptr
            || !brk::modal::get_parameter_plain(patch, descriptor->id, plain)
            || !brk::modal::get_parameter_normalized(patch, descriptor->id, normalized)) return;
        output << "        {\"id\": " << static_cast<std::uint32_t>(descriptor->id)
               << ", \"key\": \"" << descriptor->key
               << "\", \"plain\": " << plain
               << ", \"normalized\": " << normalized << "}";
        output << (i + 1U == brk::modal::kParameterDescriptorCount ? "\n" : ",\n");
    }
    output << "      ]\n    }" << (comma ? ",\n" : "\n");
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2) return 1;
    std::ofstream output(argv[1]);
    if (!output) return 2;
    output << std::setprecision(9);
    output << "{\n  \"schema\": \"brk-modal-readable-parameter-snapshot-v1\",\n"
              "  \"engineId\": \"brk-modal\",\n"
              "  \"parameterCount\": " << brk::modal::kParameterDescriptorCount << ",\n"
              "  \"patches\": [\n";
    for (std::uint32_t i = 0; i < 6U; ++i) {
        const auto preset = static_cast<brk::modal::FactoryPatch>(i);
        write_patch(output, brk::modal::factory_patch_name(preset), brk::modal::make_factory_patch(preset), i != 5U);
    }
    output << "  ]\n}\n";
    if (!output.good()) return 3;
    std::cout << "snapshot_patches=6\n";
    std::cout << "snapshot_parameters=" << brk::modal::kParameterDescriptorCount << '\n';
    return 0;
}

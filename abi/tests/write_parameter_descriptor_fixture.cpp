#include "brk_synth_abi.h"
#include "brk_modal/parameter_descriptors.hpp"

#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr std::uint32_t kMagic = 0x444b5242U; // "BRKD" little-endian.
constexpr std::uint32_t kHeaderSize = 16U;

struct FixtureHeader {
    std::uint32_t magic;
    std::uint32_t descriptor_count;
    std::uint32_t descriptor_size;
    std::uint32_t string_pool_offset;
};

static_assert(sizeof(FixtureHeader) == kHeaderSize);
static_assert(sizeof(brk_parameter_descriptor_v1) == 96U);

brk_string_ref append_string(std::vector<std::uint8_t>& pool, std::uint32_t pool_offset, const char* text) {
    const char* safe = text == nullptr ? "" : text;
    const auto length = static_cast<std::uint32_t>(std::strlen(safe));
    const auto offset = pool_offset + static_cast<std::uint32_t>(pool.size());
    pool.insert(pool.end(), safe, safe + length);
    return {offset, length};
}

bool little_endian_host() {
    const std::uint16_t value = 1U;
    return *reinterpret_cast<const std::uint8_t*>(&value) == 1U;
}

} // namespace

int main(int argc, char** argv) {
    using namespace brk::modal;
    if (argc != 2 || !little_endian_host()) return 1;

    const auto count = static_cast<std::uint32_t>(kParameterDescriptorCount);
    const auto pool_offset = kHeaderSize + count * static_cast<std::uint32_t>(sizeof(brk_parameter_descriptor_v1));
    std::vector<brk_parameter_descriptor_v1> records(count);
    std::vector<std::uint8_t> strings;

    for (std::uint32_t i = 0; i < count; ++i) {
        const auto* source = parameter_descriptor_at(i);
        if (source == nullptr) return 2;
        auto& record = records[i];
        record.struct_size = sizeof(record);
        record.parameter_id = static_cast<std::uint32_t>(source->id);
        record.parameter_type = static_cast<std::uint32_t>(source->type);
        record.flags = source->flags;
        record.key = append_string(strings, pool_offset, source->key);
        record.display_name = append_string(strings, pool_offset, source->display_name);
        record.unit = append_string(strings, pool_offset, source->unit);
        record.group_key = append_string(strings, pool_offset, source->group_key);
        record.normalized_default = parameter_default_normalized(*source);
        record.plain_min = source->plain_min;
        record.plain_max = source->plain_max;
        record.plain_step = source->plain_step;
        record.enum_value_count = source->enum_value_count;
    }

    const FixtureHeader header{kMagic, count, sizeof(brk_parameter_descriptor_v1), pool_offset};
    std::ofstream output(argv[1], std::ios::binary);
    if (!output) return 3;
    output.write(reinterpret_cast<const char*>(&header), sizeof(header));
    output.write(reinterpret_cast<const char*>(records.data()),
                 static_cast<std::streamsize>(records.size() * sizeof(records[0])));
    output.write(reinterpret_cast<const char*>(strings.data()), static_cast<std::streamsize>(strings.size()));
    if (!output.good()) return 4;

    std::cout << "descriptor_count=" << count << '\n';
    std::cout << "descriptor_size=" << sizeof(brk_parameter_descriptor_v1) << '\n';
    std::cout << "string_pool_bytes=" << strings.size() << '\n';
    return 0;
}

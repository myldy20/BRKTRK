#include "brk_synth_abi.h"
#include "brk_synth_asset_ext.h"

#include <cstddef>
#include <cstdint>
#include <iostream>

int main() {
    static_assert(BRK_SYNTH_ABI_VERSION == 0x00010000U, "base ABI must remain frozen");
    static_assert(BRK_SYNTH_ASSET_EXT_VERSION == 0x00010000U, "asset extension version");
    static_assert(sizeof(brk_asset_arena_v1) == 48U, "asset arena layout");
    static_assert(sizeof(brk_asset_binding_v1) == 64U, "asset binding layout");
    static_assert(offsetof(brk_asset_arena_v1, data_offset) == 4U, "arena data offset field");
    static_assert(offsetof(brk_asset_arena_v1, flags) == 16U, "arena flags field");
    static_assert(offsetof(brk_asset_binding_v1, data_offset) == 16U, "binding data offset field");
    static_assert(offsetof(brk_asset_binding_v1, byte_size) == 20U, "binding byte size field");
    static_assert(offsetof(brk_asset_binding_v1, frame_count) == 24U, "binding frame count field");
    static_assert(offsetof(brk_asset_binding_v1, channel_count) == 28U, "binding channel count field");
    static_assert(offsetof(brk_asset_binding_v1, sample_rate_hz) == 32U, "binding sample rate field");

    brk_asset_arena_v1 arena{};
    arena.struct_size = sizeof(arena);
    arena.data_offset = 4096U;
    arena.byte_capacity = 32768U;
    arena.alignment = 16U;
    arena.flags = BRK_ASSET_ARENA_HOST_WRITABLE | BRK_ASSET_ARENA_STOPPED_ONLY;

    brk_asset_binding_v1 binding{};
    binding.struct_size = sizeof(binding);
    binding.asset_slot = 0U;
    binding.format = BRK_ASSET_FORMAT_PCM_S16_INTERLEAVED;
    binding.data_offset = 4096U;
    binding.byte_size = 19200U;
    binding.frame_count = 4800U;
    binding.channel_count = 2U;
    binding.sample_rate_hz = 48000U;

    if (arena.struct_size != 48U || binding.struct_size != 64U) return 1;
    if ((arena.flags & BRK_ASSET_ARENA_HOST_WRITABLE) == 0U) return 2;
    if ((arena.flags & BRK_ASSET_ARENA_STOPPED_ONLY) == 0U) return 3;
    if (binding.byte_size != binding.frame_count * binding.channel_count * 2U) return 4;
    if (binding.data_offset < arena.data_offset) return 5;
    if (binding.data_offset + binding.byte_size > arena.data_offset + arena.byte_capacity) return 6;

    std::cout << "asset_ext_version=" << BRK_SYNTH_ASSET_EXT_VERSION << '\n';
    std::cout << "asset_arena_size=" << sizeof(brk_asset_arena_v1) << '\n';
    std::cout << "asset_binding_size=" << sizeof(brk_asset_binding_v1) << '\n';
    return 0;
}

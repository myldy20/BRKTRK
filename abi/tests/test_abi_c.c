#include "brk_synth_abi.h"
#include "brk_synth_asset_ext.h"

#include <stdint.h>

int main(void) {
    brk_event_header header = {0};
    brk_prepare_info prepare = {0};
    brk_asset_arena_v1 arena = {0};
    brk_asset_binding_v1 binding = {0};
    header.size = (uint16_t)sizeof(brk_event_header);
    header.type = (uint16_t)BRK_EVENT_RESET;
    prepare.struct_size = (uint32_t)sizeof(brk_prepare_info);
    prepare.sample_rate = 48000.0;
    arena.struct_size = (uint32_t)sizeof(brk_asset_arena_v1);
    binding.struct_size = (uint32_t)sizeof(brk_asset_binding_v1);
    binding.format = BRK_ASSET_FORMAT_PCM_S16_INTERLEAVED;
    return header.size == 12u && prepare.struct_size >= 64u
        && arena.struct_size == 48u && binding.struct_size == 64u
        && BRK_SYNTH_ASSET_EXT_VERSION == 0x00010000u ? 0 : 1;
}

#ifndef BRK_SYNTH_ASSET_EXT_H
#define BRK_SYNTH_ASSET_EXT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BRK_SYNTH_ASSET_EXT_MAJOR 1u
#define BRK_SYNTH_ASSET_EXT_MINOR 0u
#define BRK_SYNTH_ASSET_EXT_VERSION ((BRK_SYNTH_ASSET_EXT_MAJOR << 16u) | BRK_SYNTH_ASSET_EXT_MINOR)

typedef enum brk_asset_format {
    BRK_ASSET_FORMAT_PCM_S16_INTERLEAVED = 1u
} brk_asset_format;

typedef enum brk_asset_arena_flags {
    BRK_ASSET_ARENA_HOST_WRITABLE = 1u << 0u,
    BRK_ASSET_ARENA_STOPPED_ONLY = 1u << 1u
} brk_asset_arena_flags;

typedef struct brk_asset_arena_v1 {
    uint32_t struct_size;
    uint32_t data_offset;
    uint32_t byte_capacity;
    uint32_t alignment;
    uint32_t flags;
    uint32_t reserved[7];
} brk_asset_arena_v1;

typedef struct brk_asset_binding_v1 {
    uint32_t struct_size;
    uint32_t asset_slot;
    uint32_t format;
    uint32_t flags;
    uint32_t data_offset;
    uint32_t byte_size;
    uint32_t frame_count;
    uint32_t channel_count;
    uint32_t sample_rate_hz;
    uint32_t reserved[7];
} brk_asset_binding_v1;

/*
 * Optional module-level extension. A package advertises support explicitly;
 * hosts must not require these exports from ordinary BRK Synth ABI v1 engines.
 *
 * All asset writes and instance bind/unbind operations are stopped/deactivated
 * operations. The host owns arena allocation, Project asset identity and
 * content hashes. The engine receives only a bounded read-only PCM span.
 */
uint32_t brk_asset_ext_version(void);
uint32_t brk_asset_arena_descriptor(uint32_t dst_offset, uint32_t dst_capacity);
int32_t brk_instance_asset_bind(uint32_t instance_handle, uint32_t binding_offset);
int32_t brk_instance_asset_unbind(uint32_t instance_handle, uint32_t asset_slot);

#ifdef __cplusplus
} /* extern "C" */

static_assert(sizeof(brk_asset_arena_v1) == 48, "brk_asset_arena_v1 layout");
static_assert(sizeof(brk_asset_binding_v1) == 64, "brk_asset_binding_v1 layout");
static_assert(offsetof(brk_asset_binding_v1, data_offset) == 16, "asset binding data offset layout");
static_assert(offsetof(brk_asset_binding_v1, sample_rate_hz) == 32, "asset binding sample rate layout");
#endif

#endif /* BRK_SYNTH_ASSET_EXT_H */

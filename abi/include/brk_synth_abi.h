#ifndef BRK_SYNTH_ABI_H
#define BRK_SYNTH_ABI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BRK_SYNTH_ABI_MAJOR 1u
#define BRK_SYNTH_ABI_MINOR 0u
#define BRK_SYNTH_ABI_VERSION ((BRK_SYNTH_ABI_MAJOR << 16u) | BRK_SYNTH_ABI_MINOR)

#define BRK_SYNTH_STATE_MAGIC 0x534b5242u /* "BRKS" little-endian */
#define BRK_SYNTH_INVALID_HANDLE 0u
#define BRK_SYNTH_GLOBAL_NOTE_ID 0u

typedef uint32_t brk_instance_handle;
typedef uint32_t brk_parameter_id;

typedef enum brk_result {
    BRK_OK = 0,
    BRK_ERROR_INVALID_ARGUMENT = -1,
    BRK_ERROR_INVALID_STATE = -2,
    BRK_ERROR_UNSUPPORTED = -3,
    BRK_ERROR_OUT_OF_MEMORY = -4,
    BRK_ERROR_BAD_ABI_VERSION = -5,
    BRK_ERROR_BAD_OFFSET = -6,
    BRK_ERROR_BAD_SIZE = -7,
    BRK_ERROR_BAD_EVENT = -8,
    BRK_ERROR_BAD_PARAMETER = -9,
    BRK_ERROR_NOT_PREPARED = -10,
    BRK_ERROR_NOT_ACTIVE = -11,
    BRK_ERROR_ALREADY_ACTIVE = -12,
    BRK_ERROR_INTERNAL = -100
} brk_result;

typedef enum brk_event_type {
    BRK_EVENT_NOTE_ON = 1,
    BRK_EVENT_NOTE_OFF = 2,
    BRK_EVENT_NOTE_CHOKE = 3,
    BRK_EVENT_RETRIGGER = 4,
    BRK_EVENT_PARAM_VALUE = 5,
    BRK_EVENT_PARAM_RAMP = 6,
    BRK_EVENT_ALL_NOTES_OFF = 7,
    BRK_EVENT_RESET = 8,
    BRK_EVENT_SUSTAIN = 9
} brk_event_type;

typedef enum brk_parameter_type {
    BRK_PARAMETER_CONTINUOUS = 1,
    BRK_PARAMETER_STEPPED = 2,
    BRK_PARAMETER_ENUM = 3,
    BRK_PARAMETER_BOOLEAN = 4
} brk_parameter_type;

typedef enum brk_parameter_flags {
    BRK_PARAMETER_AUTOMATABLE = 1u << 0u,
    BRK_PARAMETER_MODULATABLE = 1u << 1u,
    BRK_PARAMETER_PER_NOTE = 1u << 2u,
    BRK_PARAMETER_HIDDEN = 1u << 3u,
    BRK_PARAMETER_READ_ONLY = 1u << 4u,
    BRK_PARAMETER_REQUIRES_RECONFIGURE = 1u << 5u
} brk_parameter_flags;

typedef enum brk_process_flags {
    BRK_PROCESS_REALTIME = 1u << 0u,
    BRK_PROCESS_OFFLINE = 1u << 1u,
    BRK_PROCESS_DISCONTINUITY = 1u << 2u
} brk_process_flags;

typedef struct brk_span {
    uint32_t offset;
    uint32_t byte_size;
} brk_span;

typedef struct brk_string_ref {
    uint32_t offset;
    uint32_t byte_size;
} brk_string_ref;

typedef struct brk_audio_span {
    uint32_t struct_size;
    uint32_t data_offset;
    uint32_t channel_count;
    uint32_t frame_capacity;
    uint32_t channel_stride_frames;
    uint32_t reserved0;
} brk_audio_span;

typedef struct brk_create_info {
    uint32_t struct_size;
    uint32_t flags;
    uint32_t engine_index;
    uint32_t reserved0;
    uint32_t reserved[8];
} brk_create_info;

typedef struct brk_prepare_info {
    uint32_t struct_size;
    uint32_t flags;
    double sample_rate;
    uint32_t max_block_frames;
    uint32_t max_events_per_block;
    uint32_t output_channel_count;
    uint32_t realtime_memory_limit_bytes;
    uint32_t deterministic_seed_lo;
    uint32_t deterministic_seed_hi;
    uint32_t reserved[8];
} brk_prepare_info;

typedef struct brk_transport_context {
    uint32_t struct_size;
    uint32_t flags;
    uint32_t absolute_frame_lo;
    uint32_t absolute_frame_hi;
    double tempo_bpm;
    double song_position_beats;
    uint32_t reserved[8];
} brk_transport_context;

typedef struct brk_process_info {
    uint32_t struct_size;
    uint32_t frame_count;
    uint32_t output_bus_offset;
    uint32_t event_bytes_offset;
    uint32_t event_bytes_size;
    uint32_t event_count;
    uint32_t transport_offset;
    uint32_t process_flags;
    uint32_t reserved[8];
} brk_process_info;

typedef struct brk_event_header {
    uint16_t size;
    uint16_t type;
    uint32_t frame_offset;
    uint32_t flags;
} brk_event_header;

typedef struct brk_note_event {
    brk_event_header header;
    uint32_t note_id;
    int16_t key;
    int16_t channel;
    float velocity;
    float tuning_semitones;
} brk_note_event;

typedef struct brk_param_value_event {
    brk_event_header header;
    uint32_t parameter_id;
    float normalized_value;
    uint32_t note_id;
} brk_param_value_event;

typedef struct brk_param_ramp_event {
    brk_event_header header;
    uint32_t parameter_id;
    float start_normalized;
    float end_normalized;
    uint32_t duration_frames;
    uint32_t note_id;
} brk_param_ramp_event;

typedef struct brk_sustain_event {
    brk_event_header header;
    uint32_t down;
    uint32_t reserved0;
} brk_sustain_event;

typedef struct brk_module_descriptor_v1 {
    uint32_t struct_size;
    uint32_t abi_min_version;
    uint32_t abi_max_version;
    uint32_t engine_count;
    brk_string_ref module_id;
    brk_string_ref display_name;
    brk_string_ref vendor_name;
    brk_string_ref license_id;
    uint32_t flags;
    uint32_t reserved[8];
} brk_module_descriptor_v1;

typedef struct brk_engine_descriptor_v1 {
    uint32_t struct_size;
    uint32_t engine_index;
    brk_string_ref engine_id;
    brk_string_ref display_name;
    uint32_t output_channel_count;
    uint32_t parameter_count;
    uint32_t state_schema_version;
    uint32_t max_polyphony;
    uint32_t flags;
    uint32_t reserved[8];
} brk_engine_descriptor_v1;

typedef struct brk_parameter_descriptor_v1 {
    uint32_t struct_size;
    uint32_t parameter_id;
    uint32_t parameter_type;
    uint32_t flags;
    brk_string_ref key;
    brk_string_ref display_name;
    brk_string_ref unit;
    brk_string_ref group_key;
    float normalized_default;
    float plain_min;
    float plain_max;
    float plain_step;
    uint32_t enum_value_count;
    uint32_t reserved[7];
} brk_parameter_descriptor_v1;

typedef struct brk_state_blob_header_v1 {
    uint32_t magic;
    uint16_t schema_major;
    uint16_t schema_minor;
    uint32_t header_size;
    uint32_t total_size;
    uint32_t engine_id_hash;
    uint32_t parameter_record_count;
    uint32_t payload_crc32;
    uint32_t flags;
    uint32_t reserved[6];
} brk_state_blob_header_v1;

typedef struct brk_state_parameter_record_v1 {
    uint32_t parameter_id;
    float normalized_value;
} brk_state_parameter_record_v1;

uint32_t brk_abi_version(void);
uint32_t brk_module_descriptor(uint32_t dst_offset, uint32_t dst_capacity);
uint32_t brk_engine_descriptor(uint32_t engine_index, uint32_t dst_offset, uint32_t dst_capacity);
uint32_t brk_parameter_descriptor(uint32_t engine_index, uint32_t parameter_index,
                                  uint32_t dst_offset, uint32_t dst_capacity);

int32_t brk_instance_create(uint32_t engine_index, uint32_t create_info_offset);
int32_t brk_instance_prepare(uint32_t instance_handle, uint32_t prepare_info_offset);
int32_t brk_instance_activate(uint32_t instance_handle);
int32_t brk_instance_deactivate(uint32_t instance_handle);
int32_t brk_instance_reset(uint32_t instance_handle);
int32_t brk_instance_destroy(uint32_t instance_handle);
int32_t brk_instance_process(uint32_t instance_handle, uint32_t process_info_offset);

uint32_t brk_instance_state_size(uint32_t instance_handle);
int32_t brk_instance_state_write(uint32_t instance_handle, uint32_t dst_offset, uint32_t dst_capacity);
int32_t brk_instance_state_read(uint32_t instance_handle, uint32_t src_offset,
                                uint32_t src_size, uint32_t schema_version);

#ifdef __cplusplus
} /* extern "C" */

static_assert(sizeof(brk_span) == 8, "brk_span layout");
static_assert(sizeof(brk_audio_span) == 24, "brk_audio_span layout");
static_assert(sizeof(brk_event_header) == 12, "brk_event_header layout");
static_assert(sizeof(brk_note_event) == 28, "brk_note_event layout");
static_assert(sizeof(brk_param_value_event) == 24, "brk_param_value_event layout");
static_assert(sizeof(brk_param_ramp_event) == 32, "brk_param_ramp_event layout");
static_assert(sizeof(brk_sustain_event) == 20, "brk_sustain_event layout");
static_assert(sizeof(brk_state_parameter_record_v1) == 8, "state parameter layout");
static_assert(offsetof(brk_prepare_info, sample_rate) == 8, "sample_rate alignment");
static_assert(offsetof(brk_transport_context, tempo_bpm) == 16, "tempo alignment");
#endif

#endif /* BRK_SYNTH_ABI_H */

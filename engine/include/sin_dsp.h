#pragma once
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
  #if defined(SIN_DSP_STATIC)
    #define SIN_API
  #elif defined(SIN_DSP_BUILD)
    #define SIN_API __declspec(dllexport)
  #else
    #define SIN_API __declspec(dllimport)
  #endif
#else
  #define SIN_API __attribute__((visibility("default")))
#endif

#define SIN_DEFAULT_SAMPLE_RATE 48000u
#define SIN_MAX_BUSES           256u
#define SIN_MAX_SCOPE_SAMPLES   256u
#define SIN_MAX_PROC_PARAMS     8u

typedef struct SinEngine SinEngine;
typedef uint32_t SinBusId;
typedef uint32_t SinSourceId;

typedef enum {
    SIN_PARAM_PRE_GAIN_DB   = 1,
    SIN_PARAM_VOLUME        = 2,  /* linear gain (e.g. 0.0 .. 2.0) */
    SIN_PARAM_POST_GAIN_DB  = 3,
    SIN_PARAM_PAN           = 4,  /* -1.0 (L) .. +1.0 (R) */
    SIN_PARAM_MUTE          = 5,  /* 0 or 1 */
    SIN_PARAM_SOLO          = 6,  /* 0 or 1 */
    SIN_PARAM_CROP_START    = 7,  /* normalized 0.0 .. 1.0 */
    SIN_PARAM_CROP_END      = 8,  /* normalized 0.0 .. 1.0 */
    SIN_PARAM_PLAYBACK_RATE = 9,  /* varispeed multiplier (> 0.0) */
} SinParamId;

typedef enum {
    SIN_CLIP_LOOP_SOURCE     = 1u << 0, /* wrap/tile inside cropped source window */
    SIN_CLIP_LIVE_CROP_BOUND = 1u << 1, /* live bus CROP_START/END overrides source_start/end_ratio */
    SIN_CLIP_LIVE_RATE_BOUND = 1u << 2, /* live bus PLAYBACK_RATE multiplies clip playback_rate */
    SIN_CLIP_CROP_IN_PLACE   = 1u << 3, /* crop gates inside timeline position rather than shifting to start */
} SinClipFlags;

typedef struct {
    uint32_t sample_rate;    /* 0 => SIN_DEFAULT_SAMPLE_RATE (48000 Hz) */
    uint32_t max_block_size; /* e.g. 512 (RT) or 1024 (offline); 0 => 1024 */
    uint32_t offline_mode;   /* 1 = snap smoothers at frame 0 & sync disk reads; 0 = RT smooth */
} SinEngineConfig;

typedef struct {
    SinBusId bus_id;
    SinBusId parent_bus_id;  /* 0 or == bus_id means root master bus */
    float    pre_gain_db;
    float    volume;
    float    post_gain_db;
    float    pan;
    float    crop_start;     /* default 0.0 */
    float    crop_end;       /* default 1.0 */
    float    playback_rate;  /* default 1.0 */
    uint8_t  muted;
    uint8_t  solo;
    uint8_t  _pad[2];
} SinBusDesc;

typedef struct {
    uint32_t    clip_id;
    SinSourceId source_id;
    SinBusId    target_bus_id;
    int64_t     timeline_start_frame;   /* at engine sample_rate */
    int64_t     timeline_length_frames; /* <= 0 => full natural cropped source length */
    double      source_start_ratio;     /* 0.0 .. 1.0 */
    double      source_end_ratio;       /* 0.0 .. 1.0 */
    float       gain;                   /* linear clip gain / step velocity */
    float       playback_rate;          /* 1.0 = natural (auto-scaled by src_sr / engine_sr) */
    uint32_t    fade_in_frames;
    uint32_t    fade_out_frames;
    uint32_t    release_frames;         /* linear decay over trailing release_frames of clip */
    uint32_t    flags;                  /* SinClipFlags bitmask */
} SinClipDesc;

typedef struct {
    double   playhead_seconds;
    double   duration_seconds;
    double   bpm;
    uint32_t sample_rate;
    uint32_t is_playing;
    uint32_t loop_enabled;
    uint32_t audition_active;
    uint32_t active_bus_count;
    float    master_peak_l;
    float    master_peak_r;
    float    master_rms_l;
    float    master_rms_r;
} SinTelemetry;

typedef struct {
    SinBusId bus_id;
    float    peak;
} SinBusPeak;

typedef struct {
    SinBusId bus_id;
    float    rms;
} SinBusRms;

typedef struct {
    uint32_t sample_rate;
    uint32_t channels;
    uint64_t num_frames;
    uint8_t  is_streaming;
    uint8_t  _pad[7];
} SinSourceInfo;

/* Lifecycle */
SIN_API SinEngine* sin_engine_create(const SinEngineConfig* cfg);
SIN_API void       sin_engine_destroy(SinEngine* engine);
SIN_API void       sin_engine_reset(SinEngine* engine);

/* OS Audio Device Output (WASAPI on Windows, CoreAudio on macOS/iOS, ALSA/Pulse on Linux) */
SIN_API int32_t    sin_engine_start_device(SinEngine* engine);
SIN_API void       sin_engine_stop_device(SinEngine* engine);
SIN_API int32_t    sin_engine_is_device_running(const SinEngine* engine);
SIN_API uint32_t   sin_engine_get_sample_rate(const SinEngine* engine);

/* Hybrid Sources: RAM (<30s) or Direct Lock-Free Disk Streaming (multi-GB) + In-Memory PCM (Python) */
SIN_API int32_t    sin_engine_register_file_source(SinEngine* engine, SinSourceId id, const char* utf8_path, uint32_t force_ram);
SIN_API int32_t    sin_engine_register_pcm_source(SinEngine* engine, SinSourceId id, const float* ch0, const float* ch1, uint32_t num_frames, uint32_t src_sr, uint64_t content_hash);
SIN_API int32_t    sin_engine_get_source_info(const SinEngine* engine, SinSourceId id, SinSourceInfo* out_info);
SIN_API int32_t    sin_engine_release_source(SinEngine* engine, SinSourceId id);
SIN_API void       sin_engine_release_all_sources(SinEngine* engine);

/* Atomic Plan Swap (5ms click-free crossfade in RT mode; instant in offline mode) */
typedef enum SinProcessorType {
    SIN_PROC_NONE = 0,
    SIN_PROC_GAIN = 1
} SinProcessorType;

typedef struct SinChainStageDesc {
    SinBusId bus_id;
    uint32_t stage_index;
    uint32_t processor_type; /* SinProcessorType */
    uint32_t enabled;        /* 0 = bypassed, 1 = active */
    uint32_t num_params;     /* <= SIN_MAX_PROC_PARAMS */
    float    params[SIN_MAX_PROC_PARAMS];
} SinChainStageDesc;

SIN_API int32_t    sin_engine_load_plan(
                       SinEngine* engine,
                       const SinBusDesc* buses, uint32_t num_buses,
                       const SinClipDesc* clips, uint32_t num_clips,
                       double explicit_duration_sec, /* <= 0 => "auto" natural duration */
                       double bpm);

SIN_API int32_t    sin_engine_load_plan_with_chains(
                       SinEngine* engine,
                       const SinBusDesc* buses, uint32_t num_buses,
                       const SinClipDesc* clips, uint32_t num_clips,
                       const SinChainStageDesc* stages, uint32_t num_stages,
                       double explicit_duration_sec, /* <= 0 => "auto" natural duration */
                       double bpm);

/* Real-Time Parameter, Transport & Audition Control (Lock-free SPSC ring) */
SIN_API void       sin_engine_set_param(SinEngine* engine, SinBusId bus_id, uint16_t param_id, float value, float ramp_ms);
SIN_API void       sin_engine_set_stage_param(SinEngine* engine, SinBusId bus_id, uint32_t stage_index, uint32_t param_index, float value, float ramp_ms);
SIN_API void       sin_engine_set_stage_enabled(SinEngine* engine, SinBusId bus_id, uint32_t stage_index, uint32_t enabled);
SIN_API void       sin_engine_set_transport(SinEngine* engine, uint32_t playing, double seek_sec, double bpm, double loop_start_sec, double loop_end_sec, uint32_t loop_enabled);
SIN_API void       sin_engine_set_audition(SinEngine* engine, uint32_t active, SinBusId solo_bus_id, double start_sec, double end_sec);

/* Offline & Pull-Mode Audio Processing (Zero-alloc, lock-free) */
SIN_API void       sin_engine_process(SinEngine* engine, float* out_l, float* out_r, uint32_t num_frames);
SIN_API int32_t    sin_engine_set_bus_tap(SinEngine* engine, SinBusId bus_id, float* tap_l, float* tap_r, uint32_t capacity_frames);
SIN_API void       sin_engine_clear_bus_taps(SinEngine* engine);

/* Telemetry Pull (60Hz playhead, per-bus peaks/RMS, oscilloscope frame) */
SIN_API void       sin_engine_read_telemetry(
                       const SinEngine* engine,
                       SinTelemetry* out_hdr,
                       SinBusPeak* out_bus_peaks, uint32_t max_buses,
                       float* out_scope_mono, uint32_t scope_len);
SIN_API uint32_t   sin_engine_read_bus_rms(
                       const SinEngine* engine,
                       SinBusRms* out_bus_rms, uint32_t max_buses);

#ifdef __cplusplus
}
#endif

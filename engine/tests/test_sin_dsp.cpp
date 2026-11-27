#include "../include/sin_dsp.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <new>
#include <string>
#include <vector>

/* Global allocation trap to mathematically prove ZERO heap allocations inside sin_engine_process(). */
static std::atomic<bool> g_trap_allocs{false};
static std::atomic<int>  g_trapped_count{0};

void* operator new(std::size_t sz) {
    if (g_trap_allocs.load(std::memory_order_acquire)) {
        g_trapped_count.fetch_add(1, std::memory_order_relaxed);
    }
    if (sz == 0) sz = 1;
    void* p = std::malloc(sz);
    if (!p) throw std::bad_alloc();
    return p;
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

#define CHECK(cond, msg) do { \
    if (!(cond)) { \
        std::fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, msg); \
        return 1; \
    } \
} while (0)

static bool write_wav_pcm16(const std::filesystem::path& path, const std::vector<float>& mono, uint32_t sr) {
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    const uint32_t num_samples = static_cast<uint32_t>(mono.size());
    const uint32_t data_bytes = num_samples * 2;
    const uint32_t riff_size = 36 + data_bytes;
    const uint16_t audio_fmt = 1;
    const uint16_t channels = 1;
    const uint32_t byte_rate = sr * channels * 2;
    const uint16_t block_align = channels * 2;
    const uint16_t bits = 16;

    f.write("RIFF", 4);
    f.write(reinterpret_cast<const char*>(&riff_size), 4);
    f.write("WAVEfmt ", 8);
    const uint32_t fmt_size = 16;
    f.write(reinterpret_cast<const char*>(&fmt_size), 4);
    f.write(reinterpret_cast<const char*>(&audio_fmt), 2);
    f.write(reinterpret_cast<const char*>(&channels), 2);
    f.write(reinterpret_cast<const char*>(&sr), 4);
    f.write(reinterpret_cast<const char*>(&byte_rate), 4);
    f.write(reinterpret_cast<const char*>(&block_align), 2);
    f.write(reinterpret_cast<const char*>(&bits), 2);
    f.write("data", 4);
    f.write(reinterpret_cast<const char*>(&data_bytes), 4);

    std::vector<int16_t> pcm(num_samples);
    for (uint32_t i = 0; i < num_samples; ++i) {
        float s = mono[i];
        if (s > 1.0f) s = 1.0f;
        if (s < -1.0f) s = -1.0f;
        pcm[i] = static_cast<int16_t>(std::lrint(s * 32767.0f));
    }
    f.write(reinterpret_cast<const char*>(pcm.data()), data_bytes);
    return static_cast<bool>(f);
}

static int test_default_sr_and_unity_passthrough() {
    SinEngineConfig cfg{};
    cfg.sample_rate = 0; // should default to 48000
    cfg.max_block_size = 256;
    cfg.offline_mode = 1;
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "engine creation failed");
    CHECK(sin_engine_get_sample_rate(eng) == 48000u, "default sample rate must be 48000");

    constexpr uint32_t N = 4800;
    std::vector<float> src_l(N), src_r(N);
    for (uint32_t i = 0; i < N; ++i) {
        src_l[i] = 0.5f * std::sin(2.0f * 3.14159265f * 440.0f * i / 48000.0f);
        src_r[i] = -0.25f * std::cos(2.0f * 3.14159265f * 220.0f * i / 48000.0f);
    }
    CHECK(sin_engine_register_pcm_source(eng, 1, src_l.data(), src_r.data(), N, 48000, 12345) == 0, "register pcm failed");

    SinBusDesc buses[2] = {};
    buses[0] = {10, 1, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
    buses[1] = {1,  0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};

    SinClipDesc clip{};
    clip.clip_id = 1;
    clip.source_id = 1;
    clip.target_bus_id = 10;
    clip.timeline_start_frame = 0;
    clip.timeline_length_frames = 0;
    clip.source_start_ratio = 0.0;
    clip.source_end_ratio = 1.0;
    clip.gain = 1.0f;
    clip.playback_rate = 1.0f;
    CHECK(sin_engine_load_plan(eng, buses, 2, &clip, 1, 0.0, 120.0) == 0, "load plan failed");

    std::vector<float> out_l(N, 0.0f), out_r(N, 0.0f);
    std::vector<float> tap_l(N, 0.0f), tap_r(N, 0.0f);
    CHECK(sin_engine_set_bus_tap(eng, 10, tap_l.data(), tap_r.data(), N) == 0, "set bus tap failed");

    // Zero-allocation trap around sin_engine_process()
    g_trapped_count.store(0, std::memory_order_relaxed);
    g_trap_allocs.store(true, std::memory_order_release);
    for (uint32_t off = 0; off < N; off += 256) {
        const uint32_t blk = (N - off) < 256 ? (N - off) : 256;
        sin_engine_process(eng, out_l.data() + off, out_r.data() + off, blk);
    }
    g_trap_allocs.store(false, std::memory_order_release);
    CHECK(g_trapped_count.load() == 0, "ZERO heap allocations allowed inside sin_engine_process()");

    float max_err = 0.0f;
    float max_tap_err = 0.0f;
    for (uint32_t i = 0; i < N; ++i) {
        max_err = std::max(max_err, std::abs(out_l[i] - src_l[i]));
        max_err = std::max(max_err, std::abs(out_r[i] - src_r[i]));
        max_tap_err = std::max(max_tap_err, std::abs(tap_l[i] - src_l[i]));
    }
    CHECK(max_err < 1e-6f, "unity pass-through must be bit-exact (<1e-6)");
    CHECK(max_tap_err < 1e-6f, "bus tap must match channel output");

    sin_engine_destroy(eng);
    return 0;
}

static int test_resampling_and_bus_solo_mute() {
    SinEngineConfig cfg{48000, 256, 1};
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "engine create failed");

    // Source 1 at 44100 Hz (0.5s sine 440Hz), Source 2 at 48000 Hz (constant 0.4)
    constexpr uint32_t N44 = 22050;
    std::vector<float> s1(N44);
    for (uint32_t i = 0; i < N44; ++i) {
        s1[i] = 0.5f * std::sin(2.0f * 3.14159265f * 440.0f * i / 44100.0f);
    }
    std::vector<float> s2(24000, 0.4f);

    CHECK(sin_engine_register_pcm_source(eng, 1, s1.data(), nullptr, N44, 44100, 1) == 0, "reg s1");
    CHECK(sin_engine_register_pcm_source(eng, 2, s2.data(), nullptr, 24000, 48000, 2) == 0, "reg s2");

    // Hierarchy: ch1 (10) & ch2 (11) -> grp (5) -> master (1)
    SinBusDesc buses[4] = {
        {10, 5, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
        {11, 5, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
        {5,  1, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
        {1,  0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
    };
    SinClipDesc clips[2] = {};
    clips[0] = {1, 1, 10, 0, 0, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, SIN_CLIP_LIVE_CROP_BOUND};
    clips[1] = {2, 2, 11, 0, 0, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, 0};

    CHECK(sin_engine_load_plan(eng, buses, 4, clips, 2, 0.0, 120.0) == 0, "load plan");

    // Solo ch1 (10) -> should hear resampled 440Hz sine through grp->master and ZERO DC from ch2 (11)
    sin_engine_set_param(eng, 10, SIN_PARAM_SOLO, 1.0f, 0.0f);
    std::vector<float> out_l(4800), out_r(4800);
    sin_engine_process(eng, out_l.data(), out_r.data(), 4800);

    // Check DC mean is ~0 (ch2 muted by solo!) and resampled sine matches analytical 440Hz at 48kHz
    double mean = 0.0;
    double max_sine_err = 0.0;
    for (uint32_t i = 10; i < 4790; ++i) {
        mean += out_l[i];
        double expected = 0.5 * std::sin(2.0 * 3.14159265358979 * 440.0 * i / 48000.0);
        max_sine_err = std::max(max_sine_err, std::abs(out_l[i] - expected));
    }
    mean /= 4780.0;
    CHECK(std::abs(mean) < 0.01, "ch2 must be muted when ch1 is soloed");
    CHECK(max_sine_err < 0.01, "44.1kHz -> 48kHz Hermite resampling must preserve 440Hz sine accurately");

    // Now test solo bypassing mute on ch2 (muted + soloed MUST be heard!)
    sin_engine_reset(eng);
    sin_engine_set_param(eng, 10, SIN_PARAM_SOLO, 0.0f, 0.0f);
    sin_engine_set_param(eng, 11, SIN_PARAM_MUTE, 1.0f, 0.0f);
    sin_engine_set_param(eng, 11, SIN_PARAM_SOLO, 1.0f, 0.0f);
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    CHECK(std::abs(out_l[100] - 0.4f) < 1e-5f, "soloing a muted bus must bypass mute and play ch2 DC=0.4");

    // Clearing solo must restore ch2's muted state (silence on ch2, ch1 sine plays)
    sin_engine_reset(eng);
    sin_engine_set_param(eng, 11, SIN_PARAM_SOLO, 0.0f, 0.0f);
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    double expected_s100 = 0.5 * std::sin(2.0 * 3.14159265358979 * 440.0 * 100 / 48000.0);
    CHECK(std::abs(out_l[100] - expected_s100) < 0.01, "clearing solo must restore muted ch2 silence and leave ch1 audible");

    // Now test live crop + audition on ch2
    sin_engine_reset(eng);
    sin_engine_set_audition(eng, 1, 11, 0.0, 0.05); // solo ch2
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    CHECK(std::abs(out_l[100] - 0.4f) < 1e-5f, "audition solo must isolate ch2 DC=0.4");

    sin_engine_destroy(eng);
    return 0;
}

static int test_disk_streaming_and_windows_non_locking_vfs() {
    namespace fs = std::filesystem;
    fs::path tmp_dir = fs::temp_directory_path() / "sin_dsp_test_vfs";
    fs::create_directories(tmp_dir);
    fs::path wav_a = tmp_dir / "long_stream_test.wav";
    fs::path wav_b = tmp_dir / "long_stream_renamed.wav";
    fs::remove(wav_a);
    fs::remove(wav_b);

    // Create a 32-second 8kHz mono WAV (~512KB on disk, > 30s threshold so it triggers Disk Streaming!)
    const uint32_t sr = 8000;
    const uint32_t frames = sr * 32;
    std::vector<float> samples(frames);
    for (uint32_t i = 0; i < frames; ++i) {
        samples[i] = 0.5f * std::sin(2.0f * 3.14159265f * 200.0f * i / static_cast<float>(sr));
    }
    CHECK(write_wav_pcm16(wav_a, samples, sr), "write temp wav failed");

    SinEngineConfig cfg{sr, 512, 1};
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "engine create");
    CHECK(sin_engine_register_file_source(eng, 1, wav_a.string().c_str(), 0) == 0, "register streaming file failed");

    SinSourceInfo info{};
    CHECK(sin_engine_get_source_info(eng, 1, &info) == 0, "get source info");
    CHECK(info.is_streaming == 1, "32s file must open in disk-streaming mode");
    CHECK(info.num_frames == frames, "stream frame count mismatch");

    SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
    SinClipDesc clip{1, 1, 1, 0, 0, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, 0};
    CHECK(sin_engine_load_plan(eng, &master, 1, &clip, 1, 0.0, 120.0) == 0, "load streaming plan");

    // CRITICAL WINDOWS SAFETY TEST: Rename the file ON DISK while actively held open by DiskStreamReader!
    std::error_code ec;
    fs::rename(wav_a, wav_b, ec);
    CHECK(!ec, "ShareSafeVfs MUST allow renaming open streaming files without Windows WinError 32!");

    // Render 20000 frames (> 16384 chunk boundary) from the open stream and verify accuracy
    std::vector<float> out_l(20000), out_r(20000);
    sin_engine_process(eng, out_l.data(), out_r.data(), 20000);
    float max_err = 0.0f;
    for (uint32_t i = 0; i < 20000; ++i) {
        max_err = std::max(max_err, std::abs(out_l[i] - samples[i]));
    }
    CHECK(max_err < 1e-3f, "disk streaming output must match WAV samples across chunk boundaries");

    sin_engine_release_all_sources(eng);
    sin_engine_destroy(eng);
    fs::remove(wav_b, ec);
    fs::remove(tmp_dir, ec);
    return 0;
}

static int test_fades_release_and_looping() {
    SinEngineConfig cfg{1000, 128, 1}; // 1kHz for exact integer frame verification
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "engine create");

    std::vector<float> ones(100, 1.0f);
    CHECK(sin_engine_register_pcm_source(eng, 1, ones.data(), nullptr, 100, 1000, 99) == 0, "reg ones");

    SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
    SinClipDesc clip{};
    clip.clip_id = 1;
    clip.source_id = 1;
    clip.target_bus_id = 1;
    clip.timeline_start_frame = 10;
    clip.timeline_length_frames = 250; // loops 100-frame source 2.5x
    clip.source_start_ratio = 0.0;
    clip.source_end_ratio = 1.0;
    clip.gain = 0.8f;
    clip.playback_rate = 1.0f;
    clip.fade_in_frames = 10;
    clip.fade_out_frames = 10;
    clip.release_frames = 0;
    clip.flags = SIN_CLIP_LOOP_SOURCE;

    CHECK(sin_engine_load_plan(eng, &master, 1, &clip, 1, 0.3, 120.0) == 0, "load loop plan");

    std::vector<float> out_l(300), out_r(300);
    sin_engine_process(eng, out_l.data(), out_r.data(), 300);

    CHECK(std::abs(out_l[5]) < 1e-6f, "before start must be silence");
    CHECK(std::abs(out_l[10]) < 1e-6f, "fade-in frame 0 must be 0");
    CHECK(std::abs(out_l[15] - 0.4f) < 1e-5f, "fade-in midpoint must be 0.5 * 0.8 = 0.4");
    CHECK(std::abs(out_l[150] - 0.8f) < 1e-5f, "looped middle must sustain at 0.8");
    CHECK(std::abs(out_l[259]) < 1e-6f, "fade-out last frame must be 0");
    CHECK(std::abs(out_l[265]) < 1e-6f, "after end must be silence");

    sin_engine_destroy(eng);
    return 0;
}

static int test_monotonic_seek_telemetry_and_declick_crossfade() {
    // RT mode (offline_mode = 0) driven manually without hardware device to test
    // click-free overlap crossfades on seek & pause and immediate monotonic telemetry.
    const uint32_t sr = 48000;
    SinEngineConfig cfg{sr, 512, 0};
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "engine create");

    // 2s constant +0.6 on first half, -0.6 on second half (worst-case polarity flip on seek!)
    std::vector<float> buf(sr * 2);
    for (uint32_t i = 0; i < sr; ++i) buf[i] = 0.6f;
    for (uint32_t i = sr; i < sr * 2; ++i) buf[i] = -0.6f;
    CHECK(sin_engine_register_pcm_source(eng, 1, buf.data(), nullptr, sr * 2, sr, 777) == 0, "reg polarity buf");

    SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
    SinClipDesc clip{1, 1, 1, 0, 0, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, 0};
    CHECK(sin_engine_load_plan(eng, &master, 1, &clip, 1, 0.0, 120.0) == 0, "load plan");

    std::vector<float> out_l(512), out_r(512);
    sin_engine_set_transport(eng, 1, 0.0, 120.0, 0.0, 0.0, 0);
    sin_engine_process(eng, out_l.data(), out_r.data(), 512);
    // Settled at +0.6 after initial 4ms (~192 samples) fade-in
    CHECK(std::abs(out_l[511] - 0.6f) < 1e-4f, "settled at +0.6 before jump");

    // Jump straight into opposite polarity (-0.6 at 1.2s)
    sin_engine_set_transport(eng, 1, 1.2, 120.0, 0.0, 0.0, 0);
    SinTelemetry tel{};
    sin_engine_read_telemetry(eng, &tel, nullptr, 0, nullptr, 0);
    CHECK(std::abs(tel.playhead_seconds - 1.2) < 1e-4, "telemetry must immediately reflect seek_sec without stale revert");
    CHECK(tel.is_playing == 1, "telemetry must immediately reflect playing=1");

    // Process next block and verify there is NO 1.2-amplitude hard step click between samples!
    sin_engine_process(eng, out_l.data(), out_r.data(), 512);
    float max_step = std::abs(out_l[0] - 0.6f);
    for (uint32_t i = 1; i < 512; ++i) {
        max_step = std::max(max_step, std::abs(out_l[i] - out_l[i - 1]));
    }
    CHECK(max_step < 0.05f, "overlap crossfade must prevent hard step click on worst-case polarity jump");
    CHECK(std::abs(out_l[511] - (-0.6f)) < 1e-4f, "must smoothly settle at -0.6 after 4ms crossfade");

    // Pause should ALSO decay cleanly without an abrupt -0.6 -> 0 step!
    sin_engine_set_transport(eng, 0, -1.0, 0.0, 0.0, 0.0, 0);
    sin_engine_process(eng, out_l.data(), out_r.data(), 512);
    float pause_step = std::abs(out_l[0] - (-0.6f));
    for (uint32_t i = 1; i < 512; ++i) {
        pause_step = std::max(pause_step, std::abs(out_l[i] - out_l[i - 1]));
    }
    CHECK(pause_step < 0.05f, "pause must fade out smoothly without a hard step click");
    CHECK(std::abs(out_l[511]) < 1e-6f, "must reach exact silence after 4ms pause tail");

    sin_engine_destroy(eng);
    return 0;
}

#include <thread>

static int test_dsp_processor_gain_chain() {
    SinEngineConfig cfg{48000, 128, 1};
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "chain engine create");

    std::vector<float> ones(512, 1.0f);
    CHECK(sin_engine_register_pcm_source(eng, 1, ones.data(), nullptr, 512, 48000, 101) == 0, "reg ones for chain");

    SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
    SinClipDesc clip{1, 1, 1, 0, 512, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, 0};

    SinChainStageDesc stages[2]{};
    stages[0].bus_id = 1;
    stages[0].stage_index = 0;
    stages[0].processor_type = SIN_PROC_GAIN;
    stages[0].enabled = 1;
    stages[0].num_params = 1;
    stages[0].params[0] = 0.5f;

    stages[1].bus_id = 1;
    stages[1].stage_index = 1;
    stages[1].processor_type = SIN_PROC_GAIN;
    stages[1].enabled = 1;
    stages[1].num_params = 1;
    stages[1].params[0] = 0.25f;

    CHECK(sin_engine_load_plan_with_chains(eng, &master, 1, &clip, 1, stages, 2, 0.0, 120.0) == 0, "load plan with chains");

    std::vector<float> out_l(128), out_r(128);
    g_trap_allocs = true;
    sin_engine_process(eng, out_l.data(), out_r.data(), 128);
    g_trap_allocs = false;
    CHECK(std::abs(out_l[64] - 0.125f) < 1e-5f, "0.5 * 0.25 = 0.125 stage cascade");

    // Disable stage 1 -> only stage 0 (0.5) applies
    sin_engine_set_stage_enabled(eng, 1, 1, 0);
    g_trap_allocs = true;
    sin_engine_process(eng, out_l.data(), out_r.data(), 128);
    g_trap_allocs = false;
    CHECK(std::abs(out_l[64] - 0.5f) < 1e-5f, "bypassed stage 1 leaves 0.5");

    // Update stage 0 gain & re-enable stage 1 -> 0.8 * 0.25 = 0.2
    sin_engine_set_stage_param(eng, 1, 0, 0, 0.8f, 0.0f);
    sin_engine_set_stage_enabled(eng, 1, 1, 1);
    g_trap_allocs = true;
    sin_engine_process(eng, out_l.data(), out_r.data(), 128);
    g_trap_allocs = false;
    CHECK(std::abs(out_l[64] - 0.2f) < 1e-5f, "0.8 * 0.25 = 0.2 live stage param update");

    sin_engine_destroy(eng);
    return 0;
}

static int test_multi_producer_cmd_and_live_crop_seek() {
    // 1. Multi-producer control-thread safety on cmd_ring/apply_command_audio
    {
        SinEngineConfig cfg{48000, 256, 1};
        SinEngine* eng = sin_engine_create(&cfg);
        CHECK(eng != nullptr, "mt engine create");
        std::vector<float> ones(48000, 0.5f);
        CHECK(sin_engine_register_pcm_source(eng, 1, ones.data(), nullptr, 48000, 48000, 202) == 0, "reg mt");
        SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
        SinClipDesc clip{};
        clip.clip_id = 1;
        clip.source_id = 1;
        clip.target_bus_id = 1;
        clip.source_end_ratio = 1.0;
        clip.gain = 1.0f;
        clip.playback_rate = 1.0f;
        clip.flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND;

        SinChainStageDesc stage{1, 0, SIN_PROC_GAIN, 1, 1, {1.0f}};
        CHECK(sin_engine_load_plan_with_chains(eng, &master, 1, &clip, 1, &stage, 1, 0.0, 120.0) == 0, "load mt plan");

        std::vector<std::thread> workers;
        for (int t = 0; t < 4; ++t) {
            workers.emplace_back([eng, t]() {
                for (int i = 0; i < 100; ++i) {
                    sin_engine_set_param(eng, 1, SIN_PARAM_VOLUME, 0.25f + 0.005f * static_cast<float>((t + i) % 10), 2.0f);
                    sin_engine_set_stage_param(eng, 1, 0, 0, 0.5f + 0.01f * static_cast<float>(i % 5), 2.0f);
                }
            });
        }
        for (auto& th : workers) th.join();

        // Live crop + playback_rate updates should recompute duration cleanly
        sin_engine_set_param(eng, 1, SIN_PARAM_CROP_START, 0.5f, 0.0f);
        sin_engine_set_param(eng, 1, SIN_PARAM_PLAYBACK_RATE, 2.0f, 0.0f);
        SinTelemetry tel{};
        sin_engine_read_telemetry(eng, &tel, nullptr, 0, nullptr, 0);
        // 1.0s * (1.0 - 0.5) / 2.0 = 0.25s
        CHECK(std::abs(tel.duration_seconds - 0.25) < 1e-3, "live crop + playback rate must update duration cleanly");

        sin_engine_destroy(eng);
    }

    // 2. Streaming disk seek hint respects live crop & rate overrides without crashing or starving
    {
        namespace fs = std::filesystem;
        const fs::path tmp_dir = fs::temp_directory_path() / "sin_dsp_live_crop_seek_test";
        std::error_code ec;
        fs::create_directories(tmp_dir, ec);
        const fs::path wav_path = tmp_dir / "long_ramp.wav";
        const uint32_t sr = 8000;
        const uint32_t frames = sr * 32; // > 30s disk streaming threshold
        std::vector<float> samples(frames);
        for (uint32_t i = 0; i < frames; ++i) {
            samples[i] = 0.8f * static_cast<float>(i) / static_cast<float>(frames);
        }
        CHECK(write_wav_pcm16(wav_path, samples, sr), "write stream ramp wav failed");

        SinEngineConfig cfg{sr, 256, 0};
        SinEngine* eng = sin_engine_create(&cfg);
        CHECK(eng != nullptr, "stream crop engine create");
        const std::string path_str = wav_path.string();
        CHECK(sin_engine_register_file_source(eng, 1, path_str.c_str(), 0) == 0, "reg stream file");
        SinSourceInfo sinfo{};
        CHECK(sin_engine_get_source_info(eng, 1, &sinfo) == 0 && sinfo.is_streaming == 1, "32s file must stream");

        SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
        SinClipDesc clip{};
        clip.clip_id = 1;
        clip.source_id = 1;
        clip.target_bus_id = 1;
        clip.source_end_ratio = 1.0;
        clip.gain = 1.0f;
        clip.playback_rate = 1.0f;
        clip.flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND;
        CHECK(sin_engine_load_plan(eng, &master, 1, &clip, 1, 0.0, 120.0) == 0, "load stream crop plan");

        sin_engine_set_param(eng, 1, SIN_PARAM_CROP_START, 0.5f, 0.0f);
        sin_engine_set_param(eng, 1, SIN_PARAM_PLAYBACK_RATE, 2.0f, 0.0f);
        sin_engine_set_transport(eng, 1, 2.0, 120.0, 0.0, 0.0, 0);

        std::this_thread::sleep_for(std::chrono::milliseconds(60));
        std::vector<float> out_l(256), out_r(256);
        sin_engine_process(eng, out_l.data(), out_r.data(), 256);
        // Expected source pos = 16s + 2s * 2.0 = 20s -> 0.8 * (20 / 32) = 0.50
        CHECK(out_l[128] > 0.40f && out_l[128] < 0.60f, "stream seek hint must land in cropped/repitched region");

        sin_engine_release_all_sources(eng);
        sin_engine_destroy(eng);
        fs::remove(wav_path, ec);
        fs::remove(tmp_dir, ec);
    }
    return 0;
}

static int test_per_bus_rms_and_rt_peak_hold() {
    // 1. Offline multi-bus RMS & peak telemetry (ch 10 -> sub 5 -> master 1) with zero allocs
    {
        SinEngineConfig cfg{48000, 256, 1};
        SinEngine* eng = sin_engine_create(&cfg);
        CHECK(eng != nullptr, "rms engine create failed");

        constexpr uint32_t N = 2048;
        std::vector<float> src(N, 0.5f);
        CHECK(sin_engine_register_pcm_source(eng, 1, src.data(), src.data(), N, 48000, 777) == 0, "reg dc");

        SinBusDesc buses[3] = {
            {10, 5, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
            {5,  1, 0.0f, 0.5f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
            {1,  0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
        };
        SinClipDesc clip{};
        clip.clip_id = 1;
        clip.source_id = 1;
        clip.target_bus_id = 10;
        clip.source_end_ratio = 1.0;
        clip.gain = 1.0f;
        clip.playback_rate = 1.0f;
        CHECK(sin_engine_load_plan(eng, buses, 3, &clip, 1, 0.0, 120.0) == 0, "load multi-bus rms plan");

        std::vector<float> out_l(512), out_r(512);
        g_trapped_count.store(0, std::memory_order_relaxed);
        g_trap_allocs.store(true, std::memory_order_release);
        sin_engine_process(eng, out_l.data(), out_r.data(), 512);
        g_trap_allocs.store(false, std::memory_order_release);
        CHECK(g_trapped_count.load() == 0, "ZERO heap allocations allowed in multi-bus RMS process()");

        SinTelemetry tel{};
        SinBusPeak peaks[8]{};
        SinBusRms rms_arr[8]{};
        sin_engine_read_telemetry(eng, &tel, peaks, 8, nullptr, 0);
        const uint32_t rc = sin_engine_read_bus_rms(eng, rms_arr, 8);
        CHECK(rc == 3, "expected 3 buses in sin_engine_read_bus_rms");

        float rms10 = -1.0f, rms5 = -1.0f, rms1 = -1.0f;
        for (uint32_t i = 0; i < rc; ++i) {
            if (rms_arr[i].bus_id == 10) rms10 = rms_arr[i].rms;
            if (rms_arr[i].bus_id == 5)  rms5  = rms_arr[i].rms;
            if (rms_arr[i].bus_id == 1)  rms1  = rms_arr[i].rms;
        }
        CHECK(std::abs(rms10 - 0.5f) < 1e-4f, "ch10 rms must equal 0.5");
        CHECK(std::abs(rms5 - 0.25f) < 1e-4f, "sub-bus 5 rms must equal 0.25 after 0.5 volume");
        CHECK(std::abs(rms1 - 0.25f) < 1e-4f, "master 1 rms must equal 0.25");

        sin_engine_destroy(eng);
    }

    // 2. RT mode: brief clipping impulse holds peak >= 0.999 for >50ms and decays ballistic RMS smoothly
    {
        SinEngineConfig cfg{48000, 256, 0};
        SinEngine* eng = sin_engine_create(&cfg);
        CHECK(eng != nullptr, "rt rms engine create failed");

        constexpr uint32_t N = 4800; // 100ms
        std::vector<float> src(N, 0.0f);
        for (uint32_t i = 200; i < 256; ++i) src[i] = 1.2f; // 1.1ms transient clip after 4ms start declick
        CHECK(sin_engine_register_pcm_source(eng, 1, src.data(), src.data(), N, 48000, 888) == 0, "reg impulse");

        SinBusDesc buses[2] = {
            {10, 1, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
            {1,  0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}},
        };
        SinClipDesc clip{};
        clip.clip_id = 1;
        clip.source_id = 1;
        clip.target_bus_id = 10;
        clip.source_end_ratio = 1.0;
        clip.gain = 1.0f;
        clip.playback_rate = 1.0f;
        CHECK(sin_engine_load_plan(eng, buses, 2, &clip, 1, 0.0, 120.0) == 0, "load rt impulse plan");
        sin_engine_set_transport(eng, 1, 0.0, 120.0, 0.0, 0.0, 0);

        std::vector<float> out_l(256), out_r(256);
        // Process 10 blocks = 2560 frames (~53ms)
        float first_rms = 0.0f;
        float tenth_rms = 0.0f;
        for (int blk = 0; blk < 10; ++blk) {
            sin_engine_process(eng, out_l.data(), out_r.data(), 256);
            SinBusRms rms_arr[4]{};
            const uint32_t rc = sin_engine_read_bus_rms(eng, rms_arr, 4);
            for (uint32_t i = 0; i < rc; ++i) {
                if (rms_arr[i].bus_id == 10) {
                    if (blk == 0) first_rms = rms_arr[i].rms;
                    if (blk == 9) tenth_rms = rms_arr[i].rms;
                }
            }
        }
        SinTelemetry tel{};
        SinBusPeak peaks[4]{};
        sin_engine_read_telemetry(eng, &tel, peaks, 4, nullptr, 0);
        float bus10_peak = 0.0f;
        for (int i = 0; i < 4; ++i) {
            if (peaks[i].bus_id == 10) bus10_peak = peaks[i].peak;
        }
        CHECK(bus10_peak >= 0.999f, "70ms RT peak-hold must preserve transient clip on bus 10 after 53ms");
        CHECK(tel.master_peak_l >= 0.999f, "70ms RT peak-hold must preserve transient clip on master after 53ms");
        CHECK(first_rms > 0.1f && tenth_rms > 0.05f && tenth_rms < first_rms,
              "RT ballistic RMS must follow impulse and decay smoothly");

        sin_engine_destroy(eng);
    }

    return 0;
}

static int test_fx_modules_serial_chain_and_meters() {
    const uint32_t sr = 48000;
    SinEngineConfig cfg{sr, 512, 1};
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "fx engine create failed");

    // 1. Param EQ: 1kHz sine with +6 dB boost at 1kHz (band 1 bell at 1000 Hz)
    {
        constexpr uint32_t N = 4096;
        std::vector<float> sine(N);
        for (uint32_t i = 0; i < N; ++i) {
            sine[i] = 0.25f * std::sin(2.0f * 3.14159265f * 1000.0f * static_cast<float>(i) / static_cast<float>(sr));
        }
        CHECK(sin_engine_register_pcm_source(eng, 1, sine.data(), sine.data(), N, sr, 901) == 0, "reg sine eq");

        SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
        SinClipDesc clip{1, 1, 1, 0, N, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, 0};

        SinChainStageDesc eq{};
        eq.bus_id = 1;
        eq.stage_index = 0;
        eq.processor_type = SIN_PROC_PARAM_EQ;
        eq.enabled = 1;
        eq.num_params = 20;
        // 5 params per band: enabled, type (0=LC,1=LS,2=Bell,3=Notch,4=HS,5=HC), freq, gain, q
        eq.params[0] = 1.0f; eq.params[1] = 1.0f; eq.params[2] = 100.0f;  eq.params[3] = 0.0f; eq.params[4] = 0.71f;
        eq.params[5] = 1.0f; eq.params[6] = 2.0f; eq.params[7] = 1000.0f; eq.params[8] = 6.0f; eq.params[9] = 1.5f;
        eq.params[10] = 1.0f; eq.params[11] = 2.0f; eq.params[12] = 2500.0f; eq.params[13] = 0.0f; eq.params[14] = 1.0f;
        eq.params[15] = 1.0f; eq.params[16] = 4.0f; eq.params[17] = 8000.0f; eq.params[18] = 0.0f; eq.params[19] = 0.71f;

        CHECK(sin_engine_load_plan_with_chains(eng, &master, 1, &clip, 1, &eq, 1, 0.0, 120.0) == 0, "load eq plan");

        std::vector<float> out_l(512), out_r(512);
        g_trapped_count.store(0, std::memory_order_relaxed);
        g_trap_allocs.store(true, std::memory_order_release);
        for (int b = 0; b < 4; ++b) {
            sin_engine_process(eng, out_l.data(), out_r.data(), 512);
        }
        g_trap_allocs.store(false, std::memory_order_release);
        CHECK(g_trapped_count.load() == 0, "ZERO heap allocs allowed in Param EQ process()");

        float peak = 0.0f;
        for (float v : out_l) peak = std::max(peak, std::abs(v));
        // 0.25 * 10^(6/20) ~= 0.4988
        CHECK(peak > 0.44f && peak < 0.56f, "Param EQ +6dB bell at 1kHz must boost 0.25 sine to ~0.50");

        // 1b. Low Cut cutoff slope controlled by Q (250Hz sine cut by 1000Hz Low Cut: 6dB/oct vs 48dB/oct)
        sin_engine_reset(eng);
        std::vector<float> low_sine(N);
        for (uint32_t i = 0; i < N; ++i) {
            low_sine[i] = 0.5f * std::sin(2.0f * 3.14159265f * 250.0f * static_cast<float>(i) / static_cast<float>(sr));
        }
        CHECK(sin_engine_register_pcm_source(eng, 3, low_sine.data(), low_sine.data(), N, sr, 903) == 0, "reg 250hz sine");
        SinClipDesc low_clip{1, 3, 1, 0, N, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, 0};

        SinChainStageDesc lcut{};
        lcut.bus_id = 1; lcut.stage_index = 0; lcut.processor_type = SIN_PROC_PARAM_EQ;
        lcut.enabled = 1; lcut.num_params = 20;
        // Band 0 = Low Cut at 1000Hz, Q = 0.2 (order 1 -> 6 dB/oct)
        lcut.params[0] = 1.0f; lcut.params[1] = 0.0f; lcut.params[2] = 1000.0f; lcut.params[3] = 0.0f; lcut.params[4] = 0.2f;
        lcut.params[5] = 0.0f; lcut.params[10] = 0.0f; lcut.params[15] = 0.0f;
        CHECK(sin_engine_load_plan_with_chains(eng, &master, 1, &low_clip, 1, &lcut, 1, 0.0, 120.0) == 0, "load low-cut gentle");
        for (int b = 0; b < 4; ++b) sin_engine_process(eng, out_l.data(), out_r.data(), 512);
        float gentle_peak = 0.0f;
        for (float v : out_l) gentle_peak = std::max(gentle_peak, std::abs(v));

        // Now steepen Q -> 12.0 (order 8 -> 48 dB/oct): must attenuate 250Hz dramatically more than 6 dB/oct
        sin_engine_reset(eng);
        lcut.params[4] = 12.0f;
        CHECK(sin_engine_load_plan_with_chains(eng, &master, 1, &low_clip, 1, &lcut, 1, 0.0, 120.0) == 0, "load low-cut steep");
        g_trapped_count.store(0, std::memory_order_relaxed);
        g_trap_allocs.store(true, std::memory_order_release);
        for (int b = 0; b < 4; ++b) sin_engine_process(eng, out_l.data(), out_r.data(), 512);
        g_trap_allocs.store(false, std::memory_order_release);
        CHECK(g_trapped_count.load() == 0, "ZERO heap allocs allowed in 48 dB/oct cascaded cutoff process()");
        float steep_peak = 0.0f;
        for (float v : out_l) steep_peak = std::max(steep_peak, std::abs(v));
        CHECK(gentle_peak > 0.08f && gentle_peak < 0.20f, "6 dB/oct Low Cut @ 1kHz attenuates 250Hz by ~12dB");
        CHECK(steep_peak < 0.005f && steep_peak < gentle_peak * 0.05f, "48 dB/oct Low Cut @ 1kHz attenuates 250Hz >> 6 dB/oct");

        // 1c. Notch filter at 1kHz attenuates 1kHz sine even with gain_db == 0
        sin_engine_reset(eng);
        SinChainStageDesc notch{};
        notch.bus_id = 1; notch.stage_index = 0; notch.processor_type = SIN_PROC_PARAM_EQ;
        notch.enabled = 1; notch.num_params = 20;
        notch.params[0] = 0.0f;
        notch.params[5] = 1.0f; notch.params[6] = 3.0f; notch.params[7] = 1000.0f; notch.params[8] = 0.0f; notch.params[9] = 2.0f;
        notch.params[10] = 0.0f; notch.params[15] = 0.0f;
        CHECK(sin_engine_load_plan_with_chains(eng, &master, 1, &clip, 1, &notch, 1, 0.0, 120.0) == 0, "load notch");
        for (int b = 0; b < 4; ++b) sin_engine_process(eng, out_l.data(), out_r.data(), 512);
        float notch_peak = 0.0f;
        for (float v : out_l) notch_peak = std::max(notch_peak, std::abs(v));
        CHECK(notch_peak < 0.01f, "Notch at 1kHz must strongly attenuate 1kHz sine");
    }

    // 2. Serial PreGain -> Clipper -> Comp -> Limiter -> PostGain & live stage meters
    {
        sin_engine_reset(eng);
        constexpr uint32_t N = 2048;
        std::vector<float> hot_dc(N, 0.5f);
        CHECK(sin_engine_register_pcm_source(eng, 2, hot_dc.data(), hot_dc.data(), N, sr, 902) == 0, "reg dc fx");

        // PreGain = +12 dB (0.5 -> ~1.99), PostGain = -6 dB (post-FX trim ~0.5x)
        SinBusDesc master{1, 0, 12.0f, 1.0f, -6.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
        SinClipDesc clip{1, 2, 1, 0, N, 0.0, 1.0, 1.0f, 1.0f, 0, 0, 0, 0};

        SinChainStageDesc stages[3]{};
        // Stage 0: Hard Clipper at -6 dB ceiling (0.501187)
        stages[0].bus_id = 1; stages[0].stage_index = 0; stages[0].processor_type = SIN_PROC_CLIPPER;
        stages[0].enabled = 1; stages[0].num_params = 5;
        stages[0].params[0] = 0.0f; // Hard
        stages[0].params[1] = 0.0f; // Drive
        stages[0].params[2] = -6.0f; // Ceiling -6dB (~0.501)
        stages[0].params[3] = 0.5f; // Softness
        stages[0].params[4] = 0.0f; // Output 0dB

        // Stage 1: Compressor (-20dB thresh, 4:1 ratio, fast attack 0.5ms, 50ms rel, 0 knee, 0 makeup, 100% mix)
        stages[1].bus_id = 1; stages[1].stage_index = 1; stages[1].processor_type = SIN_PROC_COMP;
        stages[1].enabled = 1; stages[1].num_params = 7;
        stages[1].params[0] = -20.0f; stages[1].params[1] = 4.0f; stages[1].params[2] = 0.5f;
        stages[1].params[3] = 50.0f; stages[1].params[4] = 0.0f; stages[1].params[5] = 0.0f; stages[1].params[6] = 100.0f;

        // Stage 2: Limiter (+6 dB input, -12 dB ceiling (~0.251), 50ms release, 2ms lookahead)
        stages[2].bus_id = 1; stages[2].stage_index = 2; stages[2].processor_type = SIN_PROC_LIMITER;
        stages[2].enabled = 1; stages[2].num_params = 4;
        stages[2].params[0] = 6.0f; stages[2].params[1] = -12.0f; stages[2].params[2] = 50.0f; stages[2].params[3] = 2.0f;

        CHECK(sin_engine_load_plan_with_chains(eng, &master, 1, &clip, 1, stages, 3, 0.0, 120.0) == 0, "load 3-stage fx plan");

        std::vector<float> out_l(512), out_r(512);
        g_trapped_count.store(0, std::memory_order_relaxed);
        g_trap_allocs.store(true, std::memory_order_release);
        sin_engine_process(eng, out_l.data(), out_r.data(), 512);
        g_trap_allocs.store(false, std::memory_order_release);
        CHECK(g_trapped_count.load() == 0, "ZERO heap allocs allowed across Clipper+Comp+Limiter process()");

        // Limiter caps at -12dB (~0.2512) and PostGain applies -6dB (~0.5012) => ~0.1259
        CHECK(out_l[511] > 0.05f && out_l[511] <= 0.135f, "PreGain->Clipper->Comp->Limiter->PostGain serial cascade level");

        SinStageMeter meters[8]{};
        const uint32_t mc = sin_engine_read_stage_meters(eng, meters, 8);
        CHECK(mc == 3, "expected 3 stage meters");
        CHECK(meters[0].stage_index == 0 && meters[0].meter_value < -1.0f, "Clipper must report negative clip attenuation");
        CHECK(meters[1].stage_index == 1 && meters[1].meter_value < -1.0f, "Compressor must report negative GR dB");
        CHECK(meters[2].stage_index == 2 && meters[2].meter_value < -0.5f, "Limiter must report negative GR dB");

        // Bypass limiter (stage 2) & set Clipper ceiling back to 0dB -> meter drops to 0
        sin_engine_set_stage_enabled(eng, 1, 2, 0);
        sin_engine_set_stage_param(eng, 1, 0, 2, 0.0f, 0.0f);
        sin_engine_process(eng, out_l.data(), out_r.data(), 512);
        const uint32_t mc2 = sin_engine_read_stage_meters(eng, meters, 8);
        CHECK(mc2 == 3 && meters[2].meter_value == 0.0f, "Bypassed stage must publish 0.0f meter");
    }

    sin_engine_destroy(eng);
    return 0;
}

static int test_layered_tile_streamer_zero_alloc_and_fallback() {
    namespace fs = std::filesystem;
    const fs::path tmp_dir = fs::temp_directory_path() / "sin_dsp_layered_tile_test";
    std::error_code ec;
    fs::create_directories(tmp_dir, ec);
    const fs::path wav_path = tmp_dir / "layered_base.wav";

    const uint32_t sr = 8000;
    const uint32_t tile_frames = 2000; // 0.25s tiles
    const uint32_t num_tiles = 4;      // 1.0s total
    const uint32_t total_frames = tile_frames * num_tiles;
    std::vector<float> base_samples(total_frames, 0.25f);
    CHECK(write_wav_pcm16(wav_path, base_samples, sr), "write layered base wav failed");

    SinEngineConfig cfg{sr, 256, 1};
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "layered engine create failed");

    const std::string path_str = wav_path.string();
    CHECK(sin_engine_register_layered_source(eng, 50, path_str.c_str(), tile_frames, num_tiles, sr, total_frames) == 0,
          "register layered source failed");

    SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0, 0, {0, 0}};
    SinClipDesc clip{};
    clip.clip_id = 1;
    clip.source_id = 50;
    clip.target_bus_id = 1;
    clip.source_end_ratio = 1.0;
    clip.gain = 1.0f;
    clip.playback_rate = 1.0f;
    CHECK(sin_engine_load_plan(eng, &master, 1, &clip, 1, 0.0, 120.0) == 0, "load layered plan failed");

    // 1. Initially tile 0 is uncooked -> must serve raw disk stream (~0.25f) with ZERO heap allocs in process()
    std::vector<float> out_l(256), out_r(256);
    g_trapped_count.store(0, std::memory_order_relaxed);
    g_trap_allocs.store(true, std::memory_order_release);
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    g_trap_allocs.store(false, std::memory_order_release);
    CHECK(g_trapped_count.load() == 0, "ZERO heap allocs allowed during raw layered fallback");
    CHECK(std::abs(out_l[128] - 0.25f) < 0.01f, "uncooked tile must fall back cleanly to raw disk audio");

    // 2. Publish tile 0 atomically WITHOUT reloading plan -> next block serves cooked tile (~0.75f) with ZERO allocs!
    std::vector<float> tile0_l(tile_frames, 0.75f);
    std::vector<float> tile0_r(tile_frames, -0.50f);
    CHECK(sin_engine_set_layered_tile(eng, 50, 0, tile0_l.data(), tile0_r.data(), tile_frames, 1) == 0,
          "set layered tile 0 failed");

    g_trapped_count.store(0, std::memory_order_relaxed);
    g_trap_allocs.store(true, std::memory_order_release);
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    g_trap_allocs.store(false, std::memory_order_release);
    CHECK(g_trapped_count.load() == 0, "ZERO heap allocs allowed during cooked layered playback");
    CHECK(std::abs(out_l[128] - 0.75f) < 1e-4f, "published tile 0 L must override raw immediately");
    CHECK(std::abs(out_r[128] - (-0.50f)) < 1e-4f, "published tile 0 R must override raw immediately");

    // 3. Evict tile 0 back to nullptr -> seamlessly reverts to raw disk audio (~0.25f)
    CHECK(sin_engine_set_layered_tile(eng, 50, 0, nullptr, nullptr, 0, 0) == 0, "evict layered tile 0 failed");
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    CHECK(std::abs(out_l[128] - 0.25f) < 0.01f, "evicted tile 0 must revert cleanly to raw disk audio");

    sin_engine_release_all_sources(eng);
    sin_engine_destroy(eng);
    fs::remove(wav_path, ec);
    fs::remove(tmp_dir, ec);
    return 0;
}

static int test_layered_tile_time_stretched_unity_tile_read() {
    namespace fs = std::filesystem;
    const fs::path tmp_dir = fs::temp_directory_path() / "sin_dsp_stretched_tile_test";
    std::error_code ec;
    fs::create_directories(tmp_dir, ec);
    const fs::path wav_path = tmp_dir / "stretched_base.wav";

    const uint32_t sr = 8000;
    const uint32_t raw_frames = 8000;   // 1.0s raw file
    const float tempo_rate = 2.0f;      // 2x faster => 0.5s (4000 frames) stretched output
    const uint32_t out_frames = 4000;
    const uint32_t tile_frames = 2000;  // 2 tiles covering 4000 stretched frames
    const uint32_t num_tiles = 2;

    std::vector<float> base_samples(raw_frames, 0.20f);
    CHECK(write_wav_pcm16(wav_path, base_samples, sr), "write stretched base wav failed");

    SinEngineConfig cfg{sr, 256, 1};
    SinEngine* eng = sin_engine_create(&cfg);
    CHECK(eng != nullptr, "stretched layered engine create failed");

    const std::string path_str = wav_path.string();
    CHECK(sin_engine_register_layered_source(eng, 51, path_str.c_str(), tile_frames, num_tiles, sr, out_frames) == 0,
          "register stretched layered source failed");

    SinBusDesc master{1, 0, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, tempo_rate, 0, 0, {0, 0}};
    SinClipDesc clip{};
    clip.clip_id = 1;
    clip.source_id = 51;
    clip.target_bus_id = 1;
    clip.source_start_ratio = 0.0;
    clip.source_end_ratio = 1.0;
    clip.gain = 1.0f;
    clip.playback_rate = 1.0f;
    clip.flags = SIN_CLIP_LIVE_RATE_BOUND | SIN_CLIP_TILE_TIME_STRETCHED;
    CHECK(sin_engine_load_plan(eng, &master, 1, &clip, 1, 0.0, 120.0) == 0, "load stretched layered plan failed");

    // Stretched duration must equal raw_dur / tempo_rate = 0.5s
    SinTelemetry tel{};
    sin_engine_read_telemetry(eng, &tel, nullptr, 0, nullptr, 0);
    CHECK(std::abs(tel.duration_seconds - 0.5) < 1e-3, "stretched clip duration must be 0.5s");

    // Publish tile 0 with a linear ramp [0 .. 1) across 2000 stretched output frames.
    // With SIN_CLIP_TILE_TIME_STRETCHED, reading 256 engine frames at playback_rate=2.0
    // MUST advance tile_pos at unity speed (frame i -> ramp[i], NOT ramp[2*i])!
    std::vector<float> ramp_l(tile_frames), ramp_r(tile_frames);
    for (uint32_t i = 0; i < tile_frames; ++i) {
        ramp_l[i] = static_cast<float>(i) / static_cast<float>(tile_frames);
        ramp_r[i] = -ramp_l[i];
    }
    CHECK(sin_engine_set_layered_tile(eng, 51, 0, ramp_l.data(), ramp_r.data(), tile_frames, 1) == 0,
          "set stretched tile 0 failed");

    std::vector<float> out_l(256), out_r(256);
    g_trapped_count.store(0, std::memory_order_relaxed);
    g_trap_allocs.store(true, std::memory_order_release);
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    g_trap_allocs.store(false, std::memory_order_release);
    CHECK(g_trapped_count.load() == 0, "ZERO heap allocs allowed during stretched tile read");

    const float expected_at_100 = 100.0f / static_cast<float>(tile_frames);
    CHECK(std::abs(out_l[100] - expected_at_100) < 1e-4f,
          "stretched tile must read at unity output rate (frame 100 -> tile[100])");
    CHECK(std::abs(out_r[100] - (-expected_at_100)) < 1e-4f,
          "stretched tile R channel must match unity output rate");

    // Tile 1 is uncooked -> seeking into second half (0.25s = 2000 engine frames) must fall back to raw (0.20f)
    sin_engine_set_transport(eng, 1, 0.25, 120.0, 0.0, 0.0, 0);
    sin_engine_process(eng, out_l.data(), out_r.data(), 256);
    CHECK(std::abs(out_l[128] - 0.20f) < 0.01f, "uncooked stretched tile 1 must fall back to raw beat-locked varispeed");

    sin_engine_release_all_sources(eng);
    sin_engine_destroy(eng);
    fs::remove(wav_path, ec);
    fs::remove(tmp_dir, ec);
    return 0;
}

int main() {
    if (test_default_sr_and_unity_passthrough() != 0) return 1;
    if (test_resampling_and_bus_solo_mute() != 0) return 1;
    if (test_disk_streaming_and_windows_non_locking_vfs() != 0) return 1;
    if (test_fades_release_and_looping() != 0) return 1;
    if (test_monotonic_seek_telemetry_and_declick_crossfade() != 0) return 1;
    if (test_dsp_processor_gain_chain() != 0) return 1;
    if (test_multi_producer_cmd_and_live_crop_seek() != 0) return 1;
    if (test_per_bus_rms_and_rt_peak_hold() != 0) return 1;
    if (test_fx_modules_serial_chain_and_meters() != 0) return 1;
    if (test_layered_tile_streamer_zero_alloc_and_fallback() != 0) return 1;
    if (test_layered_tile_time_stretched_unity_tile_read() != 0) return 1;
    std::printf("ALL sin_dsp C++ TESTS PASSED!\n");
    return 0;
}

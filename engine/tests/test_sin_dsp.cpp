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

int main() {
    if (test_default_sr_and_unity_passthrough() != 0) return 1;
    if (test_resampling_and_bus_solo_mute() != 0) return 1;
    if (test_disk_streaming_and_windows_non_locking_vfs() != 0) return 1;
    if (test_fades_release_and_looping() != 0) return 1;
    if (test_monotonic_seek_telemetry_and_declick_crossfade() != 0) return 1;
    if (test_dsp_processor_gain_chain() != 0) return 1;
    if (test_multi_producer_cmd_and_live_crop_seek() != 0) return 1;
    std::printf("ALL sin_dsp C++ TESTS PASSED!\n");
    return 0;
}

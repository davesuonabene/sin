#include "../include/sin_dsp.h"
#include "dsp_processor.hpp"
#include "platform_vfs.hpp"
#include "resampler.hpp"
#include "smoother.hpp"
#include "source_pool.hpp"
#include "spsc_ring.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

namespace sin_dsp {

struct BusStage {
    uint32_t stage_index = 0;
    std::unique_ptr<DspProcessor> processor;
    bool enabled = true;
};

struct BusState {
    SinBusId bus_id = 0;
    SinBusId parent_bus_id = 0;
    int32_t  parent_index = -1;

    // Raw target parameters
    float pre_gain_db = 0.0f;
    float volume = 1.0f;
    float post_gain_db = 0.0f;
    float pan = 0.0f;
    float crop_start = 0.0f;
    float crop_end = 1.0f;
    float playback_rate = 1.0f;
    bool  muted = false;
    bool  solo = false;

    // Smoothed audio-thread parameters
    ParamSmoother pre_gain_sm;
    ParamSmoother vol_sm;
    ParamSmoother post_gain_sm;
    ParamSmoother pan_l_sm;
    ParamSmoother pan_r_sm;
    ParamSmoother mute_sm;

    // Ordered In -> Out DSP processor chain (allocated on load_plan, never in process())
    std::vector<BusStage> stages;

    // Atomic live overrides mirrored for disk-stream seek hinting
    std::atomic<float> live_crop_start{0.0f};
    std::atomic<float> live_playback_rate{1.0f};

    // Pre-allocated stereo block scratch buffers (allocated on load_plan, never in process())
    std::vector<float> buf_l;
    std::vector<float> buf_r;

    // Telemetry peak (written by audio thread, read by UI thread)
    std::atomic<float> peak{0.0f};
};

struct ClipState {
    SinClipDesc desc{};
    int32_t target_bus_index = -1;
    std::shared_ptr<const PcmBuffer> ram_pcm;
    std::unique_ptr<DiskStreamReader> stream_reader;
    uint32_t src_sample_rate = SIN_DEFAULT_SAMPLE_RATE;
    uint64_t src_total_frames = 0;
    bool     is_streaming = false;
    bool     was_starved = false;
};

struct CompiledPlan {
    uint64_t epoch = 0;
    std::vector<std::unique_ptr<BusState>> buses; // bottom-up topological order; master root last
    std::vector<ClipState> clips;
    int64_t explicit_duration_frames = 0; // <= 0 => "auto"
    int64_t auto_duration_frames = 0;
    double  bpm = 120.0;
    bool    has_streaming_clips = false;

    int32_t find_bus_index(SinBusId id) const noexcept {
        for (size_t i = 0; i < buses.size(); ++i) {
            if (buses[i]->bus_id == id) return static_cast<int32_t>(i);
        }
        return -1;
    }

    int64_t effective_duration_frames() const noexcept {
        return explicit_duration_frames > 0 ? explicit_duration_frames : auto_duration_frames;
    }

    void recompute_auto_duration(uint32_t engine_sr) noexcept {
        int64_t max_end = 0;
        for (const auto& clip : clips) {
            if (clip.target_bus_index < 0 || clip.src_total_frames == 0) continue;
            const BusState& bus = *buses[static_cast<size_t>(clip.target_bus_index)];
            const double cs = std::clamp(
                (clip.desc.flags & SIN_CLIP_LIVE_CROP_BOUND) ? static_cast<double>(bus.crop_start) : clip.desc.source_start_ratio,
                0.0, 1.0);
            const double ce = std::clamp(
                (clip.desc.flags & SIN_CLIP_LIVE_CROP_BOUND) ? static_cast<double>(bus.crop_end) : clip.desc.source_end_ratio,
                cs, 1.0);
            const int64_t win_start = static_cast<int64_t>(std::floor(cs * static_cast<double>(clip.src_total_frames)));
            const int64_t win_end   = std::min<int64_t>(static_cast<int64_t>(clip.src_total_frames),
                                                        static_cast<int64_t>(std::ceil(ce * static_cast<double>(clip.src_total_frames))));
            const int64_t win_len   = std::max<int64_t>(0, win_end - win_start);
            if (win_len <= 0) continue;

            const double bus_rate = (clip.desc.flags & SIN_CLIP_LIVE_RATE_BOUND) ? static_cast<double>(bus.playback_rate) : 1.0;
            const double base_rate = clip.desc.playback_rate > 1e-4f ? static_cast<double>(clip.desc.playback_rate) : 1.0;
            const double sr_ratio = (engine_sr > 0 && clip.src_sample_rate > 0)
                                    ? (static_cast<double>(clip.src_sample_rate) / static_cast<double>(engine_sr))
                                    : 1.0;
            const double eff_rate = std::max(1e-4, base_rate * bus_rate * sr_ratio);
            const int64_t nat_len = static_cast<int64_t>(std::ceil(static_cast<double>(win_len) / eff_rate));

            const int64_t t0 = (clip.desc.flags & SIN_CLIP_CROP_IN_PLACE)
                               ? (clip.desc.timeline_start_frame + static_cast<int64_t>(std::floor(static_cast<double>(win_start) / eff_rate)))
                               : clip.desc.timeline_start_frame;
            const int64_t len = (clip.desc.timeline_length_frames > 0) ? clip.desc.timeline_length_frames : nat_len;
            const int64_t end_f = t0 + len;
            if (end_f > max_end) max_end = end_f;
        }
        auto_duration_frames = max_end;
    }
};

enum class CmdKind : uint8_t {
    SetParam = 1,
    SetTransport = 2,
    SetAudition = 3,
    ResetPlayhead = 4,
    SetStageParam = 5,
    SetStageEnabled = 6,
};

struct EngineCommand {
    CmdKind kind = CmdKind::SetParam;
    SinBusId bus_id = 0;
    uint16_t param_id = 0;
    uint32_t stage_index = 0;
    uint32_t param_index = 0;
    float value = 0.0f;
    float ramp_ms = 5.0f;

    uint32_t playing = 0;
    uint32_t loop_enabled = 0;
    uint32_t active = 0;
    double seek_sec = -1.0;
    double bpm = 0.0;
    double start_sec = 0.0;
    double end_sec = 0.0;
    uint64_t transport_gen = 0;
};

struct BusTapSlot {
    SinBusId bus_id = 0;
    float* tap_l = nullptr;
    float* tap_r = nullptr;
    uint32_t capacity = 0;
    uint32_t written = 0;
    bool active = false;
};

} // namespace sin_dsp

struct SinEngine {
    uint32_t sample_rate = SIN_DEFAULT_SAMPLE_RATE;
    uint32_t max_block_size = 1024;
    bool offline_mode = false;

    // Control-thread owned state
    std::mutex control_mutex;
    sin_dsp::SourcePool source_pool;
    uint64_t next_epoch = 1;
    std::vector<std::shared_ptr<sin_dsp::CompiledPlan>> owned_plans;

    // Lock-free plan handoff (control -> audio)
    std::atomic<sin_dsp::CompiledPlan*> pending_plan{nullptr};
    sin_dsp::CompiledPlan* active_plan = nullptr; // Audio-thread owned pointer (lifetime guaranteed by owned_plans)
    std::atomic<uint64_t> active_epoch{0};

    // Lock-free command queue (control -> audio); multi-producer serialized on control thread
    std::mutex cmd_push_mutex;
    sin_dsp::SpscRing<sin_dsp::EngineCommand, 1024> cmd_ring;

    // Audio-thread transport & audition state
    int64_t playhead_frame = 0;
    bool    is_playing = false;
    bool    loop_enabled = false;
    int64_t loop_start_frame = 0;
    int64_t loop_end_frame = 0;
    double  bpm = 120.0;

    bool     audition_active = false;
    SinBusId audition_solo_bus = 0;
    int64_t  audition_start_frame = 0;
    int64_t  audition_end_frame = 0;

    // Click-free swap/seek/pause overlap crossfade state (RT mode only)
    sin_dsp::ParamSmoother swap_fade;
    float last_out_l = 0.0f;
    float last_out_r = 0.0f;
    float declick_l = 0.0f;
    float declick_r = 0.0f;
    float declick_env = 0.0f;
    float declick_step = 0.0f;

    // Monotonic transport generation: prevents stale audio-thread telemetry from snapping back a fresh seek
    std::atomic<uint64_t> desired_transport_gen{0};
    uint64_t applied_transport_gen = 0;

    // Offline bus taps (pre-allocated fixed table — zero alloc in process())
    std::array<sin_dsp::BusTapSlot, 64> bus_taps{};

    // Device scratch buffers (pre-allocated for miniaudio callback)
    std::vector<float> device_scratch_l;
    std::vector<float> device_scratch_r;

    // Telemetry snapshot (atomics / double-buffered)
    std::atomic<double>   tel_playhead_sec{0.0};
    std::atomic<double>   tel_duration_sec{0.0};
    std::atomic<double>   tel_bpm{120.0};
    std::atomic<uint32_t> tel_is_playing{0};
    std::atomic<uint32_t> tel_loop_enabled{0};
    std::atomic<uint32_t> tel_audition_active{0};
    std::atomic<uint32_t> tel_bus_count{0};
    std::atomic<float>    tel_peak_l{0.0f};
    std::atomic<float>    tel_peak_r{0.0f};
    std::atomic<float>    tel_rms_l{0.0f};
    std::atomic<float>    tel_rms_r{0.0f};
    std::array<std::atomic<uint32_t>, SIN_MAX_BUSES> tel_bus_ids{};
    std::array<std::atomic<float>, SIN_MAX_BUSES>    tel_bus_peaks{};
    std::array<std::atomic<float>, SIN_MAX_SCOPE_SAMPLES> tel_scope{};

    // Background disk streaming thread (RT mode only; never locks audio thread)
    std::mutex disk_mutex;
    std::condition_variable disk_cv;
    bool disk_wake_pending = false;
    std::shared_ptr<sin_dsp::CompiledPlan> disk_plan;
    std::atomic<bool> disk_thread_stop{false};
    std::thread disk_thread;

    // miniaudio playback device
    ma_device device{};
    bool device_initialized = false;
    std::atomic<bool> device_running{false};

    void trigger_declick(float fade_ms = 4.0f) noexcept {
        if (offline_mode) {
            swap_fade.snap(1.0f);
            declick_env = 0.0f;
            return;
        }
        declick_l = last_out_l;
        declick_r = last_out_r;
        const float samples = std::max(1.0f, (fade_ms * 0.001f) * static_cast<float>(sample_rate > 0 ? sample_rate : SIN_DEFAULT_SAMPLE_RATE));
        declick_step = 1.0f / samples;
        declick_env = (std::abs(declick_l) > 1e-6f || std::abs(declick_r) > 1e-6f) ? 1.0f : 0.0f;
        swap_fade.snap(0.0f);
        swap_fade.set_target(1.0f, fade_ms, sample_rate);
    }

    /* Serialize control-thread writes into SPSC cmd_ring (RT audio thread never locks cmd_push_mutex). */
    void dispatch_control_command(const sin_dsp::EngineCommand& cmd) {
        std::lock_guard<std::mutex> lk(cmd_push_mutex);
        if (offline_mode || !device_running.load(std::memory_order_acquire)) {
            apply_command_audio(cmd);
        } else {
            cmd_ring.push(cmd);
        }
    }

    /* Mirror live crop/rate onto disk_plan so seek pre-warming sees pending UI tweaks before RT drains cmd_ring. */
    void mirror_live_bus_override(SinBusId bus_id, uint16_t param_id, float value) {
        if (offline_mode) return;
        std::lock_guard<std::mutex> lk(disk_mutex);
        if (!disk_plan) return;
        const int32_t idx = disk_plan->find_bus_index(bus_id);
        if (idx < 0) return;
        auto& b = *disk_plan->buses[static_cast<size_t>(idx)];
        if (param_id == SIN_PARAM_CROP_START) {
            b.live_crop_start.store(std::clamp(value, 0.0f, 1.0f), std::memory_order_relaxed);
        } else if (param_id == SIN_PARAM_PLAYBACK_RATE) {
            b.live_playback_rate.store(std::max(0.05f, value), std::memory_order_relaxed);
        }
    }

    /* Hint streaming clips around seek_sec and wake the disk thread immediately (<0.2ms). Control thread only. */
    void wake_disk_thread_for_seek(double seek_sec) {
        if (offline_mode) return;
        {
            std::lock_guard<std::mutex> lk(disk_mutex);
            if (disk_plan && disk_plan->has_streaming_clips && seek_sec >= 0.0) {
                const int64_t target_tf = static_cast<int64_t>(std::llround(seek_sec * static_cast<double>(sample_rate)));
                for (auto& clip : disk_plan->clips) {
                    if (!clip.is_streaming || !clip.stream_reader || clip.src_total_frames == 0) continue;
                    const sin_dsp::BusState* bus = (clip.target_bus_index >= 0 && static_cast<size_t>(clip.target_bus_index) < disk_plan->buses.size())
                        ? disk_plan->buses[static_cast<size_t>(clip.target_bus_index)].get()
                        : nullptr;
                    const double sr_ratio = (sample_rate > 0 && clip.src_sample_rate > 0)
                        ? (static_cast<double>(clip.src_sample_rate) / static_cast<double>(sample_rate))
                        : 1.0;
                    const double base_rate = clip.desc.playback_rate > 1e-4f ? static_cast<double>(clip.desc.playback_rate) : 1.0;
                    const double live_rate = (bus && (clip.desc.flags & SIN_CLIP_LIVE_RATE_BOUND))
                        ? static_cast<double>(bus->live_playback_rate.load(std::memory_order_relaxed))
                        : 1.0;
                    const double eff_rate = std::max(1e-4, base_rate * live_rate * sr_ratio);
                    const double raw_cs = (bus && (clip.desc.flags & SIN_CLIP_LIVE_CROP_BOUND))
                        ? static_cast<double>(bus->live_crop_start.load(std::memory_order_relaxed))
                        : clip.desc.source_start_ratio;
                    const double cs = std::clamp(raw_cs, 0.0, 1.0);
                    const int64_t src_win_start = static_cast<int64_t>(std::floor(cs * static_cast<double>(clip.src_total_frames)));
                    const int64_t clip_t0 = (clip.desc.flags & SIN_CLIP_CROP_IN_PLACE)
                        ? (clip.desc.timeline_start_frame + static_cast<int64_t>(std::floor(static_cast<double>(src_win_start) / eff_rate)))
                        : clip.desc.timeline_start_frame;
                    const int64_t rel_tf = std::max<int64_t>(0, target_tf - clip_t0);
                    const int64_t est_src = std::min<int64_t>(
                        static_cast<int64_t>(clip.src_total_frames > 0 ? clip.src_total_frames - 1 : 0),
                        src_win_start + static_cast<int64_t>(std::llround(static_cast<double>(rel_tf) * eff_rate)));
                    clip.stream_reader->set_hint_cursor(est_src);
                }
            }
            disk_wake_pending = true;
        }
        disk_cv.notify_one();
    }

    void start_disk_thread_if_needed() {
        if (offline_mode || disk_thread.joinable()) return;
        disk_thread_stop.store(false, std::memory_order_release);
        disk_thread = std::thread([this]() {
            while (!disk_thread_stop.load(std::memory_order_acquire)) {
                std::shared_ptr<sin_dsp::CompiledPlan> plan;
                {
                    std::unique_lock<std::mutex> lk(disk_mutex);
                    if (!disk_wake_pending) {
                        const auto wait_ms = (disk_plan && disk_plan->has_streaming_clips)
                            ? std::chrono::milliseconds(4)
                            : std::chrono::milliseconds(16);
                        disk_cv.wait_for(lk, wait_ms, [&]() {
                            return disk_wake_pending || disk_thread_stop.load(std::memory_order_acquire);
                        });
                    }
                    disk_wake_pending = false;
                    plan = disk_plan;
                }
                if (disk_thread_stop.load(std::memory_order_acquire)) break;
                if (plan && plan->has_streaming_clips) {
                    // Service misses first with fast bursts, then progressively top up prefetch
                    for (int pass = 0; pass < 3; ++pass) {
                        bool any_work = false;
                        for (auto& clip : plan->clips) {
                            if (clip.is_streaming && clip.stream_reader && clip.stream_reader->needs_service()) {
                                clip.stream_reader->service_disk(false);
                                any_work = true;
                            }
                        }
                        if (!any_work || disk_thread_stop.load(std::memory_order_acquire)) break;
                    }
                }
            }
        });
    }

    void stop_disk_thread() {
        if (disk_thread.joinable()) {
            disk_thread_stop.store(true, std::memory_order_release);
            {
                std::lock_guard<std::mutex> lk(disk_mutex);
                disk_wake_pending = true;
            }
            disk_cv.notify_all();
            disk_thread.join();
        }
    }

    /* Safely destroy plans no longer referenced by the audio callback (control thread only). */
    void gc_retired_plans_locked() {
        const uint64_t live = active_epoch.load(std::memory_order_acquire);
        const sin_dsp::CompiledPlan* pend = pending_plan.load(std::memory_order_acquire);
        owned_plans.erase(
            std::remove_if(owned_plans.begin(), owned_plans.end(),
                [&](const std::shared_ptr<sin_dsp::CompiledPlan>& p) {
                    if (!p) return true;
                    if (p.get() == pend) return false;
                    if (p->epoch >= live) return false;
                    // Only retire once audio thread has definitely moved to a newer epoch
                    return true;
                }),
            owned_plans.end()
        );
    }

    void recompute_mutes_audio(sin_dsp::CompiledPlan& plan, float ramp_ms) noexcept {
        const size_t n = plan.buses.size();
        if (n == 0) return;

        bool direct_solo[SIN_MAX_BUSES] = {};
        bool has_solo_desc[SIN_MAX_BUSES] = {};
        bool has_solo_anc[SIN_MAX_BUSES] = {};
        bool any_solo = false;

        const bool use_audition_solo = audition_active && audition_solo_bus != 0;
        for (size_t i = 0; i < n && i < SIN_MAX_BUSES; ++i) {
            const auto& b = *plan.buses[i];
            if (use_audition_solo) {
                direct_solo[i] = (b.bus_id == audition_solo_bus);
            } else {
                direct_solo[i] = b.solo;
            }
            if (direct_solo[i]) any_solo = true;
        }

        if (any_solo) {
            // Bottom-up: propagate to ancestors so soloed leaf buses flow up through parent groups/master
            for (size_t i = 0; i < n && i < SIN_MAX_BUSES; ++i) {
                if (direct_solo[i] || has_solo_desc[i]) {
                    int32_t p = plan.buses[i]->parent_index;
                    if (p >= 0 && static_cast<size_t>(p) < SIN_MAX_BUSES) {
                        has_solo_desc[static_cast<size_t>(p)] = true;
                    }
                }
            }
            // Top-down: propagate to descendants so soloing a group bus includes its children
            for (size_t rev = n; rev > 0; --rev) {
                const size_t i = rev - 1;
                if (i >= SIN_MAX_BUSES) continue;
                int32_t p = plan.buses[i]->parent_index;
                if (p >= 0 && static_cast<size_t>(p) < SIN_MAX_BUSES &&
                    (direct_solo[static_cast<size_t>(p)] || has_solo_anc[static_cast<size_t>(p)])) {
                    has_solo_anc[i] = true;
                }
            }
        }

        const float eff_ramp = offline_mode ? 0.0f : ramp_ms;
        for (size_t i = 0; i < n && i < SIN_MAX_BUSES; ++i) {
            auto& b = *plan.buses[i];
            bool eff_muted = false;
            if (use_audition_solo) {
                eff_muted = !(direct_solo[i] || has_solo_desc[i] || has_solo_anc[i]);
            } else if (any_solo) {
                if (direct_solo[i] || has_solo_desc[i]) {
                    // Solo always bypasses mute on the soloed bus and its parent routing path.
                    eff_muted = false;
                } else if (has_solo_anc[i]) {
                    eff_muted = b.muted;
                } else {
                    eff_muted = true;
                }
            } else {
                eff_muted = b.muted;
            }
            b.mute_sm.set_target(eff_muted ? 0.0f : 1.0f, eff_ramp, sample_rate);
        }
    }

    void apply_command_audio(const sin_dsp::EngineCommand& cmd) noexcept {
        switch (cmd.kind) {
            case sin_dsp::CmdKind::SetParam: {
                if (!active_plan) return;
                const int32_t idx = active_plan->find_bus_index(cmd.bus_id);
                if (idx < 0) return;
                auto& b = *active_plan->buses[static_cast<size_t>(idx)];
                const float r = offline_mode ? 0.0f : std::max(0.0f, cmd.ramp_ms);
                switch (cmd.param_id) {
                    case SIN_PARAM_PRE_GAIN_DB:
                        b.pre_gain_db = cmd.value;
                        b.pre_gain_sm.set_target(sin_dsp::db_to_linear(cmd.value), r, sample_rate);
                        break;
                    case SIN_PARAM_VOLUME:
                        b.volume = std::max(0.0f, cmd.value);
                        b.vol_sm.set_target(b.volume, r, sample_rate);
                        break;
                    case SIN_PARAM_POST_GAIN_DB:
                        b.post_gain_db = cmd.value;
                        b.post_gain_sm.set_target(sin_dsp::db_to_linear(cmd.value), r, sample_rate);
                        break;
                    case SIN_PARAM_PAN: {
                        b.pan = std::clamp(cmd.value, -1.0f, 1.0f);
                        float pl = 1.0f, pr = 1.0f;
                        sin_dsp::pan_gains(b.pan, pl, pr);
                        b.pan_l_sm.set_target(pl, r, sample_rate);
                        b.pan_r_sm.set_target(pr, r, sample_rate);
                        break;
                    }
                    case SIN_PARAM_MUTE:
                        b.muted = (cmd.value >= 0.5f);
                        recompute_mutes_audio(*active_plan, r > 0.0f ? r : 5.0f);
                        break;
                    case SIN_PARAM_SOLO:
                        b.solo = (cmd.value >= 0.5f);
                        recompute_mutes_audio(*active_plan, r > 0.0f ? r : 5.0f);
                        break;
                    case SIN_PARAM_CROP_START:
                        b.crop_start = std::clamp(cmd.value, 0.0f, b.crop_end);
                        b.live_crop_start.store(b.crop_start, std::memory_order_relaxed);
                        active_plan->recompute_auto_duration(sample_rate);
                        tel_duration_sec.store(
                            static_cast<double>(active_plan->effective_duration_frames()) / static_cast<double>(sample_rate),
                            std::memory_order_relaxed);
                        break;
                    case SIN_PARAM_CROP_END:
                        b.crop_end = std::clamp(cmd.value, b.crop_start, 1.0f);
                        active_plan->recompute_auto_duration(sample_rate);
                        tel_duration_sec.store(
                            static_cast<double>(active_plan->effective_duration_frames()) / static_cast<double>(sample_rate),
                            std::memory_order_relaxed);
                        break;
                    case SIN_PARAM_PLAYBACK_RATE:
                        b.playback_rate = std::max(0.05f, cmd.value);
                        b.live_playback_rate.store(b.playback_rate, std::memory_order_relaxed);
                        active_plan->recompute_auto_duration(sample_rate);
                        tel_duration_sec.store(
                            static_cast<double>(active_plan->effective_duration_frames()) / static_cast<double>(sample_rate),
                            std::memory_order_relaxed);
                        break;
                    default:
                        break;
                }
                break;
            }
            case sin_dsp::CmdKind::SetStageParam: {
                if (!active_plan) return;
                const int32_t idx = active_plan->find_bus_index(cmd.bus_id);
                if (idx < 0) return;
                auto& b = *active_plan->buses[static_cast<size_t>(idx)];
                const float r = offline_mode ? 0.0f : std::max(0.0f, cmd.ramp_ms);
                for (auto& st : b.stages) {
                    if (st.stage_index == cmd.stage_index && st.processor) {
                        st.processor->set_param(cmd.param_index, cmd.value, r);
                        break;
                    }
                }
                break;
            }
            case sin_dsp::CmdKind::SetStageEnabled: {
                if (!active_plan) return;
                const int32_t idx = active_plan->find_bus_index(cmd.bus_id);
                if (idx < 0) return;
                auto& b = *active_plan->buses[static_cast<size_t>(idx)];
                for (auto& st : b.stages) {
                    if (st.stage_index == cmd.stage_index) {
                        st.enabled = (cmd.value >= 0.5f);
                        break;
                    }
                }
                break;
            }
            case sin_dsp::CmdKind::SetTransport: {
                if (cmd.transport_gen > applied_transport_gen) {
                    applied_transport_gen = cmd.transport_gen;
                }
                const bool was_playing = is_playing;
                is_playing = (cmd.playing != 0);
                if (cmd.bpm > 1.0) bpm = cmd.bpm;
                bool jumped = false;
                if (cmd.seek_sec >= 0.0) {
                    const int64_t next_frame = static_cast<int64_t>(std::llround(cmd.seek_sec * static_cast<double>(sample_rate)));
                    jumped = (next_frame != playhead_frame);
                    playhead_frame = next_frame;
                }
                if (jumped || (was_playing != is_playing)) {
                    trigger_declick(4.0f);
                }
                loop_enabled = (cmd.loop_enabled != 0);
                loop_start_frame = cmd.start_sec > 0.0 ? static_cast<int64_t>(std::llround(cmd.start_sec * static_cast<double>(sample_rate))) : 0;
                loop_end_frame   = cmd.end_sec > 0.0 ? static_cast<int64_t>(std::llround(cmd.end_sec * static_cast<double>(sample_rate))) : 0;
                if (!is_playing && audition_active) {
                    audition_active = false;
                    if (active_plan) recompute_mutes_audio(*active_plan, 5.0f);
                }
                break;
            }
            case sin_dsp::CmdKind::SetAudition: {
                if (cmd.transport_gen > applied_transport_gen) {
                    applied_transport_gen = cmd.transport_gen;
                }
                audition_active = (cmd.active != 0);
                audition_solo_bus = cmd.bus_id;
                audition_start_frame = std::max<int64_t>(0, static_cast<int64_t>(std::llround(cmd.start_sec * static_cast<double>(sample_rate))));
                audition_end_frame   = std::max<int64_t>(audition_start_frame, static_cast<int64_t>(std::llround(cmd.end_sec * static_cast<double>(sample_rate))));
                if (audition_active) {
                    playhead_frame = audition_start_frame;
                    is_playing = true;
                } else {
                    is_playing = false;
                }
                trigger_declick(4.0f);
                if (active_plan) recompute_mutes_audio(*active_plan, 4.0f);
                break;
            }
            case sin_dsp::CmdKind::ResetPlayhead: {
                if (cmd.transport_gen > applied_transport_gen) {
                    applied_transport_gen = cmd.transport_gen;
                }
                playhead_frame = 0;
                is_playing = false;
                audition_active = false;
                trigger_declick(4.0f);
                if (active_plan) recompute_mutes_audio(*active_plan, 0.0f);
                break;
            }
        }
    }

    void process_block(float* out_l, float* out_r, uint32_t num_frames) noexcept {
        if (!out_l || !out_r || num_frames == 0) return;

        // 1. Check for pending plan swap (lock-free, zero alloc, zero delete)
        sin_dsp::CompiledPlan* incoming = pending_plan.exchange(nullptr, std::memory_order_acq_rel);
        if (incoming) {
            active_plan = incoming;
            active_epoch.store(incoming->epoch, std::memory_order_release);
            if (incoming->bpm > 1.0) bpm = incoming->bpm;
            recompute_mutes_audio(*active_plan, 0.0f);
            trigger_declick(5.0f);
        }

        // 2. Drain pending control commands
        sin_dsp::EngineCommand cmd;
        while (cmd_ring.pop(cmd)) {
            apply_command_audio(cmd);
        }

        // Clear output initially
        std::memset(out_l, 0, sizeof(float) * num_frames);
        std::memset(out_r, 0, sizeof(float) * num_frames);

        sin_dsp::CompiledPlan* plan = active_plan;
        if (!plan || plan->buses.empty()) {
            tel_is_playing.store(is_playing ? 1u : 0u, std::memory_order_relaxed);
            tel_peak_l.store(0.0f, std::memory_order_relaxed);
            tel_peak_r.store(0.0f, std::memory_order_relaxed);
            tel_rms_l.store(0.0f, std::memory_order_relaxed);
            tel_rms_r.store(0.0f, std::memory_order_relaxed);
            return;
        }

        const int64_t total_dur_frames = plan->effective_duration_frames();
        const double inv_sr = sample_rate > 0 ? (1.0 / static_cast<double>(sample_rate)) : (1.0 / 48000.0);

        if (!offline_mode && !is_playing) {
            // Smooth 4ms micro-tail fade-out on pause so stopping never clicks!
            if (declick_env > 0.0f) {
                for (uint32_t i = 0; i < num_frames && declick_env > 0.0f; ++i) {
                    const float l = declick_l * declick_env;
                    const float r = declick_r * declick_env;
                    out_l[i] = l;
                    out_r[i] = r;
                    last_out_l = l;
                    last_out_r = r;
                    declick_env = std::max(0.0f, declick_env - declick_step);
                }
                if (declick_env <= 0.0f) {
                    last_out_l = 0.0f;
                    last_out_r = 0.0f;
                }
            } else {
                last_out_l = 0.0f;
                last_out_r = 0.0f;
            }
            const bool tel_synced = applied_transport_gen >= desired_transport_gen.load(std::memory_order_acquire);
            if (tel_synced) {
                tel_playhead_sec.store(static_cast<double>(playhead_frame) * inv_sr, std::memory_order_relaxed);
                tel_is_playing.store(0u, std::memory_order_relaxed);
            }
            tel_duration_sec.store(static_cast<double>(total_dur_frames) * inv_sr, std::memory_order_relaxed);
            tel_bpm.store(bpm, std::memory_order_relaxed);
            tel_loop_enabled.store(loop_enabled ? 1u : 0u, std::memory_order_relaxed);
            tel_audition_active.store(audition_active ? 1u : 0u, std::memory_order_relaxed);
            tel_peak_l.store(0.0f, std::memory_order_relaxed);
            tel_peak_r.store(0.0f, std::memory_order_relaxed);
            tel_rms_l.store(0.0f, std::memory_order_relaxed);
            tel_rms_r.store(0.0f, std::memory_order_relaxed);
            const size_t bc = std::min<size_t>(plan->buses.size(), SIN_MAX_BUSES);
            tel_bus_count.store(static_cast<uint32_t>(bc), std::memory_order_relaxed);
            for (size_t i = 0; i < bc; ++i) {
                tel_bus_ids[i].store(plan->buses[i]->bus_id, std::memory_order_relaxed);
                tel_bus_peaks[i].store(0.0f, std::memory_order_relaxed);
            }
            return;
        }

        // Process in chunks <= max_block_size (never exceeds pre-allocated bus scratch buffers)
        uint32_t offset = 0;
        float block_peak_l = 0.0f, block_peak_r = 0.0f;
        double block_sum_sq_l = 0.0, block_sum_sq_r = 0.0;

        while (offset < num_frames) {
            const uint32_t n = std::min(max_block_size, num_frames - offset);
            const int64_t block_start_frame = playhead_frame;

            // 3. Clear bus scratch buffers
            for (auto& bus_ptr : plan->buses) {
                std::memset(bus_ptr->buf_l.data(), 0, sizeof(float) * n);
                std::memset(bus_ptr->buf_r.data(), 0, sizeof(float) * n);
            }

            // Determine active loop window for real-time playhead wrap
            int64_t eff_loop_start = 0;
            int64_t eff_loop_end = 0;
            bool eff_loop = false;
            if (!offline_mode) {
                if (audition_active && audition_end_frame > audition_start_frame) {
                    eff_loop_start = audition_start_frame;
                    eff_loop_end   = audition_end_frame;
                    eff_loop = false; // stop cleanly at end of audition range
                } else if (loop_enabled) {
                    eff_loop_start = std::max<int64_t>(0, loop_start_frame);
                    eff_loop_end   = (loop_end_frame > eff_loop_start) ? loop_end_frame : total_dur_frames;
                    eff_loop = (eff_loop_end > eff_loop_start);
                }
            }

            // Precompute timeline frame index for each sample in this sub-block (supports exact sample-level wrap/stop)
            int64_t active_n = static_cast<int64_t>(n);
            if (!offline_mode) {
                if (audition_active && audition_end_frame > audition_start_frame) {
                    if (playhead_frame >= audition_end_frame) {
                        active_n = 0;
                        is_playing = false;
                        audition_active = false;
                        recompute_mutes_audio(*plan, 4.0f);
                    } else if (playhead_frame + active_n > audition_end_frame) {
                        active_n = audition_end_frame - playhead_frame;
                    }
                } else if (!eff_loop && total_dur_frames > 0) {
                    if (playhead_frame >= total_dur_frames) {
                        active_n = 0;
                        is_playing = false;
                    } else if (playhead_frame + active_n > total_dur_frames) {
                        active_n = total_dur_frames - playhead_frame;
                    }
                }
            }

            // 4. Render active clips into their target buses
            if (active_n > 0) {
                for (auto& clip : plan->clips) {
                    if (clip.target_bus_index < 0 || clip.src_total_frames == 0) continue;
                    auto& bus = *plan->buses[static_cast<size_t>(clip.target_bus_index)];

                    const double cs = std::clamp(
                        (clip.desc.flags & SIN_CLIP_LIVE_CROP_BOUND) ? static_cast<double>(bus.crop_start) : clip.desc.source_start_ratio,
                        0.0, 1.0);
                    const double ce = std::clamp(
                        (clip.desc.flags & SIN_CLIP_LIVE_CROP_BOUND) ? static_cast<double>(bus.crop_end) : clip.desc.source_end_ratio,
                        cs, 1.0);
                    const int64_t src_win_start = static_cast<int64_t>(std::floor(cs * static_cast<double>(clip.src_total_frames)));
                    const int64_t src_win_end   = std::min<int64_t>(static_cast<int64_t>(clip.src_total_frames),
                                                                    static_cast<int64_t>(std::ceil(ce * static_cast<double>(clip.src_total_frames))));
                    const int64_t src_win_len   = src_win_end - src_win_start;
                    if (src_win_len <= 0) continue;

                    const double bus_rate = (clip.desc.flags & SIN_CLIP_LIVE_RATE_BOUND) ? static_cast<double>(bus.playback_rate) : 1.0;
                    const double base_rate = clip.desc.playback_rate > 1e-4f ? static_cast<double>(clip.desc.playback_rate) : 1.0;
                    const double sr_ratio = (sample_rate > 0 && clip.src_sample_rate > 0)
                                            ? (static_cast<double>(clip.src_sample_rate) / static_cast<double>(sample_rate))
                                            : 1.0;
                    const double eff_rate = std::max(1e-4, base_rate * bus_rate * sr_ratio);
                    const bool unity_rate = std::abs(eff_rate - 1.0) < 1e-7;
                    const bool loop_src = (clip.desc.flags & SIN_CLIP_LOOP_SOURCE) != 0;

                    const int64_t nat_len = static_cast<int64_t>(std::ceil(static_cast<double>(src_win_len) / eff_rate));
                    const int64_t clip_t0 = (clip.desc.flags & SIN_CLIP_CROP_IN_PLACE)
                                            ? (clip.desc.timeline_start_frame + static_cast<int64_t>(std::floor(static_cast<double>(src_win_start) / eff_rate)))
                                            : clip.desc.timeline_start_frame;
                    const int64_t clip_len = (clip.desc.timeline_length_frames > 0) ? clip.desc.timeline_length_frames : nat_len;
                    const int64_t clip_t1  = clip_t0 + clip_len;
                    if (clip_len <= 0) continue;

                    // Fast range rejection when not wrapping inside this sub-block
                    const bool wraps_in_block = eff_loop && (block_start_frame + active_n > eff_loop_end);
                    if (!wraps_in_block) {
                        if (block_start_frame + active_n <= clip_t0 || block_start_frame >= clip_t1) {
                            continue;
                        }
                    }

                    const float clip_gain = clip.desc.gain;
                    if (clip_gain == 0.0f) continue;

                    const int64_t fade_in  = static_cast<int64_t>(clip.desc.fade_in_frames);
                    const int64_t fade_out = static_cast<int64_t>(clip.desc.fade_out_frames);
                    const int64_t rel_len  = clip.desc.release_frames > 0
                                             ? std::min<int64_t>(clip_len, static_cast<int64_t>(clip.desc.release_frames))
                                             : 0;
                    const int64_t sustain_len = clip_len - rel_len;

                    float* dst_l = bus.buf_l.data();
                    float* dst_r = bus.buf_r.data();

                    const float* ram_l = (!clip.is_streaming && clip.ram_pcm && !clip.ram_pcm->ch0.empty()) ? clip.ram_pcm->ch0.data() : nullptr;
                    const float* ram_r = (!clip.is_streaming && clip.ram_pcm && !clip.ram_pcm->ch1.empty()) ? clip.ram_pcm->ch1.data() : ram_l;

                    // Unity fast path for RAM sources with no wrap
                    if (!clip.is_streaming && ram_l && unity_rate && !wraps_in_block && !loop_src &&
                        fade_in == 0 && fade_out == 0 && rel_len == 0) {
                        const int64_t s_begin = std::max<int64_t>(0, clip_t0 - block_start_frame);
                        const int64_t s_end   = std::min<int64_t>(active_n, std::min(clip_t1, clip_t0 + src_win_len) - block_start_frame);
                        for (int64_t i = s_begin; i < s_end; ++i) {
                            const int64_t src_idx = src_win_start + (block_start_frame + i - clip_t0);
                            dst_l[i] += ram_l[src_idx] * clip_gain;
                            dst_r[i] += ram_r[src_idx] * clip_gain;
                        }
                        continue;
                    }

                    int64_t tf = block_start_frame;
                    for (int64_t i = 0; i < active_n; ++i) {
                        if (eff_loop && tf >= eff_loop_end) {
                            tf = eff_loop_start + ((tf - eff_loop_start) % (eff_loop_end - eff_loop_start));
                        }
                        if (tf >= clip_t0 && tf < clip_t1) {
                            const int64_t local_f = tf - clip_t0;
                            double rel_src = unity_rate ? static_cast<double>(local_f) : (static_cast<double>(local_f) * eff_rate);
                            bool in_src = true;
                            if (loop_src) {
                                rel_src = std::fmod(rel_src, static_cast<double>(src_win_len));
                                if (rel_src < 0.0) rel_src += static_cast<double>(src_win_len);
                            } else if (rel_src >= static_cast<double>(src_win_len)) {
                                in_src = false;
                            }

                            if (in_src) {
                                float env = clip_gain;
                                if (rel_len > 0 && local_f >= sustain_len) {
                                    env *= (rel_len > 1)
                                           ? static_cast<float>(1.0 - static_cast<double>(local_f - sustain_len) / static_cast<double>(rel_len - 1))
                                           : 0.0f;
                                }
                                if (fade_in > 0 && local_f < fade_in) {
                                    env *= static_cast<float>(local_f) / static_cast<float>(fade_in);
                                }
                                if (fade_out > 0) {
                                    const int64_t from_end = (clip_len - 1) - local_f;
                                    if (from_end < fade_out) {
                                        env *= static_cast<float>(from_end) / static_cast<float>(fade_out);
                                    }
                                }

                                if (env != 0.0f) {
                                    const double src_pos = static_cast<double>(src_win_start) + rel_src;
                                    float s_l = 0.0f, s_r = 0.0f;
                                    if (clip.is_streaming && clip.stream_reader) {
                                        const bool hit = clip.stream_reader->read_sample(
                                            src_pos, src_win_start, src_win_end, loop_src, offline_mode, s_l, s_r);
                                        if (!hit) {
                                            clip.was_starved = true;
                                        } else if (clip.was_starved) {
                                            clip.was_starved = false;
                                            trigger_declick(4.0f);
                                        }
                                    } else if (ram_l) {
                                        sin_dsp::read_planar_resampled(
                                            ram_l, ram_r, src_pos, src_win_start, src_win_end, loop_src, s_l, s_r);
                                    }
                                    dst_l[i] += s_l * env;
                                    dst_r[i] += s_r * env;
                                }
                            }
                        }
                        ++tf;
                    }
                }
            }

            // 5. Evaluate buses bottom-up (DspProcessor stages -> PreGain -> Volume -> Pan -> PostGain -> Mute -> Tap -> Parent Sum)
            const size_t num_buses = plan->buses.size();
            for (size_t bi = 0; bi < num_buses; ++bi) {
                auto& b = *plan->buses[bi];
                float* bl = b.buf_l.data();
                float* br = b.buf_r.data();

                if (!b.stages.empty()) {
                    const sin_dsp::ProcessContext proc_ctx{
                        sample_rate, n, bpm, playhead_frame, offline_mode
                    };
                    for (auto& st : b.stages) {
                        if (st.enabled && st.processor) {
                            st.processor->process(bl, br, bl, br, proc_ctx);
                        }
                    }
                }

                const bool any_smooth = b.pre_gain_sm.is_smoothing() || b.vol_sm.is_smoothing() ||
                                        b.post_gain_sm.is_smoothing() || b.pan_l_sm.is_smoothing() ||
                                        b.pan_r_sm.is_smoothing() || b.mute_sm.is_smoothing();

                float b_peak = 0.0f;
                if (!any_smooth) {
                    const float g_base = b.pre_gain_sm.current * b.vol_sm.current * b.post_gain_sm.current * b.mute_sm.current;
                    const float gl = g_base * b.pan_l_sm.current;
                    const float gr = g_base * b.pan_r_sm.current;
                    if (gl == 0.0f && gr == 0.0f) {
                        std::memset(bl, 0, sizeof(float) * n);
                        std::memset(br, 0, sizeof(float) * n);
                    } else if (gl == 1.0f && gr == 1.0f) {
                        for (uint32_t i = 0; i < n; ++i) {
                            const float ap = std::max(std::abs(bl[i]), std::abs(br[i]));
                            if (ap > b_peak) b_peak = ap;
                        }
                    } else {
                        for (uint32_t i = 0; i < n; ++i) {
                            bl[i] *= gl;
                            br[i] *= gr;
                            const float ap = std::max(std::abs(bl[i]), std::abs(br[i]));
                            if (ap > b_peak) b_peak = ap;
                        }
                    }
                } else {
                    for (uint32_t i = 0; i < n; ++i) {
                        const float g = b.pre_gain_sm.next() * b.vol_sm.next() * b.post_gain_sm.next() * b.mute_sm.next();
                        bl[i] *= g * b.pan_l_sm.next();
                        br[i] *= g * b.pan_r_sm.next();
                        const float ap = std::max(std::abs(bl[i]), std::abs(br[i]));
                        if (ap > b_peak) b_peak = ap;
                    }
                }

                b.peak.store(b_peak, std::memory_order_relaxed);
                if (bi < SIN_MAX_BUSES) {
                    tel_bus_ids[bi].store(b.bus_id, std::memory_order_relaxed);
                    tel_bus_peaks[bi].store(b_peak, std::memory_order_relaxed);
                }

                // Write optional bus stem tap (offline previews / IRIDE waveforms)
                for (auto& tap : bus_taps) {
                    if (tap.active && tap.bus_id == b.bus_id && tap.written < tap.capacity) {
                        const uint32_t to_copy = std::min(n, tap.capacity - tap.written);
                        if (tap.tap_l) std::memcpy(tap.tap_l + tap.written, bl, sizeof(float) * to_copy);
                        if (tap.tap_r) std::memcpy(tap.tap_r + tap.written, br, sizeof(float) * to_copy);
                        tap.written += to_copy;
                    }
                }

                // Sum into parent bus if not root
                if (b.parent_index >= 0 && static_cast<size_t>(b.parent_index) < num_buses) {
                    auto& parent = *plan->buses[static_cast<size_t>(b.parent_index)];
                    float* pl = parent.buf_l.data();
                    float* pr = parent.buf_r.data();
                    for (uint32_t i = 0; i < n; ++i) {
                        pl[i] += bl[i];
                        pr[i] += br[i];
                    }
                }
            }

            // 6. Copy master (last root bus) to output with click-free overlap crossfade
            const auto& master = *plan->buses.back();
            const float* ml = master.buf_l.data();
            const float* mr = master.buf_r.data();
            float* ol = out_l + offset;
            float* or_ = out_r + offset;

            if (swap_fade.is_smoothing() || declick_env > 0.0f) {
                for (uint32_t i = 0; i < n; ++i) {
                    const float sf = swap_fade.is_smoothing() ? swap_fade.next() : swap_fade.current;
                    float l = ml[i] * sf;
                    float r = mr[i] * sf;
                    if (declick_env > 0.0f) {
                        l += declick_l * declick_env;
                        r += declick_r * declick_env;
                        declick_env = std::max(0.0f, declick_env - declick_step);
                    }
                    ol[i] = l;
                    or_[i] = r;
                    last_out_l = l;
                    last_out_r = r;
                    block_peak_l = std::max(block_peak_l, std::abs(l));
                    block_peak_r = std::max(block_peak_r, std::abs(r));
                    block_sum_sq_l += static_cast<double>(l) * l;
                    block_sum_sq_r += static_cast<double>(r) * r;
                }
            } else {
                for (uint32_t i = 0; i < n; ++i) {
                    const float l = ml[i];
                    const float r = mr[i];
                    ol[i] = l;
                    or_[i] = r;
                    block_peak_l = std::max(block_peak_l, std::abs(l));
                    block_peak_r = std::max(block_peak_r, std::abs(r));
                    block_sum_sq_l += static_cast<double>(l) * l;
                    block_sum_sq_r += static_cast<double>(r) * r;
                }
                if (n > 0) {
                    last_out_l = ml[n - 1];
                    last_out_r = mr[n - 1];
                }
            }

            // Advance playhead cleanly
            playhead_frame += active_n;
            if (!offline_mode) {
                if (audition_active && audition_end_frame > audition_start_frame && playhead_frame >= audition_end_frame) {
                    is_playing = false;
                    audition_active = false;
                    trigger_declick(4.0f);
                    recompute_mutes_audio(*plan, 4.0f);
                } else if (eff_loop && eff_loop_end > eff_loop_start && playhead_frame >= eff_loop_end) {
                    playhead_frame = eff_loop_start + ((playhead_frame - eff_loop_start) % (eff_loop_end - eff_loop_start));
                } else if (!eff_loop && total_dur_frames > 0 && playhead_frame >= total_dur_frames) {
                    playhead_frame = total_dur_frames;
                    is_playing = false;
                    trigger_declick(4.0f);
                }
            }

            offset += n;
        }

        // 7. Publish telemetry & downsampled mono scope snapshot
        tel_bus_count.store(static_cast<uint32_t>(std::min<size_t>(plan->buses.size(), SIN_MAX_BUSES)), std::memory_order_relaxed);
        if (applied_transport_gen >= desired_transport_gen.load(std::memory_order_acquire)) {
            tel_playhead_sec.store(static_cast<double>(playhead_frame) * inv_sr, std::memory_order_relaxed);
            tel_is_playing.store(is_playing ? 1u : 0u, std::memory_order_relaxed);
        }
        tel_duration_sec.store(static_cast<double>(total_dur_frames) * inv_sr, std::memory_order_relaxed);
        tel_bpm.store(bpm, std::memory_order_relaxed);
        tel_loop_enabled.store(loop_enabled ? 1u : 0u, std::memory_order_relaxed);
        tel_audition_active.store(audition_active ? 1u : 0u, std::memory_order_relaxed);
        tel_peak_l.store(block_peak_l, std::memory_order_relaxed);
        tel_peak_r.store(block_peak_r, std::memory_order_relaxed);
        tel_rms_l.store(static_cast<float>(std::sqrt(block_sum_sq_l / static_cast<double>(num_frames))), std::memory_order_relaxed);
        tel_rms_r.store(static_cast<float>(std::sqrt(block_sum_sq_r / static_cast<double>(num_frames))), std::memory_order_relaxed);

        const uint32_t scope_n = std::min<uint32_t>(num_frames, SIN_MAX_SCOPE_SAMPLES);
        for (uint32_t i = 0; i < scope_n; ++i) {
            const uint32_t src_i = (i * num_frames) / scope_n;
            tel_scope[i].store(0.5f * (out_l[src_i] + out_r[src_i]), std::memory_order_relaxed);
        }
    }
};

static void miniaudio_data_callback(ma_device* pDevice, void* pOutput, const void* /*pInput*/, ma_uint32 frameCount) {
    auto* eng = static_cast<SinEngine*>(pDevice->pUserData);
    float* out = static_cast<float*>(pOutput);
    if (!eng || !out || frameCount == 0) return;

    uint32_t remaining = frameCount;
    uint32_t out_pos = 0;
    const uint32_t cap = static_cast<uint32_t>(eng->device_scratch_l.size());
    float* sl = eng->device_scratch_l.data();
    float* sr = eng->device_scratch_r.data();

    while (remaining > 0) {
        const uint32_t chunk = std::min(remaining, cap);
        eng->process_block(sl, sr, chunk);
        for (uint32_t i = 0; i < chunk; ++i) {
            // Soft safety clamp for hardware DAC output
            out[(out_pos + i) * 2]     = std::clamp(sl[i], -1.0f, 1.0f);
            out[(out_pos + i) * 2 + 1] = std::clamp(sr[i], -1.0f, 1.0f);
        }
        out_pos += chunk;
        remaining -= chunk;
    }
}

extern "C" {

SIN_API SinEngine* sin_engine_create(const SinEngineConfig* cfg) {
    auto* eng = new (std::nothrow) SinEngine();
    if (!eng) return nullptr;
    if (cfg) {
        eng->sample_rate = cfg->sample_rate > 0 ? cfg->sample_rate : SIN_DEFAULT_SAMPLE_RATE;
        eng->max_block_size = cfg->max_block_size > 0 ? cfg->max_block_size : 1024u;
        eng->offline_mode = (cfg->offline_mode != 0);
    } else {
        eng->sample_rate = SIN_DEFAULT_SAMPLE_RATE;
        eng->max_block_size = 1024u;
        eng->offline_mode = false;
    }
    eng->swap_fade.snap(1.0f);
    eng->device_scratch_l.assign(eng->max_block_size, 0.0f);
    eng->device_scratch_r.assign(eng->max_block_size, 0.0f);
    return eng;
}

SIN_API void sin_engine_destroy(SinEngine* engine) {
    if (!engine) return;
    sin_engine_stop_device(engine);
    engine->stop_disk_thread();
    {
        std::lock_guard<std::mutex> dlk(engine->disk_mutex);
        engine->disk_plan.reset();
    }
    {
        std::lock_guard<std::mutex> clk(engine->control_mutex);
        engine->pending_plan.store(nullptr, std::memory_order_release);
        engine->active_plan = nullptr;
        engine->owned_plans.clear();
        engine->source_pool.clear();
    }
    delete engine;
}

SIN_API void sin_engine_reset(SinEngine* engine) {
    if (!engine) return;
    const uint64_t gen = engine->desired_transport_gen.fetch_add(1, std::memory_order_acq_rel) + 1;
    engine->tel_playhead_sec.store(0.0, std::memory_order_relaxed);
    engine->tel_is_playing.store(0u, std::memory_order_relaxed);
    if (engine->offline_mode) {
        engine->applied_transport_gen = gen;
        engine->playhead_frame = 0;
        engine->is_playing = false;
        engine->audition_active = false;
        for (auto& tap : engine->bus_taps) tap.written = 0;
        return;
    }
    sin_dsp::EngineCommand cmd{};
    cmd.kind = sin_dsp::CmdKind::ResetPlayhead;
    cmd.transport_gen = gen;
    engine->dispatch_control_command(cmd);
    engine->wake_disk_thread_for_seek(0.0);
}

SIN_API int32_t sin_engine_start_device(SinEngine* engine) {
    if (!engine || engine->offline_mode) return -1;
    std::lock_guard<std::mutex> lk(engine->control_mutex);
    if (engine->device_running.load(std::memory_order_acquire)) return 0;

    if (!engine->device_initialized) {
        ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
        cfg.playback.format = ma_format_f32;
        cfg.playback.channels = 2;
        cfg.sampleRate = engine->sample_rate;
        cfg.dataCallback = miniaudio_data_callback;
        cfg.pUserData = engine;
        cfg.performanceProfile = ma_performance_profile_low_latency;

        if (ma_device_init(nullptr, &cfg, &engine->device) != MA_SUCCESS) {
            return -2;
        }
        engine->device_initialized = true;
        if (engine->device.sampleRate > 0) {
            engine->sample_rate = engine->device.sampleRate;
        }
    }

    engine->start_disk_thread_if_needed();
    if (ma_device_start(&engine->device) != MA_SUCCESS) {
        return -3;
    }
    engine->device_running.store(true, std::memory_order_release);
    return 0;
}

SIN_API void sin_engine_stop_device(SinEngine* engine) {
    if (!engine) return;
    std::lock_guard<std::mutex> lk(engine->control_mutex);
    if (engine->device_initialized) {
        ma_device_uninit(&engine->device);
        engine->device_initialized = false;
    }
    engine->device_running.store(false, std::memory_order_release);
}

SIN_API int32_t sin_engine_is_device_running(const SinEngine* engine) {
    if (!engine) return 0;
    return engine->device_running.load(std::memory_order_acquire) ? 1 : 0;
}

SIN_API uint32_t sin_engine_get_sample_rate(const SinEngine* engine) {
    return engine ? engine->sample_rate : SIN_DEFAULT_SAMPLE_RATE;
}

SIN_API int32_t sin_engine_register_file_source(SinEngine* engine, SinSourceId id, const char* utf8_path, uint32_t force_ram) {
    if (!engine) return -1;
    std::lock_guard<std::mutex> lk(engine->control_mutex);
    return engine->source_pool.register_file(id, utf8_path, force_ram != 0);
}

SIN_API int32_t sin_engine_register_pcm_source(
    SinEngine* engine,
    SinSourceId id,
    const float* ch0,
    const float* ch1,
    uint32_t num_frames,
    uint32_t src_sr,
    uint64_t content_hash
) {
    if (!engine) return -1;
    std::lock_guard<std::mutex> lk(engine->control_mutex);
    return engine->source_pool.register_pcm(id, ch0, ch1, num_frames, src_sr, content_hash);
}

SIN_API int32_t sin_engine_get_source_info(const SinEngine* engine, SinSourceId id, SinSourceInfo* out_info) {
    if (!engine || !out_info) return -1;
    std::lock_guard<std::mutex> lk(const_cast<SinEngine*>(engine)->control_mutex);
    auto entry = engine->source_pool.find(id);
    if (!entry) return -2;
    out_info->sample_rate = entry->sample_rate;
    out_info->channels = entry->channels;
    out_info->num_frames = entry->num_frames;
    out_info->is_streaming = entry->is_streaming ? 1u : 0u;
    return 0;
}

SIN_API int32_t sin_engine_release_source(SinEngine* engine, SinSourceId id) {
    if (!engine) return -1;
    std::lock_guard<std::mutex> lk(engine->control_mutex);
    return engine->source_pool.release(id);
}

SIN_API void sin_engine_release_all_sources(SinEngine* engine) {
    if (!engine) return;
    std::lock_guard<std::mutex> lk(engine->control_mutex);
    // Swap in an empty plan first so disk handles inside active plans can be retired
    auto empty_plan = std::make_shared<sin_dsp::CompiledPlan>();
    empty_plan->epoch = engine->next_epoch++;
    engine->owned_plans.push_back(empty_plan);
    {
        std::lock_guard<std::mutex> dlk(engine->disk_mutex);
        engine->disk_plan = empty_plan;
    }
    if (engine->offline_mode || !engine->device_running.load(std::memory_order_acquire)) {
        engine->pending_plan.store(nullptr, std::memory_order_release);
        engine->active_plan = empty_plan.get();
        engine->active_epoch.store(empty_plan->epoch, std::memory_order_release);
        engine->owned_plans.clear();
        engine->owned_plans.push_back(empty_plan);
    } else {
        engine->pending_plan.store(empty_plan.get(), std::memory_order_release);
        // Give audio thread a brief window (~20ms) to pick up empty plan so file handles close promptly
        for (int attempt = 0; attempt < 20; ++attempt) {
            if (engine->active_epoch.load(std::memory_order_acquire) >= empty_plan->epoch) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        engine->gc_retired_plans_locked();
    }
    engine->source_pool.clear();
}

SIN_API int32_t sin_engine_load_plan_with_chains(
    SinEngine* engine,
    const SinBusDesc* buses, uint32_t num_buses,
    const SinClipDesc* clips, uint32_t num_clips,
    const SinChainStageDesc* stages, uint32_t num_stages,
    double explicit_duration_sec,
    double bpm
) {
    if (!engine) return -1;
    std::lock_guard<std::mutex> lk(engine->control_mutex);

    auto plan = std::make_shared<sin_dsp::CompiledPlan>();
    plan->epoch = engine->next_epoch++;
    plan->bpm = bpm > 1.0 ? bpm : 120.0;
    plan->explicit_duration_frames = explicit_duration_sec > 0.0
        ? static_cast<int64_t>(std::llround(explicit_duration_sec * static_cast<double>(engine->sample_rate)))
        : 0;

    // 1. Build buses and topologically sort bottom-up (leaves first, root master last)
    std::vector<SinBusDesc> raw_buses;
    if (buses && num_buses > 0) {
        raw_buses.assign(buses, buses + std::min<uint32_t>(num_buses, SIN_MAX_BUSES));
    } else {
        SinBusDesc master{};
        master.bus_id = 1;
        master.parent_bus_id = 0;
        master.volume = 1.0f;
        master.crop_start = 0.0f;
        master.crop_end = 1.0f;
        master.playback_rate = 1.0f;
        raw_buses.push_back(master);
    }

    std::unordered_map<SinBusId, size_t> raw_idx;
    for (size_t i = 0; i < raw_buses.size(); ++i) {
        raw_idx[raw_buses[i].bus_id] = i;
    }

    auto compute_depth = [&](size_t i) -> int {
        int depth = 0;
        SinBusId cur = raw_buses[i].bus_id;
        for (int guard = 0; guard < static_cast<int>(raw_buses.size()) + 1; ++guard) {
            auto it = raw_idx.find(cur);
            if (it == raw_idx.end()) break;
            SinBusId p = raw_buses[it->second].parent_bus_id;
            if (p == 0 || p == cur || raw_idx.find(p) == raw_idx.end()) break;
            cur = p;
            ++depth;
        }
        return depth;
    };

    std::vector<size_t> order(raw_buses.size());
    for (size_t i = 0; i < raw_buses.size(); ++i) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
        return compute_depth(a) > compute_depth(b); // deepest leaves first, root (depth 0) last
    });

    std::unordered_map<SinBusId, int32_t> sorted_idx;
    plan->buses.reserve(order.size());
    for (size_t pos = 0; pos < order.size(); ++pos) {
        const auto& src = raw_buses[order[pos]];
        auto b = std::make_unique<sin_dsp::BusState>();
        b->bus_id = src.bus_id;
        b->parent_bus_id = src.parent_bus_id;
        b->pre_gain_db = src.pre_gain_db;
        b->volume = std::max(0.0f, src.volume);
        b->post_gain_db = src.post_gain_db;
        b->pan = std::clamp(src.pan, -1.0f, 1.0f);
        b->crop_start = std::clamp(src.crop_start, 0.0f, 1.0f);
        b->crop_end = std::clamp(src.crop_end > 0.0f ? src.crop_end : 1.0f, b->crop_start, 1.0f);
        b->playback_rate = src.playback_rate > 1e-4f ? src.playback_rate : 1.0f;
        b->live_crop_start.store(b->crop_start, std::memory_order_relaxed);
        b->live_playback_rate.store(b->playback_rate, std::memory_order_relaxed);
        b->muted = (src.muted != 0);
        b->solo = (src.solo != 0);

        b->pre_gain_sm.snap(sin_dsp::db_to_linear(b->pre_gain_db));
        b->vol_sm.snap(b->volume);
        b->post_gain_sm.snap(sin_dsp::db_to_linear(b->post_gain_db));
        float pl = 1.0f, pr = 1.0f;
        sin_dsp::pan_gains(b->pan, pl, pr);
        b->pan_l_sm.snap(pl);
        b->pan_r_sm.snap(pr);
        b->mute_sm.snap(b->muted ? 0.0f : 1.0f);

        b->buf_l.assign(engine->max_block_size, 0.0f);
        b->buf_r.assign(engine->max_block_size, 0.0f);

        sorted_idx[b->bus_id] = static_cast<int32_t>(pos);
        plan->buses.push_back(std::move(b));
    }

    // 1b. Instantiate ordered In -> Out DspProcessor stages per bus
    if (stages && num_stages > 0) {
        std::vector<std::vector<const SinChainStageDesc*>> bus_stage_descs(plan->buses.size());
        for (uint32_t si = 0; si < num_stages; ++si) {
            const auto& sd = stages[si];
            auto it = sorted_idx.find(sd.bus_id);
            if (it == sorted_idx.end()) continue;
            bus_stage_descs[static_cast<size_t>(it->second)].push_back(&sd);
        }
        for (size_t bi = 0; bi < plan->buses.size(); ++bi) {
            auto& descs = bus_stage_descs[bi];
            if (descs.empty()) continue;
            std::stable_sort(descs.begin(), descs.end(), [](const SinChainStageDesc* a, const SinChainStageDesc* b) {
                return a->stage_index < b->stage_index;
            });
            auto& b = *plan->buses[bi];
            b.stages.reserve(descs.size());
            for (const SinChainStageDesc* sd : descs) {
                auto proc = sin_dsp::create_processor(static_cast<SinProcessorType>(sd->processor_type));
                if (!proc) continue;
                proc->prepare(engine->sample_rate, engine->max_block_size);
                const uint32_t np = std::min<uint32_t>(sd->num_params, SIN_MAX_PROC_PARAMS);
                for (uint32_t pi = 0; pi < np; ++pi) {
                    proc->set_param(pi, sd->params[pi], 0.0f);
                }
                proc->reset();
                sin_dsp::BusStage st{};
                st.stage_index = sd->stage_index;
                st.processor = std::move(proc);
                st.enabled = (sd->enabled != 0);
                b.stages.push_back(std::move(st));
            }
        }
    }

    for (size_t i = 0; i < plan->buses.size(); ++i) {
        auto& b = *plan->buses[i];
        if (b.parent_bus_id != 0 && b.parent_bus_id != b.bus_id) {
            auto it = sorted_idx.find(b.parent_bus_id);
            if (it != sorted_idx.end() && it->second > static_cast<int32_t>(i)) {
                b.parent_index = it->second;
            }
        }
    }

    // 2. Bind clips to sources (RAM or pre-warmed DiskStreamReader)
    if (clips && num_clips > 0) {
        plan->clips.reserve(num_clips);
        for (uint32_t ci = 0; ci < num_clips; ++ci) {
            const auto& cd = clips[ci];
            auto src = engine->source_pool.find(cd.source_id);
            if (!src) continue;

            int32_t b_idx = plan->find_bus_index(cd.target_bus_id);
            if (b_idx < 0) b_idx = static_cast<int32_t>(plan->buses.size()) - 1;

            sin_dsp::ClipState cs{};
            cs.desc = cd;
            if (cs.desc.source_end_ratio <= 0.0 && cs.desc.source_start_ratio == 0.0) {
                cs.desc.source_end_ratio = 1.0;
            }
            if (cs.desc.playback_rate <= 0.0f) {
                cs.desc.playback_rate = 1.0f;
            }
            cs.target_bus_index = b_idx;
            cs.src_sample_rate = src->sample_rate;
            cs.src_total_frames = src->num_frames;
            cs.is_streaming = src->is_streaming;

            if (src->is_streaming) {
                auto reader = std::make_unique<sin_dsp::DiskStreamReader>();
                if (!reader->open(src->filepath, &engine->source_pool.vfs())) {
                    continue;
                }
                const int64_t init_frame = static_cast<int64_t>(std::floor(
                    std::clamp(cs.desc.source_start_ratio, 0.0, 1.0) * static_cast<double>(src->num_frames)));
                reader->prewarm(init_frame);
                cs.stream_reader = std::move(reader);
                plan->has_streaming_clips = true;
            } else {
                cs.ram_pcm = src->ram_pcm;
            }
            plan->clips.push_back(std::move(cs));
        }
    }

    plan->recompute_auto_duration(engine->sample_rate);

    // 3. Publish plan safely to disk thread & audio thread
    engine->owned_plans.push_back(plan);
    {
        std::lock_guard<std::mutex> dlk(engine->disk_mutex);
        engine->disk_plan = plan;
        engine->disk_wake_pending = true;
    }
    if (!engine->offline_mode && plan->has_streaming_clips) {
        engine->start_disk_thread_if_needed();
        engine->disk_cv.notify_one();
    }

    engine->tel_duration_sec.store(
        static_cast<double>(plan->effective_duration_frames()) / static_cast<double>(engine->sample_rate),
        std::memory_order_relaxed);
    engine->tel_bpm.store(plan->bpm, std::memory_order_relaxed);

    if (engine->offline_mode || !engine->device_running.load(std::memory_order_acquire)) {
        engine->pending_plan.store(nullptr, std::memory_order_release);
        engine->active_plan = plan.get();
        engine->active_epoch.store(plan->epoch, std::memory_order_release);
        engine->bpm = plan->bpm;
        engine->recompute_mutes_audio(*plan, 0.0f);
    } else {
        engine->pending_plan.store(plan.get(), std::memory_order_release);
    }
    engine->gc_retired_plans_locked();
    return 0;
}

SIN_API int32_t sin_engine_load_plan(
    SinEngine* engine,
    const SinBusDesc* buses, uint32_t num_buses,
    const SinClipDesc* clips, uint32_t num_clips,
    double explicit_duration_sec,
    double bpm
) {
    return sin_engine_load_plan_with_chains(
        engine, buses, num_buses, clips, num_clips, nullptr, 0, explicit_duration_sec, bpm);
}

SIN_API void sin_engine_set_param(SinEngine* engine, SinBusId bus_id, uint16_t param_id, float value, float ramp_ms) {
    if (!engine) return;
    if (param_id == SIN_PARAM_CROP_START || param_id == SIN_PARAM_PLAYBACK_RATE) {
        engine->mirror_live_bus_override(bus_id, param_id, value);
    }
    sin_dsp::EngineCommand cmd{};
    cmd.kind = sin_dsp::CmdKind::SetParam;
    cmd.bus_id = bus_id;
    cmd.param_id = param_id;
    cmd.value = value;
    cmd.ramp_ms = ramp_ms;
    engine->dispatch_control_command(cmd);
}

SIN_API void sin_engine_set_stage_param(
    SinEngine* engine,
    SinBusId bus_id,
    uint32_t stage_index,
    uint32_t param_index,
    float value,
    float ramp_ms
) {
    if (!engine) return;
    sin_dsp::EngineCommand cmd{};
    cmd.kind = sin_dsp::CmdKind::SetStageParam;
    cmd.bus_id = bus_id;
    cmd.stage_index = stage_index;
    cmd.param_index = param_index;
    cmd.value = value;
    cmd.ramp_ms = ramp_ms;
    engine->dispatch_control_command(cmd);
}

SIN_API void sin_engine_set_stage_enabled(
    SinEngine* engine,
    SinBusId bus_id,
    uint32_t stage_index,
    uint32_t enabled
) {
    if (!engine) return;
    sin_dsp::EngineCommand cmd{};
    cmd.kind = sin_dsp::CmdKind::SetStageEnabled;
    cmd.bus_id = bus_id;
    cmd.stage_index = stage_index;
    cmd.value = enabled ? 1.0f : 0.0f;
    engine->dispatch_control_command(cmd);
}

SIN_API void sin_engine_set_transport(
    SinEngine* engine,
    uint32_t playing,
    double seek_sec,
    double bpm,
    double loop_start_sec,
    double loop_end_sec,
    uint32_t loop_enabled
) {
    if (!engine) return;
    const uint64_t gen = engine->desired_transport_gen.fetch_add(1, std::memory_order_acq_rel) + 1;
    engine->tel_is_playing.store(playing ? 1u : 0u, std::memory_order_relaxed);
    if (seek_sec >= 0.0) {
        engine->tel_playhead_sec.store(seek_sec, std::memory_order_relaxed);
    }
    if (bpm > 1.0) {
        engine->tel_bpm.store(bpm, std::memory_order_relaxed);
    }
    engine->tel_loop_enabled.store(loop_enabled ? 1u : 0u, std::memory_order_relaxed);

    sin_dsp::EngineCommand cmd{};
    cmd.kind = sin_dsp::CmdKind::SetTransport;
    cmd.playing = playing;
    cmd.seek_sec = seek_sec;
    cmd.bpm = bpm;
    cmd.start_sec = loop_start_sec;
    cmd.end_sec = loop_end_sec;
    cmd.loop_enabled = loop_enabled;
    cmd.transport_gen = gen;
    engine->dispatch_control_command(cmd);
    if (seek_sec >= 0.0) {
        engine->wake_disk_thread_for_seek(seek_sec);
    }
}

SIN_API void sin_engine_set_audition(
    SinEngine* engine,
    uint32_t active,
    SinBusId solo_bus_id,
    double start_sec,
    double end_sec
) {
    if (!engine) return;
    const uint64_t gen = engine->desired_transport_gen.fetch_add(1, std::memory_order_acq_rel) + 1;
    engine->tel_audition_active.store(active ? 1u : 0u, std::memory_order_relaxed);
    engine->tel_is_playing.store(active ? 1u : 0u, std::memory_order_relaxed);
    if (active && start_sec >= 0.0) {
        engine->tel_playhead_sec.store(start_sec, std::memory_order_relaxed);
    }

    sin_dsp::EngineCommand cmd{};
    cmd.kind = sin_dsp::CmdKind::SetAudition;
    cmd.active = active;
    cmd.bus_id = solo_bus_id;
    cmd.start_sec = start_sec;
    cmd.end_sec = end_sec;
    cmd.transport_gen = gen;
    engine->dispatch_control_command(cmd);
    if (active && start_sec >= 0.0) {
        engine->wake_disk_thread_for_seek(start_sec);
    }
}

SIN_API void sin_engine_process(SinEngine* engine, float* out_l, float* out_r, uint32_t num_frames) {
    if (!engine) return;
    engine->process_block(out_l, out_r, num_frames);
}

SIN_API int32_t sin_engine_set_bus_tap(SinEngine* engine, SinBusId bus_id, float* tap_l, float* tap_r, uint32_t capacity_frames) {
    if (!engine) return -1;
    for (auto& slot : engine->bus_taps) {
        if (slot.active && slot.bus_id == bus_id) {
            slot.tap_l = tap_l;
            slot.tap_r = tap_r;
            slot.capacity = capacity_frames;
            slot.written = 0;
            return 0;
        }
    }
    for (auto& slot : engine->bus_taps) {
        if (!slot.active) {
            slot.bus_id = bus_id;
            slot.tap_l = tap_l;
            slot.tap_r = tap_r;
            slot.capacity = capacity_frames;
            slot.written = 0;
            slot.active = true;
            return 0;
        }
    }
    return -2;
}

SIN_API void sin_engine_clear_bus_taps(SinEngine* engine) {
    if (!engine) return;
    for (auto& slot : engine->bus_taps) {
        slot.active = false;
        slot.tap_l = nullptr;
        slot.tap_r = nullptr;
        slot.capacity = 0;
        slot.written = 0;
    }
}

SIN_API void sin_engine_read_telemetry(
    const SinEngine* engine,
    SinTelemetry* out_hdr,
    SinBusPeak* out_bus_peaks, uint32_t max_buses,
    float* out_scope_mono, uint32_t scope_len
) {
    if (!engine) return;
    const uint32_t bc = engine->tel_bus_count.load(std::memory_order_relaxed);
    if (out_hdr) {
        out_hdr->playhead_seconds = engine->tel_playhead_sec.load(std::memory_order_relaxed);
        out_hdr->duration_seconds = engine->tel_duration_sec.load(std::memory_order_relaxed);
        out_hdr->bpm              = engine->tel_bpm.load(std::memory_order_relaxed);
        out_hdr->sample_rate      = engine->sample_rate;
        out_hdr->is_playing       = engine->tel_is_playing.load(std::memory_order_relaxed);
        out_hdr->loop_enabled     = engine->tel_loop_enabled.load(std::memory_order_relaxed);
        out_hdr->audition_active  = engine->tel_audition_active.load(std::memory_order_relaxed);
        out_hdr->active_bus_count = bc;
        out_hdr->master_peak_l    = engine->tel_peak_l.load(std::memory_order_relaxed);
        out_hdr->master_peak_r    = engine->tel_peak_r.load(std::memory_order_relaxed);
        out_hdr->master_rms_l     = engine->tel_rms_l.load(std::memory_order_relaxed);
        out_hdr->master_rms_r     = engine->tel_rms_r.load(std::memory_order_relaxed);
    }
    if (out_bus_peaks && max_buses > 0) {
        const uint32_t n = std::min<uint32_t>(bc, std::min<uint32_t>(max_buses, SIN_MAX_BUSES));
        for (uint32_t i = 0; i < n; ++i) {
            out_bus_peaks[i].bus_id = engine->tel_bus_ids[i].load(std::memory_order_relaxed);
            out_bus_peaks[i].peak   = engine->tel_bus_peaks[i].load(std::memory_order_relaxed);
        }
    }
    if (out_scope_mono && scope_len > 0) {
        const uint32_t n = std::min<uint32_t>(scope_len, SIN_MAX_SCOPE_SAMPLES);
        for (uint32_t i = 0; i < n; ++i) {
            out_scope_mono[i] = engine->tel_scope[i].load(std::memory_order_relaxed);
        }
    }
}

} // extern "C"

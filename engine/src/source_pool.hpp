#pragma once

#include "../include/sin_dsp.h"
#include "platform_vfs.hpp"
#include "resampler.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace sin_dsp {

constexpr double kRamResidentMaxSeconds = 30.0;
constexpr uint64_t kRamResidentMaxFrames = 48000ull * 35ull;

struct PcmBuffer {
    std::vector<float> ch0;
    std::vector<float> ch1;
    uint64_t num_frames = 0;
    uint32_t sample_rate = SIN_DEFAULT_SAMPLE_RATE;
    uint32_t channels = 1;
    uint64_t content_hash = 0;
};

struct LayeredTileBuffer {
    std::vector<float> ch0;
    std::vector<float> ch1;
    uint32_t num_frames = 0;
    uint32_t generation = 0;
};

/*
 * Lock-free sparse tile overlay for long-track Tier-2/Tier-3 cooked processors.
 * Audio thread reads `slots[tile_idx].load(acquire)` with ZERO locks and ZERO allocations;
 * control thread publishes or evicts individual tiles atomically with timed retired-buffer GC.
 */
class LayeredTileStore {
public:
    uint32_t tile_frames = 0;
    uint32_t num_tiles = 0;
    uint64_t total_frames = 0;
    uint32_t sample_rate = SIN_DEFAULT_SAMPLE_RATE;

    void init(uint32_t t_frames, uint32_t n_tiles, uint64_t tot_frames, uint32_t sr) {
        std::lock_guard<std::mutex> lk(write_mutex_);
        tile_frames = t_frames;
        num_tiles = n_tiles;
        total_frames = tot_frames;
        sample_rate = sr > 0 ? sr : SIN_DEFAULT_SAMPLE_RATE;
        slots_ = std::make_unique<std::atomic<const LayeredTileBuffer*>[]>(n_tiles);
        for (uint32_t i = 0; i < n_tiles; ++i) {
            slots_[i].store(nullptr, std::memory_order_relaxed);
        }
        live_owners_.assign(n_tiles, nullptr);
        retired_.clear();
    }

    bool set_tile(uint32_t idx, const float* ch0, const float* ch1, uint32_t n_frames, uint32_t gen) {
        if (idx >= num_tiles || !slots_) return false;
        std::shared_ptr<LayeredTileBuffer> next_buf;
        if (ch0 && n_frames > 0) {
            next_buf = std::make_shared<LayeredTileBuffer>();
            next_buf->num_frames = n_frames;
            next_buf->generation = gen;
            next_buf->ch0.assign(ch0, ch0 + n_frames);
            if (ch1) {
                next_buf->ch1.assign(ch1, ch1 + n_frames);
            }
        }
        std::lock_guard<std::mutex> lk(write_mutex_);
        auto prev = std::move(live_owners_[idx]);
        live_owners_[idx] = next_buf;
        slots_[idx].store(next_buf.get(), std::memory_order_release);
        if (prev) {
            retired_.push_back({std::move(prev), std::chrono::steady_clock::now()});
        }
        gc_retired_locked();
        return true;
    }

    void clear_all() {
        std::lock_guard<std::mutex> lk(write_mutex_);
        if (!slots_) return;
        const auto now = std::chrono::steady_clock::now();
        for (uint32_t i = 0; i < num_tiles; ++i) {
            slots_[i].store(nullptr, std::memory_order_release);
            if (live_owners_[i]) {
                retired_.push_back({std::move(live_owners_[i]), now});
            }
        }
        gc_retired_locked();
    }

    inline bool read_sample(double pos, float& out_l, float& out_r, uint32_t& out_gen) const noexcept {
        if (!slots_ || tile_frames == 0 || num_tiles == 0 || pos < 0.0) return false;
        const uint64_t i1 = static_cast<uint64_t>(pos);
        const uint64_t tidx = i1 / static_cast<uint64_t>(tile_frames);
        if (tidx >= num_tiles) return false;
        const LayeredTileBuffer* tile = slots_[static_cast<size_t>(tidx)].load(std::memory_order_acquire);
        if (!tile || tile->num_frames == 0 || tile->ch0.empty()) return false;

        const uint32_t local = static_cast<uint32_t>(i1 - tidx * static_cast<uint64_t>(tile_frames));
        if (local >= tile->num_frames) return false;

        out_gen = tile->generation;
        const float frac = static_cast<float>(pos - static_cast<double>(i1));
        const float* l_ptr = tile->ch0.data();
        const float* r_ptr = tile->ch1.empty() ? l_ptr : tile->ch1.data();
        if (frac < 1e-6f) {
            out_l = l_ptr[local];
            out_r = r_ptr[local];
            return true;
        }
        float l1 = l_ptr[local];
        float r1 = r_ptr[local];
        float l2 = l1;
        float r2 = r1;
        if (local + 1 < tile->num_frames) {
            l2 = l_ptr[local + 1];
            r2 = r_ptr[local + 1];
        } else if (tidx + 1 < num_tiles) {
            const LayeredTileBuffer* next_tile = slots_[static_cast<size_t>(tidx + 1)].load(std::memory_order_acquire);
            if (next_tile && next_tile->num_frames > 0 && !next_tile->ch0.empty()) {
                l2 = next_tile->ch0[0];
                r2 = next_tile->ch1.empty() ? l2 : next_tile->ch1[0];
            }
        }
        out_l = l1 + frac * (l2 - l1);
        out_r = r1 + frac * (r2 - r1);
        return true;
    }

private:
    struct RetiredTile {
        std::shared_ptr<LayeredTileBuffer> buf;
        std::chrono::steady_clock::time_point retired_at;
    };

    void gc_retired_locked() {
        const auto cutoff = std::chrono::steady_clock::now() - std::chrono::milliseconds(250);
        retired_.erase(
            std::remove_if(retired_.begin(), retired_.end(), [&](const RetiredTile& r) {
                return r.retired_at < cutoff;
            }),
            retired_.end()
        );
    }

    std::unique_ptr<std::atomic<const LayeredTileBuffer*>[]> slots_;
    std::mutex write_mutex_;
    std::vector<std::shared_ptr<LayeredTileBuffer>> live_owners_;
    std::vector<RetiredTile> retired_;
};

struct SourceEntry {
    SinSourceId id = 0;
    std::string filepath;
    std::shared_ptr<const PcmBuffer> ram_pcm; /* Non-null when RAM-resident */
    std::shared_ptr<LayeredTileStore> layered_tiles; /* Non-null for layered tiled processor sources */
    uint32_t sample_rate = SIN_DEFAULT_SAMPLE_RATE;
    uint32_t channels = 1;
    uint64_t num_frames = 0;
    bool is_streaming = false;
    bool use_ffmpeg = false;
};

/*
 * Try decoding an arbitrary audio/video file to stereo float32 PCM via ffmpeg CLI
 * (fallback for containers unsupported natively by miniaudio, e.g. m4a/aac/ogg/mp4/mkv/mov).
 */
inline bool decode_via_ffmpeg_to_pcm(const std::string& utf8_path, PcmBuffer& out_pcm, uint32_t target_sr = SIN_DEFAULT_SAMPLE_RATE) {
    if (utf8_path.empty()) return false;
    // Escape embedded double quotes cleanly for command invocation
    std::string escaped;
    escaped.reserve(utf8_path.size() + 8);
    for (char c : utf8_path) {
        if (c == '"') escaped += "\\\"";
        else escaped += c;
    }

#if defined(_WIN32)
    std::string cmd = "ffmpeg -v error -nostdin -i \"" + escaped +
                      "\" -f f32le -acodec pcm_f32le -ac 2 -ar " +
                      std::to_string(target_sr) + " pipe:1 2>NUL";
    FILE* pipe = _popen(cmd.c_str(), "rb");
#else
    std::string cmd = "ffmpeg -v error -nostdin -i \"" + escaped +
                      "\" -f f32le -acodec pcm_f32le -ac 2 -ar " +
                      std::to_string(target_sr) + " pipe:1 2>/dev/null";
    FILE* pipe = popen(cmd.c_str(), "r");
#endif
    if (!pipe) return false;

    std::vector<float> interleaved;
    float tmp[8192];
    for (;;) {
        size_t n = std::fread(tmp, sizeof(float), 8192, pipe);
        if (n > 0) {
            interleaved.insert(interleaved.end(), tmp, tmp + n);
        }
        if (n < 8192) break;
    }
#if defined(_WIN32)
    int rc = _pclose(pipe);
#else
    int rc = pclose(pipe);
#endif
    if (rc != 0 || interleaved.size() < 2) {
        return false;
    }
    const size_t frames = interleaved.size() / 2;
    out_pcm.ch0.resize(frames);
    out_pcm.ch1.resize(frames);
    for (size_t i = 0; i < frames; ++i) {
        out_pcm.ch0[i] = interleaved[i * 2];
        out_pcm.ch1[i] = interleaved[i * 2 + 1];
    }
    out_pcm.num_frames = static_cast<uint64_t>(frames);
    out_pcm.sample_rate = target_sr;
    out_pcm.channels = 2;
    return true;
}

/*
 * Per-clip disk stream reader using a lock-free sliding circular window (power-of-two capacity).
 * - Offline mode: fills synchronously into the sliding window (zero extra threads, deterministic).
 * - Real-time mode: filled asynchronously by SinEngine's background disk reader thread;
 *   audio thread NEVER locks, allocates, or performs disk I/O!
 */
class DiskStreamReader {
public:
    static constexpr size_t kRingCap         = 262144; /* ~5.46s at 48kHz (~2MB stereo) */
    static constexpr size_t kRingMask        = kRingCap - 1;
    static constexpr int64_t kFillChunk      = 16384;
    static constexpr int64_t kSeekLookbehind = 4096;   /* ~85ms instant backward cushion on seek */
    static constexpr int64_t kSeekBurst      = 8192;   /* ~170ms fast first burst (<0.5ms SSD read) */
    static constexpr int64_t kPrefetchAhead  = 131072; /* ~2.73s forward prefetch */
    static constexpr int64_t kLookbehindGuard = 32768; /* ~0.68s retained behind cursor for seamless local scrubbing */

    DiskStreamReader() = default;
    ~DiskStreamReader() { close(); }

    DiskStreamReader(const DiskStreamReader&) = delete;
    DiskStreamReader& operator=(const DiskStreamReader&) = delete;

    bool open(const std::string& path, ShareSafeVfs* vfs) {
        close();
        vfs_ = vfs;
        path_ = path;

        ma_decoder_config cfg = ma_decoder_config_init(ma_format_f32, 0, 0);
        if (ma_decoder_init_vfs(vfs->handle(), path.c_str(), &cfg, &decoder_) != MA_SUCCESS) {
            return false;
        }
        decoder_open_ = true;
        channels_ = decoder_.outputChannels > 0 ? decoder_.outputChannels : 1;
        sample_rate_ = decoder_.outputSampleRate > 0 ? decoder_.outputSampleRate : SIN_DEFAULT_SAMPLE_RATE;

        ma_uint64 len = 0;
        if (ma_decoder_get_length_in_pcm_frames(&decoder_, &len) == MA_SUCCESS && len > 0) {
            total_frames_ = static_cast<int64_t>(len);
        } else {
            total_frames_ = 0;
        }

        ring_l_.assign(kRingCap, 0.0f);
        ring_r_.assign(kRingCap, 0.0f);
        interleaved_scratch_.assign(static_cast<size_t>(kFillChunk) * std::max<uint32_t>(1u, channels_), 0.0f);

        decoder_pos_ = 0;
        win_start_.store(0, std::memory_order_relaxed);
        win_end_.store(0, std::memory_order_relaxed);
        play_cursor_.store(0, std::memory_order_relaxed);
        return true;
    }

    void close() {
        if (decoder_open_) {
            ma_decoder_uninit(&decoder_);
            decoder_open_ = false;
        }
        ring_l_.clear();
        ring_r_.clear();
        interleaved_scratch_.clear();
        win_start_.store(0, std::memory_order_relaxed);
        win_end_.store(0, std::memory_order_relaxed);
    }

    uint32_t sample_rate() const noexcept { return sample_rate_; }
    uint32_t channels() const noexcept { return channels_; }
    int64_t  total_frames() const noexcept { return total_frames_; }
    bool     is_open() const noexcept { return decoder_open_; }

    /* Pre-warm from initial_frame synchronously on the control thread (before audio callback starts). */
    void prewarm(int64_t initial_frame) {
        if (!decoder_open_) return;
        const int64_t start = std::max<int64_t>(0, initial_frame - kSeekLookbehind);
        play_cursor_.store(std::max<int64_t>(0, initial_frame), std::memory_order_release);
        refill_from_seek(start, 32768);
    }

    /* Hint cursor from control thread on seek/scrub so disk buffer stays centered even while paused. */
    void set_hint_cursor(int64_t frame) noexcept {
        play_cursor_.store(std::max<int64_t>(0, frame), std::memory_order_release);
    }

    bool needs_service() const noexcept {
        if (!decoder_open_) return false;
        const int64_t cursor = play_cursor_.load(std::memory_order_acquire);
        const int64_t w_start = win_start_.load(std::memory_order_relaxed);
        const int64_t w_end   = win_end_.load(std::memory_order_relaxed);
        if (cursor < w_start || cursor >= w_end) return true;
        if ((w_end - cursor) < kPrefetchAhead) {
            if (total_frames_ <= 0 || w_end < total_frames_) return true;
        }
        return false;
    }

    /* Called ONLY from the background disk thread (RT) OR synchronously on the caller thread (offline). */
    void service_disk(bool sync_all_needed = false) {
        if (!decoder_open_) return;
        const int64_t cursor = play_cursor_.load(std::memory_order_acquire);
        const int64_t w_start = win_start_.load(std::memory_order_relaxed);
        const int64_t w_end   = win_end_.load(std::memory_order_relaxed);

        // If playhead jumped outside our cached window, seek and publish a fast initial burst (<0.5ms)
        // with lookbehind cushion so both forward playback and backward scrubbing hit RAM immediately.
        if (cursor < w_start || cursor >= w_end) {
            const int64_t target_start = std::max<int64_t>(0, cursor - kSeekLookbehind);
            const int64_t burst = sync_all_needed ? kFillChunk : (kSeekLookbehind + kSeekBurst);
            refill_from_seek(target_start, burst);
            return;
        }

        // Top up forward prefetch if running low.
        if ((w_end - cursor) < kPrefetchAhead) {
            if (total_frames_ > 0 && w_end >= total_frames_) {
                return; // EOF already buffered
            }
            // Advance win_start first so the audio thread never reads overwritten frames.
            const int64_t desired_end = w_end + kFillChunk;
            const int64_t min_allowed_start = desired_end - static_cast<int64_t>(kRingCap - 1024);
            const int64_t safe_new_start = std::max(w_start, std::min(cursor - kLookbehindGuard, min_allowed_start));
            if (safe_new_start > w_start) {
                win_start_.store(safe_new_start, std::memory_order_release);
            }
            const int64_t cur_start = win_start_.load(std::memory_order_relaxed);
            const int64_t free_space = static_cast<int64_t>(kRingCap - 1024) - (w_end - cur_start);
            if (free_space >= 256) {
                const int64_t to_read = std::min(kFillChunk, free_space);
                read_append(to_read);
            }
        }
    }

    /*
     * Read one interpolated stereo sample at fractional `pos` inside [clip_start, clip_end).
     * Returns true when served from buffered PCM, false if currently outside window (starved).
     * Strict real-time safe when offline_sync == false (ZERO locks, ZERO allocs, ZERO I/O).
     */
    inline bool read_sample(
        double pos,
        int64_t clip_start,
        int64_t clip_end,
        bool loop_window,
        bool offline_sync,
        float& out_l,
        float& out_r
    ) noexcept {
        if (!decoder_open_ || clip_end <= clip_start) {
            out_l = 0.0f;
            out_r = 0.0f;
            return true;
        }

        const int64_t i1 = static_cast<int64_t>(pos);
        const float frac = static_cast<float>(pos - static_cast<double>(i1));
        play_cursor_.store(i1, std::memory_order_release);

        int64_t w_end   = win_end_.load(std::memory_order_acquire);
        int64_t w_start = win_start_.load(std::memory_order_acquire);

        if (offline_sync && (i1 - 1 < w_start || i1 + 2 >= w_end)) {
            const int64_t target_start = std::max<int64_t>(0, i1 - 4);
            refill_from_seek(target_start, kFillChunk);
            w_end   = win_end_.load(std::memory_order_acquire);
            w_start = win_start_.load(std::memory_order_acquire);
        }

        if (i1 < w_start || i1 >= w_end) {
            out_l = 0.0f;
            out_r = 0.0f;
            return false;
        }

        if (frac < 1e-6f) {
            const size_t idx = static_cast<size_t>(i1) & kRingMask;
            out_l = ring_l_[idx];
            out_r = ring_r_[idx];
            return true;
        }

        auto fetch = [&](int64_t f, float& l, float& r) noexcept {
            int64_t cf = f;
            if (loop_window && clip_end > clip_start) {
                const int64_t len = clip_end - clip_start;
                int64_t rel = (cf - clip_start) % len;
                if (rel < 0) rel += len;
                cf = clip_start + rel;
            } else {
                cf = std::clamp(cf, clip_start, clip_end - 1);
            }
            cf = std::clamp(cf, w_start, w_end - 1);
            const size_t idx = static_cast<size_t>(cf) & kRingMask;
            l = ring_l_[idx];
            r = ring_r_[idx];
        };

        float l0, r0, l1, r1, l2, r2, l3, r3;
        fetch(i1 - 1, l0, r0);
        fetch(i1,     l1, r1);
        fetch(i1 + 1, l2, r2);
        fetch(i1 + 2, l3, r3);
        out_l = hermite4(l0, l1, l2, l3, frac);
        out_r = hermite4(r0, r1, r2, r3, frac);
        return true;
    }

private:
    void refill_from_seek(int64_t start_frame, int64_t frames_to_fill) {
        if (!decoder_open_) return;
        start_frame = std::max<int64_t>(0, start_frame);
        // Temporarily invalidate window while seeking so audio thread sees empty rather than torn data.
        win_start_.store(start_frame, std::memory_order_release);
        win_end_.store(start_frame, std::memory_order_release);

        if (ma_decoder_seek_to_pcm_frame(&decoder_, static_cast<ma_uint64>(start_frame)) != MA_SUCCESS) {
            return;
        }
        decoder_pos_ = start_frame;

        int64_t remaining = std::min<int64_t>(frames_to_fill, static_cast<int64_t>(kRingCap - 1024));
        while (remaining > 0) {
            const int64_t batch = std::min(remaining, kFillChunk);
            if (!read_append(batch)) break;
            remaining -= batch;
        }
    }

    bool read_append(int64_t count) {
        if (!decoder_open_ || count <= 0) return false;
        const int64_t batch = std::min(count, kFillChunk);
        ma_uint64 got = 0;
        ma_result res = ma_decoder_read_pcm_frames(
            &decoder_,
            interleaved_scratch_.data(),
            static_cast<ma_uint64>(batch),
            &got
        );
        if (got == 0 || (res != MA_SUCCESS && res != MA_AT_END)) {
            return false;
        }
        const uint32_t ch = std::max<uint32_t>(1u, channels_);
        int64_t pos = decoder_pos_;
        for (ma_uint64 i = 0; i < got; ++i) {
            const size_t dst = static_cast<size_t>(pos + static_cast<int64_t>(i)) & kRingMask;
            const float* src = interleaved_scratch_.data() + static_cast<size_t>(i) * ch;
            ring_l_[dst] = src[0];
            ring_r_[dst] = (ch > 1) ? src[1] : src[0];
        }
        decoder_pos_ += static_cast<int64_t>(got);
        win_end_.store(decoder_pos_, std::memory_order_release);
        return got == static_cast<ma_uint64>(batch);
    }

    ShareSafeVfs* vfs_ = nullptr;
    std::string path_;
    ma_decoder decoder_{};
    bool decoder_open_ = false;
    uint32_t channels_ = 1;
    uint32_t sample_rate_ = SIN_DEFAULT_SAMPLE_RATE;
    int64_t total_frames_ = 0;
    int64_t decoder_pos_ = 0;

    std::vector<float> ring_l_;
    std::vector<float> ring_r_;
    std::vector<float> interleaved_scratch_;

    alignas(64) std::atomic<int64_t> win_start_{0};
    alignas(64) std::atomic<int64_t> win_end_{0};
    alignas(64) std::atomic<int64_t> play_cursor_{0};
};

/*
 * SourcePool manages registered audio sources (control thread only).
 * Probes files via ShareSafeVfs; short files (<30s) decode into immutable RAM PcmBuffer;
 * long files (>=30s) stay disk-streamed (~1MB per active voice).
 */
class SourcePool {
public:
    ShareSafeVfs& vfs() { return vfs_; }

    int32_t register_file(SinSourceId id, const char* utf8_path, bool force_ram) {
        if (!utf8_path || utf8_path[0] == '\0') return -1;
        std::string path(utf8_path);

        ma_decoder dec{};
        ma_decoder_config cfg = ma_decoder_config_init(ma_format_f32, 0, 0);
        if (ma_decoder_init_vfs(vfs_.handle(), path.c_str(), &cfg, &dec) == MA_SUCCESS) {
            const uint32_t ch = dec.outputChannels > 0 ? dec.outputChannels : 1;
            const uint32_t sr = dec.outputSampleRate > 0 ? dec.outputSampleRate : SIN_DEFAULT_SAMPLE_RATE;
            ma_uint64 len = 0;
            ma_result len_res = ma_decoder_get_length_in_pcm_frames(&dec, &len);
            const double dur_sec = (len_res == MA_SUCCESS && sr > 0) ? (static_cast<double>(len) / static_cast<double>(sr)) : 0.0;

            const bool should_ram = force_ram || (len_res == MA_SUCCESS && len > 0 && dur_sec <= kRamResidentMaxSeconds && len <= kRamResidentMaxFrames);

            auto entry = std::make_shared<SourceEntry>();
            entry->id = id;
            entry->filepath = path;
            entry->sample_rate = sr;
            entry->channels = ch;

            if (should_ram) {
                auto pcm = std::make_shared<PcmBuffer>();
                pcm->sample_rate = sr;
                pcm->channels = std::min<uint32_t>(ch, 2u);
                if (len_res == MA_SUCCESS && len > 0) {
                    pcm->ch0.reserve(static_cast<size_t>(len));
                    if (ch > 1) pcm->ch1.reserve(static_cast<size_t>(len));
                }
                constexpr ma_uint64 kChunk = 8192;
                std::vector<float> tmp(static_cast<size_t>(kChunk) * ch);
                for (;;) {
                    ma_uint64 got = 0;
                    ma_result r = ma_decoder_read_pcm_frames(&dec, tmp.data(), kChunk, &got);
                    if (got > 0) {
                        for (ma_uint64 i = 0; i < got; ++i) {
                            const float* p = tmp.data() + static_cast<size_t>(i) * ch;
                            pcm->ch0.push_back(p[0]);
                            if (ch > 1) pcm->ch1.push_back(p[1]);
                        }
                    }
                    if (got < kChunk || r != MA_SUCCESS) break;
                }
                pcm->num_frames = static_cast<uint64_t>(pcm->ch0.size());
                entry->num_frames = pcm->num_frames;
                entry->ram_pcm = std::move(pcm);
                entry->is_streaming = false;
            } else {
                entry->num_frames = static_cast<uint64_t>(len);
                entry->is_streaming = true;
            }
            ma_decoder_uninit(&dec);
            sources_[id] = std::move(entry);
            return 0;
        }

        // Fallback via ffmpeg for containers not natively supported by miniaudio (m4a, aac, ogg, mp4, mov, mkv)
        auto pcm = std::make_shared<PcmBuffer>();
        if (!decode_via_ffmpeg_to_pcm(path, *pcm, SIN_DEFAULT_SAMPLE_RATE)) {
            return -2;
        }
        auto entry = std::make_shared<SourceEntry>();
        entry->id = id;
        entry->filepath = path;
        entry->sample_rate = pcm->sample_rate;
        entry->channels = pcm->channels;
        entry->num_frames = pcm->num_frames;
        entry->ram_pcm = std::move(pcm);
        entry->is_streaming = false;
        entry->use_ffmpeg = true;
        sources_[id] = std::move(entry);
        return 0;
    }

    int32_t register_pcm(
        SinSourceId id,
        const float* ch0,
        const float* ch1,
        uint32_t num_frames,
        uint32_t src_sr,
        uint64_t content_hash
    ) {
        if (!ch0 && num_frames > 0) return -1;
        // Deduplicate unchanged hash on same source id
        auto existing = sources_.find(id);
        if (existing != sources_.end() && existing->second->ram_pcm &&
            content_hash != 0 && existing->second->ram_pcm->content_hash == content_hash &&
            existing->second->ram_pcm->num_frames == num_frames &&
            existing->second->ram_pcm->sample_rate == src_sr) {
            return 0;
        }

        auto pcm = std::make_shared<PcmBuffer>();
        pcm->sample_rate = src_sr > 0 ? src_sr : SIN_DEFAULT_SAMPLE_RATE;
        pcm->channels = ch1 ? 2u : 1u;
        pcm->num_frames = num_frames;
        pcm->content_hash = content_hash;
        if (num_frames > 0) {
            pcm->ch0.assign(ch0, ch0 + num_frames);
            if (ch1) {
                pcm->ch1.assign(ch1, ch1 + num_frames);
            }
        }
        auto entry = std::make_shared<SourceEntry>();
        entry->id = id;
        entry->sample_rate = pcm->sample_rate;
        entry->channels = pcm->channels;
        entry->num_frames = pcm->num_frames;
        entry->ram_pcm = std::move(pcm);
        entry->is_streaming = false;
        sources_[id] = std::move(entry);
        return 0;
    }

    int32_t register_layered(
        SinSourceId id,
        const char* base_utf8_path,
        uint32_t tile_frames,
        uint32_t num_tiles,
        uint32_t tile_sr,
        uint64_t total_tile_frames
    ) {
        if (tile_frames == 0 || num_tiles == 0) return -1;
        std::string base_path = base_utf8_path ? std::string(base_utf8_path) : std::string();

        // Reuse existing layered tile store if geometry & base file match (preserves published tiles across plan edits)
        auto existing = sources_.find(id);
        if (existing != sources_.end() && existing->second && existing->second->layered_tiles) {
            auto& ex = existing->second;
            auto& lt = ex->layered_tiles;
            if (ex->filepath == base_path &&
                lt->tile_frames == tile_frames &&
                lt->num_tiles == num_tiles &&
                lt->sample_rate == (tile_sr > 0 ? tile_sr : SIN_DEFAULT_SAMPLE_RATE)) {
                return 0;
            }
        }

        auto entry = std::make_shared<SourceEntry>();
        entry->id = id;
        entry->filepath = base_path;
        entry->sample_rate = tile_sr > 0 ? tile_sr : SIN_DEFAULT_SAMPLE_RATE;
        entry->channels = 2;
        entry->num_frames = total_tile_frames;
        entry->is_streaming = false;

        if (!base_path.empty()) {
            // Probe base file (never force RAM for long files — always stream raw fallback when >=30s or probe matches)
            ma_decoder dec{};
            ma_decoder_config cfg = ma_decoder_config_init(ma_format_f32, 0, 0);
            if (ma_decoder_init_vfs(vfs_.handle(), base_path.c_str(), &cfg, &dec) == MA_SUCCESS) {
                const uint32_t ch = dec.outputChannels > 0 ? dec.outputChannels : 1;
                const uint32_t sr = dec.outputSampleRate > 0 ? dec.outputSampleRate : entry->sample_rate;
                ma_uint64 len = 0;
                ma_result len_res = ma_decoder_get_length_in_pcm_frames(&dec, &len);
                entry->sample_rate = sr;
                entry->channels = ch;
                if (len_res == MA_SUCCESS && len > 0) {
                    entry->num_frames = static_cast<uint64_t>(len);
                }
                entry->is_streaming = true;
                ma_decoder_uninit(&dec);
            } else {
                // Fallback via ffmpeg for non-miniaudio containers (e.g. m4a/aac/ogg)
                auto pcm = std::make_shared<PcmBuffer>();
                if (decode_via_ffmpeg_to_pcm(base_path, *pcm, entry->sample_rate)) {
                    entry->sample_rate = pcm->sample_rate;
                    entry->channels = pcm->channels;
                    entry->num_frames = pcm->num_frames;
                    entry->ram_pcm = std::move(pcm);
                    entry->is_streaming = false;
                    entry->use_ffmpeg = true;
                }
            }
        }

        auto store = std::make_shared<LayeredTileStore>();
        store->init(
            tile_frames,
            num_tiles,
            total_tile_frames > 0 ? total_tile_frames : entry->num_frames,
            tile_sr > 0 ? tile_sr : entry->sample_rate
        );
        entry->layered_tiles = std::move(store);
        sources_[id] = std::move(entry);
        return 0;
    }

    int32_t set_layered_tile(
        SinSourceId id,
        uint32_t tile_index,
        const float* ch0,
        const float* ch1,
        uint32_t num_frames,
        uint32_t generation
    ) {
        auto it = sources_.find(id);
        if (it == sources_.end() || !it->second || !it->second->layered_tiles) return -1;
        return it->second->layered_tiles->set_tile(tile_index, ch0, ch1, num_frames, generation) ? 0 : -2;
    }

    int32_t clear_layered_tiles(SinSourceId id) {
        auto it = sources_.find(id);
        if (it == sources_.end() || !it->second || !it->second->layered_tiles) return -1;
        it->second->layered_tiles->clear_all();
        return 0;
    }

    std::shared_ptr<SourceEntry> find(SinSourceId id) const {
        auto it = sources_.find(id);
        return it == sources_.end() ? nullptr : it->second;
    }

    int32_t release(SinSourceId id) {
        return sources_.erase(id) > 0 ? 0 : -1;
    }

    void clear() {
        sources_.clear();
    }

private:
    ShareSafeVfs vfs_;
    std::unordered_map<SinSourceId, std::shared_ptr<SourceEntry>> sources_;
};

} // namespace sin_dsp

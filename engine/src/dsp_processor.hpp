#pragma once
#include "../include/sin_dsp.h"
#include "smoother.hpp"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>

namespace sin_dsp {

struct ProcessContext {
    uint32_t sample_rate = SIN_DEFAULT_SAMPLE_RATE;
    uint32_t num_frames = 0;
    double   bpm = 120.0;
    int64_t  playhead_frame = 0;
    bool     offline_mode = false;
};

/* Minimal stereo In -> Out DSP processor contract (audio-thread safe, zero alloc). */
class DspProcessor {
public:
    virtual ~DspProcessor() = default;
    virtual SinProcessorType type_id() const noexcept = 0;
    virtual void prepare(uint32_t sample_rate, uint32_t max_block_size) noexcept = 0;
    virtual void reset() noexcept = 0;
    virtual void set_param(uint32_t param_index, float value, float ramp_ms) noexcept = 0;
    virtual void process(
        const float* in_l, const float* in_r,
        float* out_l, float* out_r,
        const ProcessContext& ctx
    ) noexcept = 0;
};

/* Sole built-in processor today: zipper-free Gain stage (param 0 = linear gain). */
class GainProcessor final : public DspProcessor {
public:
    SinProcessorType type_id() const noexcept override { return SIN_PROC_GAIN; }

    void prepare(uint32_t sr, uint32_t /*max_block*/) noexcept override {
        sr_ = sr > 0 ? sr : SIN_DEFAULT_SAMPLE_RATE;
    }

    void reset() noexcept override {
        gain_sm_.snap(gain_sm_.target);
    }

    void set_param(uint32_t param_index, float value, float ramp_ms) noexcept override {
        if (param_index == 0) {
            gain_sm_.set_target(std::max(0.0f, value), ramp_ms, sr_);
        }
    }

    void process(
        const float* in_l, const float* in_r,
        float* out_l, float* out_r,
        const ProcessContext& ctx
    ) noexcept override {
        if (!in_l || !in_r || !out_l || !out_r || ctx.num_frames == 0) {
            return;
        }
        if (gain_sm_.remaining == 0) {
            const float g = gain_sm_.current;
            if (g == 1.0f) {
                if (in_l != out_l) std::memcpy(out_l, in_l, sizeof(float) * ctx.num_frames);
                if (in_r != out_r) std::memcpy(out_r, in_r, sizeof(float) * ctx.num_frames);
                return;
            }
            if (g == 0.0f) {
                std::memset(out_l, 0, sizeof(float) * ctx.num_frames);
                std::memset(out_r, 0, sizeof(float) * ctx.num_frames);
                return;
            }
            for (uint32_t i = 0; i < ctx.num_frames; ++i) {
                out_l[i] = in_l[i] * g;
                out_r[i] = in_r[i] * g;
            }
            return;
        }
        for (uint32_t i = 0; i < ctx.num_frames; ++i) {
            float g = gain_sm_.current;
            if (gain_sm_.remaining > 0) {
                gain_sm_.current += gain_sm_.step;
                --gain_sm_.remaining;
                if (gain_sm_.remaining == 0) {
                    gain_sm_.current = gain_sm_.target;
                }
                g = gain_sm_.current;
            }
            out_l[i] = in_l[i] * g;
            out_r[i] = in_r[i] * g;
        }
    }

private:
    uint32_t sr_ = SIN_DEFAULT_SAMPLE_RATE;
    ParamSmoother gain_sm_{1.0f, 1.0f, 0.0f, 0};
};

inline std::unique_ptr<DspProcessor> create_processor(SinProcessorType type) {
    switch (type) {
        case SIN_PROC_GAIN: return std::make_unique<GainProcessor>();
        default:            return nullptr;
    }
}

} // namespace sin_dsp

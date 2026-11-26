#pragma once

#include "dsp_module_base.hpp"

namespace sin_fx {

/**
 * Lightweight Waveshaper Clipper (Hard / Soft / Tanh).
 *
 * Parameter layout (5 params):
 *   0: mode       (0=Hard, 1=Soft, 2=Tanh)
 *   1: drive_db   (0..24)
 *   2: ceiling_db (-24..0)
 *   3: softness   (0..1)
 *   4: output_db  (-24..12)
 */
class ClipperModule final : public DspModule {
public:
    void prepare(uint32_t sample_rate, uint32_t /*max_block_size*/) noexcept override {
        sr_ = sample_rate > 0 ? sample_rate : 48000u;
    }

    void reset() noexcept override {
        drive_sm_.snap(db_to_lin(drive_db_));
        ceil_sm_.snap(db_to_lin(ceiling_db_));
        out_sm_.snap(db_to_lin(output_db_));
        meter_atten_db_ = 0.0f;
    }

    void set_param(uint32_t param_index, float value, float ramp_ms) noexcept override {
        switch (param_index) {
            case 0:
                mode_ = std::clamp(static_cast<int>(std::lround(value)), 0, 2);
                break;
            case 1:
                drive_db_ = std::clamp(value, 0.0f, 24.0f);
                drive_sm_.set_target(db_to_lin(drive_db_), ramp_ms, sr_);
                break;
            case 2:
                ceiling_db_ = std::clamp(value, -24.0f, 0.0f);
                ceil_sm_.set_target(db_to_lin(ceiling_db_), ramp_ms, sr_);
                break;
            case 3:
                softness_ = std::clamp(value, 0.0f, 1.0f);
                break;
            case 4:
                output_db_ = std::clamp(value, -24.0f, 12.0f);
                out_sm_.set_target(db_to_lin(output_db_), ramp_ms, sr_);
                break;
            default:
                break;
        }
    }

    void process(
        const float* in_l, const float* in_r,
        float* out_l, float* out_r,
        uint32_t num_frames
    ) noexcept override {
        if (!in_l || !in_r || !out_l || !out_r || num_frames == 0) {
            meter_atten_db_ = 0.0f;
            return;
        }

        const int mode = mode_;
        const float soft = softness_;
        float min_atten_db = 0.0f;

        auto shape = [mode, soft](float x, float ceil) noexcept -> float {
            if (ceil <= 1e-6f) return 0.0f;
            const float n = x / ceil;
            const float ax = std::abs(n);
            float y = n;
            if (mode == 0) {
                y = std::clamp(n, -1.0f, 1.0f);
            } else if (mode == 1) {
                // Soft cubic-knee clip: linear below (1 - s), smooth cubic to +/-1.0
                const float knee = std::clamp(soft, 0.0f, 0.99f);
                const float t = 1.0f - knee;
                if (ax <= t) {
                    y = n;
                } else {
                    const float excess = ax - t;
                    const float span = std::max(1e-4f, knee);
                    const float sat = t + span * std::tanh(excess / span);
                    y = (n >= 0.0f ? 1.0f : -1.0f) * std::min(1.0f, sat);
                }
            } else {
                const float k = 1.0f + (1.0f - soft) * 2.5f;
                const float norm = std::tanh(k);
                y = (norm > 1e-6f) ? (std::tanh(n * k) / norm) : std::tanh(n);
                y = std::clamp(y, -1.0f, 1.0f);
            }
            return y * ceil;
        };

        for (uint32_t i = 0; i < num_frames; ++i) {
            const float drv = drive_sm_.next();
            const float ceil = ceil_sm_.next();
            const float out_g = out_sm_.next();

            const float dl = in_l[i] * drv;
            const float dr = in_r[i] * drv;
            const float sl = shape(dl, ceil);
            const float sr = shape(dr, ceil);

            const float pre_peak = std::max(std::abs(dl), std::abs(dr));
            const float post_peak = std::max(std::abs(sl), std::abs(sr));
            if (pre_peak > post_peak && pre_peak > 1e-6f) {
                const float atten = lin_to_db(std::max(1e-6f, post_peak) / pre_peak);
                if (atten < min_atten_db) min_atten_db = atten;
            }

            out_l[i] = sl * out_g;
            out_r[i] = sr * out_g;
        }

        meter_atten_db_ = min_atten_db;
    }

    float get_meter() const noexcept override { return meter_atten_db_; }

private:
    uint32_t sr_ = 48000u;
    int mode_ = 1;
    float drive_db_ = 0.0f;
    float ceiling_db_ = 0.0f;
    float softness_ = 0.5f;
    float output_db_ = 0.0f;
    float meter_atten_db_ = 0.0f;

    LinearSmoother drive_sm_{1.0f, 1.0f, 0.0f, 0};
    LinearSmoother ceil_sm_{1.0f, 1.0f, 0.0f, 0};
    LinearSmoother out_sm_{1.0f, 1.0f, 0.0f, 0};
};

} // namespace sin_fx

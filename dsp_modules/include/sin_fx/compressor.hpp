#pragma once

#include "dsp_module_base.hpp"

namespace sin_fx {

/**
 * Lightweight Stereo-Linked Feed-Forward Dynamics Compressor.
 *
 * Parameter layout (7 params):
 *   0: threshold_db (-60..0)
 *   1: ratio        (1..20)
 *   2: attack_ms    (0.1..200)
 *   3: release_ms   (5..1000)
 *   4: knee_db      (0..12)
 *   5: makeup_db    (-12..24)
 *   6: mix          (0..100 %)
 */
class CompressorModule final : public DspModule {
public:
    void prepare(uint32_t sample_rate, uint32_t /*max_block_size*/) noexcept override {
        sr_ = sample_rate > 0 ? sample_rate : 48000u;
        update_ballistics();
    }

    void reset() noexcept override {
        env_db_ = -120.0f;
        meter_gr_db_ = 0.0f;
        makeup_sm_.snap(db_to_lin(makeup_db_));
        mix_sm_.snap(mix_pct_ * 0.01f);
    }

    void set_param(uint32_t param_index, float value, float ramp_ms) noexcept override {
        switch (param_index) {
            case 0: threshold_db_ = std::clamp(value, -60.0f, 0.0f); break;
            case 1: ratio_ = std::clamp(value, 1.0f, 20.0f); break;
            case 2: attack_ms_ = std::clamp(value, 0.1f, 200.0f); update_ballistics(); break;
            case 3: release_ms_ = std::clamp(value, 5.0f, 1000.0f); update_ballistics(); break;
            case 4: knee_db_ = std::clamp(value, 0.0f, 12.0f); break;
            case 5:
                makeup_db_ = std::clamp(value, -12.0f, 24.0f);
                makeup_sm_.set_target(db_to_lin(makeup_db_), ramp_ms, sr_);
                break;
            case 6:
                mix_pct_ = std::clamp(value, 0.0f, 100.0f);
                mix_sm_.set_target(mix_pct_ * 0.01f, ramp_ms, sr_);
                break;
            default: break;
        }
    }

    void process(
        const float* in_l, const float* in_r,
        float* out_l, float* out_r,
        uint32_t num_frames
    ) noexcept override {
        if (!in_l || !in_r || !out_l || !out_r || num_frames == 0) {
            meter_gr_db_ = 0.0f;
            return;
        }

        const float thresh = threshold_db_;
        const float slope = 1.0f - (1.0f / std::max(1.0f, ratio_));
        const float knee = std::max(0.0f, knee_db_);
        const float half_knee = 0.5f * knee;
        float min_gr_db = 0.0f;

        for (uint32_t i = 0; i < num_frames; ++i) {
            const float xl = in_l[i];
            const float xr = in_r[i];
            const float det_lin = std::max(std::abs(xl), std::abs(xr));
            const float det_db = lin_to_db(det_lin);

            if (det_db > env_db_) {
                env_db_ = attack_coeff_ * env_db_ + (1.0f - attack_coeff_) * det_db;
            } else {
                env_db_ = release_coeff_ * env_db_ + (1.0f - release_coeff_) * det_db;
            }

            float gr_db = 0.0f;
            const float over = env_db_ - thresh;
            if (knee > 1e-4f) {
                if (over <= -half_knee) {
                    gr_db = 0.0f;
                } else if (over >= half_knee) {
                    gr_db = -slope * over;
                } else {
                    const float x = over + half_knee;
                    gr_db = -slope * (x * x) / (2.0f * knee);
                }
            } else if (over > 0.0f) {
                gr_db = -slope * over;
            }

            if (gr_db < min_gr_db) {
                min_gr_db = gr_db;
            }

            const float comp_gain = db_to_lin(gr_db) * makeup_sm_.next();
            const float wet = mix_sm_.next();
            const float dry = 1.0f - wet;

            out_l[i] = xl * (dry + wet * comp_gain);
            out_r[i] = xr * (dry + wet * comp_gain);
        }

        env_db_ = std::clamp(env_db_, kMinGainDb, 36.0f);
        meter_gr_db_ = min_gr_db;
    }

    float get_meter() const noexcept override { return meter_gr_db_; }

private:
    void update_ballistics() noexcept {
        const float sr = static_cast<float>(sr_ > 0 ? sr_ : 48000u);
        attack_coeff_ = std::exp(-1.0f / std::max(1.0f, (attack_ms_ * 0.001f) * sr));
        release_coeff_ = std::exp(-1.0f / std::max(1.0f, (release_ms_ * 0.001f) * sr));
    }

    uint32_t sr_ = 48000u;
    float threshold_db_ = -18.0f;
    float ratio_ = 4.0f;
    float attack_ms_ = 10.0f;
    float release_ms_ = 100.0f;
    float knee_db_ = 3.0f;
    float makeup_db_ = 0.0f;
    float mix_pct_ = 100.0f;

    float attack_coeff_ = 0.99f;
    float release_coeff_ = 0.999f;
    float env_db_ = -120.0f;
    float meter_gr_db_ = 0.0f;

    LinearSmoother makeup_sm_{1.0f, 1.0f, 0.0f, 0};
    LinearSmoother mix_sm_{1.0f, 1.0f, 0.0f, 0};
};

} // namespace sin_fx

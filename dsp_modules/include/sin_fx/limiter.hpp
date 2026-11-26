#pragma once

#include "dsp_module_base.hpp"
#include <vector>

namespace sin_fx {

/**
 * Lightweight Brickwall Lookahead Peak Limiter.
 *
 * Pre-allocates its stereo lookahead ring buffer inside prepare() so process()
 * performs zero heap allocations.
 *
 * Parameter layout (4 params):
 *   0: input_gain_db (0..24)
 *   1: ceiling_db    (-24..0)
 *   2: release_ms    (5..500)
 *   3: lookahead_ms  (0..10)
 */
class LimiterModule final : public DspModule {
public:
    static constexpr float kMaxLookaheadMs = 10.0f;

    void prepare(uint32_t sample_rate, uint32_t /*max_block_size*/) noexcept override {
        sr_ = sample_rate > 0 ? sample_rate : 48000u;
        const size_t max_delay = static_cast<size_t>(std::ceil((kMaxLookaheadMs * 0.001f) * static_cast<float>(sr_))) + 2u;
        delay_l_.assign(max_delay, 0.0f);
        delay_r_.assign(max_delay, 0.0f);
        write_pos_ = 0;
        update_delay_and_release();
        reset();
    }

    void reset() noexcept override {
        std::fill(delay_l_.begin(), delay_l_.end(), 0.0f);
        std::fill(delay_r_.begin(), delay_r_.end(), 0.0f);
        write_pos_ = 0;
        gain_env_ = 1.0f;
        meter_gr_db_ = 0.0f;
        in_gain_sm_.snap(db_to_lin(input_gain_db_));
        ceil_sm_.snap(db_to_lin(ceiling_db_));
    }

    void set_param(uint32_t param_index, float value, float ramp_ms) noexcept override {
        switch (param_index) {
            case 0:
                input_gain_db_ = std::clamp(value, 0.0f, 24.0f);
                in_gain_sm_.set_target(db_to_lin(input_gain_db_), ramp_ms, sr_);
                break;
            case 1:
                ceiling_db_ = std::clamp(value, -24.0f, 0.0f);
                ceil_sm_.set_target(db_to_lin(ceiling_db_), ramp_ms, sr_);
                break;
            case 2:
                release_ms_ = std::clamp(value, 5.0f, 500.0f);
                update_delay_and_release();
                break;
            case 3:
                lookahead_ms_ = std::clamp(value, 0.0f, kMaxLookaheadMs);
                update_delay_and_release();
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
            meter_gr_db_ = 0.0f;
            return;
        }
        if (delay_l_.empty()) {
            // Defensive safety if process() called before prepare()
            for (uint32_t i = 0; i < num_frames; ++i) {
                const float g = in_gain_sm_.next();
                const float c = ceil_sm_.next();
                out_l[i] = std::clamp(in_l[i] * g, -c, c);
                out_r[i] = std::clamp(in_r[i] * g, -c, c);
            }
            return;
        }

        const size_t cap = delay_l_.size();
        const size_t la = std::min(lookahead_samples_, cap - 1u);
        float min_gr = 1.0f;

        for (uint32_t i = 0; i < num_frames; ++i) {
            const float in_g = in_gain_sm_.next();
            const float ceil = std::max(1e-6f, ceil_sm_.next());

            const float xl = in_l[i] * in_g;
            const float xr = in_r[i] * in_g;

            delay_l_[write_pos_] = xl;
            delay_r_[write_pos_] = xr;

            const size_t read_pos = (write_pos_ + cap - la) % cap;
            const float dl = delay_l_[read_pos];
            const float dr = delay_r_[read_pos];
            write_pos_ = (write_pos_ + 1u) % cap;

            // Detect peak across both the incoming lookahead sample and delayed sample
            const float det_peak = std::max(
                std::max(std::abs(xl), std::abs(xr)),
                std::max(std::abs(dl), std::abs(dr))
            );
            const float target_gain = (det_peak > ceil) ? (ceil / det_peak) : 1.0f;

            if (target_gain < gain_env_) {
                gain_env_ = attack_coeff_ * gain_env_ + (1.0f - attack_coeff_) * target_gain;
                if (gain_env_ > target_gain && la == 0) {
                    gain_env_ = target_gain;
                }
            } else {
                gain_env_ = release_coeff_ * gain_env_ + (1.0f - release_coeff_) * target_gain;
            }
            gain_env_ = std::clamp(gain_env_, 0.0f, 1.0f);

            const float eff_gain = std::min(gain_env_, target_gain);
            if (eff_gain < min_gr) {
                min_gr = eff_gain;
            }

            out_l[i] = std::clamp(dl * eff_gain, -ceil, ceil);
            out_r[i] = std::clamp(dr * eff_gain, -ceil, ceil);
        }

        meter_gr_db_ = (min_gr < 0.9999f) ? lin_to_db(min_gr) : 0.0f;
    }

    float get_meter() const noexcept override { return meter_gr_db_; }
    uint32_t latency_samples() const noexcept override { return static_cast<uint32_t>(lookahead_samples_); }

private:
    void update_delay_and_release() noexcept {
        const float sr = static_cast<float>(sr_ > 0 ? sr_ : 48000u);
        lookahead_samples_ = static_cast<size_t>(std::round((lookahead_ms_ * 0.001f) * sr));
        if (!delay_l_.empty()) {
            lookahead_samples_ = std::min(lookahead_samples_, delay_l_.size() - 1u);
        }
        const float la_sec = std::max(0.0002f, lookahead_ms_ * 0.001f);
        attack_coeff_ = std::exp(-1.0f / std::max(1.0f, 0.25f * la_sec * sr));
        release_coeff_ = std::exp(-1.0f / std::max(1.0f, (release_ms_ * 0.001f) * sr));
    }

    uint32_t sr_ = 48000u;
    float input_gain_db_ = 0.0f;
    float ceiling_db_ = -0.3f;
    float release_ms_ = 60.0f;
    float lookahead_ms_ = 2.0f;

    std::vector<float> delay_l_;
    std::vector<float> delay_r_;
    size_t write_pos_ = 0;
    size_t lookahead_samples_ = 96;

    float attack_coeff_ = 0.95f;
    float release_coeff_ = 0.999f;
    float gain_env_ = 1.0f;
    float meter_gr_db_ = 0.0f;

    LinearSmoother in_gain_sm_{1.0f, 1.0f, 0.0f, 0};
    LinearSmoother ceil_sm_{0.96605f, 0.96605f, 0.0f, 0};
};

} // namespace sin_fx

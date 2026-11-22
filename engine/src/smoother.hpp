#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace sin_dsp {

inline float db_to_linear(float db) noexcept {
    if (db <= -60.0f) return 0.0f;
    return std::pow(10.0f, db / 20.0f);
}

/* Constant-power stereo pan law (-1.0 = full left, 0.0 = center unity, +1.0 = full right).
 * At pan = 0.0, both L and R gains equal 1.0 (bit-exact pass-through at center!). */
inline void pan_gains(float pan, float& out_l, float& out_r) noexcept {
    const float p = std::clamp(pan, -1.0f, 1.0f);
    if (std::abs(p) < 1e-6f) {
        out_l = 1.0f;
        out_r = 1.0f;
        return;
    }
    constexpr float kHalfPi = 1.5707963267948966f;
    constexpr float kSqrt2  = 1.4142135623730951f;
    const float angle = (p * 0.5f + 0.5f) * kHalfPi;
    out_l = std::min(1.0f, std::cos(angle) * kSqrt2);
    out_r = std::min(1.0f, std::sin(angle) * kSqrt2);
}

/*
 * Zipper-free linear ramp parameter smoother.
 * Snaps immediately when ramp_ms <= 0 or offline_mode is enabled.
 */
struct ParamSmoother {
    float current = 0.0f;
    float target  = 0.0f;
    float step    = 0.0f;
    uint32_t remaining = 0;

    void snap(float value) noexcept {
        current = value;
        target = value;
        step = 0.0f;
        remaining = 0;
    }

    void set_target(float new_target, float ramp_ms, uint32_t sample_rate) noexcept {
        target = new_target;
        if (ramp_ms <= 0.0f || sample_rate == 0) {
            snap(new_target);
            return;
        }
        const float samples_f = (ramp_ms * 0.001f) * static_cast<float>(sample_rate);
        const uint32_t samples = samples_f < 1.0f ? 0u : static_cast<uint32_t>(samples_f);
        if (samples == 0 || std::abs(new_target - current) < 1e-7f) {
            snap(new_target);
            return;
        }
        remaining = samples;
        step = (new_target - current) / static_cast<float>(samples);
    }

    inline float next() noexcept {
        if (remaining > 0) {
            current += step;
            --remaining;
            if (remaining == 0) {
                current = target;
                step = 0.0f;
            }
        }
        return current;
    }

    inline bool is_smoothing() const noexcept {
        return remaining > 0;
    }
};

} // namespace sin_dsp

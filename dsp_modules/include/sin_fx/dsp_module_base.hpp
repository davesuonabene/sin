#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace sin_fx {

constexpr float kPi = 3.14159265358979323846f;
constexpr float kMinGainDb = -120.0f;

inline float db_to_lin(float db) noexcept {
    if (db <= kMinGainDb) return 0.0f;
    return std::pow(10.0f, db * 0.05f);
}

inline float lin_to_db(float lin) noexcept {
    const float mag = std::abs(lin);
    if (mag <= 1e-6f) return kMinGainDb;
    return 20.0f * std::log10(mag);
}

inline float flush_denormal(float v) noexcept {
    return (std::abs(v) < 1e-20f) ? 0.0f : v;
}

/**
 * Self-contained linear parameter smoother with zero host dependencies.
 */
struct LinearSmoother {
    float current = 0.0f;
    float target = 0.0f;
    float step = 0.0f;
    uint32_t remaining = 0;

    void snap(float value) noexcept {
        current = value;
        target = value;
        step = 0.0f;
        remaining = 0;
    }

    void set_target(float value, float ramp_ms, uint32_t sample_rate) noexcept {
        target = value;
        if (ramp_ms <= 0.0f || sample_rate == 0) {
            snap(value);
            return;
        }
        const float samples_f = (ramp_ms * 0.001f) * static_cast<float>(sample_rate);
        const uint32_t n = static_cast<uint32_t>(std::max(1.0f, std::round(samples_f)));
        if (n <= 1 || std::abs(target - current) < 1e-7f) {
            snap(value);
            return;
        }
        step = (target - current) / static_cast<float>(n);
        remaining = n;
    }

    float next() noexcept {
        if (remaining == 0) return current;
        current += step;
        --remaining;
        if (remaining == 0) {
            current = target;
        }
        return current;
    }

    bool is_smoothing() const noexcept { return remaining > 0; }
};

/**
 * Pure standalone stereo DSP module interface (zero SIN host dependencies).
 * Designed for audio-thread safety (zero heap allocations inside process()).
 */
class DspModule {
public:
    virtual ~DspModule() = default;
    virtual void prepare(uint32_t sample_rate, uint32_t max_block_size) noexcept = 0;
    virtual void reset() noexcept = 0;
    virtual void set_param(uint32_t param_index, float value, float ramp_ms) noexcept = 0;
    virtual void process(
        const float* in_l, const float* in_r,
        float* out_l, float* out_r,
        uint32_t num_frames
    ) noexcept = 0;
    virtual float get_meter() const noexcept { return 0.0f; }
    virtual uint32_t latency_samples() const noexcept { return 0; }
};

} // namespace sin_fx

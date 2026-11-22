#pragma once

#include <algorithm>
#include <cstdint>

namespace sin_dsp {

/* 4-point Catmull-Rom Hermite cubic interpolation (C1 smooth, minimal aliasing, ~6 flops/sample). */
inline float hermite4(float y0, float y1, float y2, float y3, float t) noexcept {
    const float c0 = y1;
    const float c1 = 0.5f * (y2 - y0);
    const float c2 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    const float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + c0;
}

inline float sample_clamped(const float* buf, int64_t idx, int64_t min_idx, int64_t max_idx) noexcept {
    const int64_t clamped = std::clamp(idx, min_idx, max_idx);
    return buf[clamped];
}

inline float sample_wrapped(const float* buf, int64_t idx, int64_t win_start, int64_t win_len) noexcept {
    int64_t rel = (idx - win_start) % win_len;
    if (rel < 0) rel += win_len;
    return buf[win_start + rel];
}

/* Read one stereo sample at fractional source position `pos` within [win_start, win_end). */
inline void read_planar_resampled(
    const float* ch0,
    const float* ch1,
    double pos,
    int64_t win_start,
    int64_t win_end,
    bool loop_window,
    float& out_l,
    float& out_r
) noexcept {
    const int64_t win_len = win_end - win_start;
    if (win_len <= 0 || !ch0) {
        out_l = 0.0f;
        out_r = 0.0f;
        return;
    }

    const int64_t i1 = static_cast<int64_t>(pos);
    const float frac = static_cast<float>(pos - static_cast<double>(i1));
    const float* r_ptr = ch1 ? ch1 : ch0;

    if (frac < 1e-6f && i1 >= win_start && i1 < win_end) {
        out_l = ch0[i1];
        out_r = r_ptr[i1];
        return;
    }

    if (loop_window && win_len > 1) {
        const float l0 = sample_wrapped(ch0, i1 - 1, win_start, win_len);
        const float l1 = sample_wrapped(ch0, i1,     win_start, win_len);
        const float l2 = sample_wrapped(ch0, i1 + 1, win_start, win_len);
        const float l3 = sample_wrapped(ch0, i1 + 2, win_start, win_len);
        out_l = hermite4(l0, l1, l2, l3, frac);
        if (r_ptr == ch0) {
            out_r = out_l;
        } else {
            const float r0 = sample_wrapped(r_ptr, i1 - 1, win_start, win_len);
            const float r1 = sample_wrapped(r_ptr, i1,     win_start, win_len);
            const float r2 = sample_wrapped(r_ptr, i1 + 1, win_start, win_len);
            const float r3 = sample_wrapped(r_ptr, i1 + 2, win_start, win_len);
            out_r = hermite4(r0, r1, r2, r3, frac);
        }
    } else {
        const int64_t max_idx = win_end - 1;
        const float l0 = sample_clamped(ch0, i1 - 1, win_start, max_idx);
        const float l1 = sample_clamped(ch0, i1,     win_start, max_idx);
        const float l2 = sample_clamped(ch0, i1 + 1, win_start, max_idx);
        const float l3 = sample_clamped(ch0, i1 + 2, win_start, max_idx);
        out_l = hermite4(l0, l1, l2, l3, frac);
        if (r_ptr == ch0) {
            out_r = out_l;
        } else {
            const float r0 = sample_clamped(r_ptr, i1 - 1, win_start, max_idx);
            const float r1 = sample_clamped(r_ptr, i1,     win_start, max_idx);
            const float r2 = sample_clamped(r_ptr, i1 + 1, win_start, max_idx);
            const float r3 = sample_clamped(r_ptr, i1 + 2, win_start, max_idx);
            out_r = hermite4(r0, r1, r2, r3, frac);
        }
    }
}

} // namespace sin_dsp

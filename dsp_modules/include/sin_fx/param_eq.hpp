#pragma once

#include "dsp_module_base.hpp"
#include <array>
#include <cmath>
#include <cstring>

namespace sin_fx {

/**
 * Lightweight 4-band Parametric EQ with per-band selectable filter curves:
 *   0 = Low Cut  (1st..8th-order Butterworth HPF, 6..48 dB/oct controlled by Q)
 *   1 = Low Shelf (RBJ)
 *   2 = Bell      (RBJ Peaking)
 *   3 = Notch     (RBJ Band-Reject)
 *   4 = High Shelf (RBJ)
 *   5 = High Cut (1st..8th-order Butterworth LPF, 6..48 dB/oct controlled by Q)
 *
 * Parameter layout (20 params, 5 per band):
 *   Band k (0..3) starts at base = k * 5:
 *     base + 0: enabled (0 or 1)
 *     base + 1: type    (0..5)
 *     base + 2: freq    (Hz, 20..20000)
 *     base + 3: gain    (dB, -18..18)
 *     base + 4: q       (0.2..12.0; for Low Cut / High Cut maps log-Q -> 6..48 dB/oct)
 */
class ParamEqModule final : public DspModule {
public:
    enum class BandKind : uint8_t {
        LowCut = 0,
        LowShelf = 1,
        Bell = 2,
        Notch = 3,
        HighShelf = 4,
        HighCut = 5,
    };

    static constexpr uint32_t kMaxSectionsPerBand = 4u;

    /**
     * Maps Q in [0.2, 12.0] logarithmically to Butterworth filter order 1..8
     * (6, 12, 18, 24, 30, 36, 42, 48 dB/oct).
     */
    static uint32_t q_to_cutoff_order(float q) noexcept {
        constexpr float kMinQ = 0.2f;
        constexpr float kMaxQ = 12.0f;
        const float clamped = std::clamp(q, kMinQ, kMaxQ);
        const float t = (std::log(clamped) - std::log(kMinQ)) / (std::log(kMaxQ) - std::log(kMinQ));
        const int order = static_cast<int>(std::lround(1.0f + std::clamp(t, 0.0f, 1.0f) * 7.0f));
        return static_cast<uint32_t>(std::clamp(order, 1, 8));
    }

    ParamEqModule() noexcept {
        init_band(bands_[0], BandKind::LowShelf,  true,  100.0f, 0.0f, 0.71f);
        init_band(bands_[1], BandKind::Bell,      true,  400.0f, 0.0f, 1.00f);
        init_band(bands_[2], BandKind::Bell,      true, 2500.0f, 0.0f, 1.00f);
        init_band(bands_[3], BandKind::HighShelf, true, 8000.0f, 0.0f, 0.71f);
    }

    void prepare(uint32_t sample_rate, uint32_t /*max_block_size*/) noexcept override {
        sr_ = sample_rate > 0 ? sample_rate : 48000u;
        for (auto& b : bands_) {
            b.dirty = true;
        }
        update_all_coeffs();
    }

    void reset() noexcept override {
        for (auto& b : bands_) {
            clear_band_states(b);
        }
        meter_peak_ = 0.0f;
    }

    void set_param(uint32_t param_index, float value, float /*ramp_ms*/) noexcept override {
        const uint32_t band_idx = param_index / 5u;
        const uint32_t sub_idx = param_index % 5u;
        if (band_idx >= 4u) return;

        Band& b = bands_[band_idx];
        switch (sub_idx) {
            case 0:
                b.enabled = (value >= 0.5f);
                if (!b.enabled) {
                    clear_band_states(b);
                }
                break;
            case 1: {
                const int raw = static_cast<int>(std::lround(value));
                const auto next_kind = static_cast<BandKind>(std::clamp(raw, 0, 5));
                if (next_kind != b.kind) {
                    b.kind = next_kind;
                    clear_band_states(b);
                    b.dirty = true;
                }
                break;
            }
            case 2:
                b.freq = std::clamp(value, 20.0f, 20000.0f);
                b.dirty = true;
                break;
            case 3:
                b.gain_db = std::clamp(value, -18.0f, 18.0f);
                b.dirty = true;
                break;
            case 4:
                b.q = std::clamp(value, 0.2f, 12.0f);
                b.dirty = true;
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
            meter_peak_ = 0.0f;
            return;
        }
        if (in_l != out_l) std::memcpy(out_l, in_l, sizeof(float) * num_frames);
        if (in_r != out_r) std::memcpy(out_r, in_r, sizeof(float) * num_frames);

        update_all_coeffs();

        for (auto& b : bands_) {
            if (!b.enabled || b.num_sections == 0u) {
                continue;
            }
            const bool is_gain_dependent =
                b.kind == BandKind::LowShelf || b.kind == BandKind::Bell || b.kind == BandKind::HighShelf;
            if (is_gain_dependent && std::abs(b.gain_db) < 1e-4f) {
                continue;
            }

            for (uint32_t s = 0; s < b.num_sections; ++s) {
                BiquadSection& sec = b.sections[s];
                const float b0 = sec.b0, b1 = sec.b1, b2 = sec.b2;
                const float a1 = sec.a1, a2 = sec.a2;
                float z1_l = sec.z1_l, z2_l = sec.z2_l;
                float z1_r = sec.z1_r, z2_r = sec.z2_r;

                for (uint32_t i = 0; i < num_frames; ++i) {
                    const float xl = out_l[i];
                    const float yl = b0 * xl + z1_l;
                    z1_l = b1 * xl - a1 * yl + z2_l;
                    z2_l = b2 * xl - a2 * yl;
                    out_l[i] = yl;

                    const float xr = out_r[i];
                    const float yr = b0 * xr + z1_r;
                    z1_r = b1 * xr - a1 * yr + z2_r;
                    z2_r = b2 * xr - a2 * yr;
                    out_r[i] = yr;
                }
                sec.z1_l = flush_denormal(z1_l);
                sec.z2_l = flush_denormal(z2_l);
                sec.z1_r = flush_denormal(z1_r);
                sec.z2_r = flush_denormal(z2_r);
            }
        }

        float peak = 0.0f;
        for (uint32_t i = 0; i < num_frames; ++i) {
            const float p = std::max(std::abs(out_l[i]), std::abs(out_r[i]));
            if (p > peak) peak = p;
        }
        meter_peak_ = peak;
    }

    float get_meter() const noexcept override { return meter_peak_; }

private:
    struct BiquadSection {
        float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
        float a1 = 0.0f, a2 = 0.0f;
        float z1_l = 0.0f, z2_l = 0.0f;
        float z1_r = 0.0f, z2_r = 0.0f;
    };

    struct Band {
        BandKind kind = BandKind::Bell;
        bool enabled = true;
        float freq = 1000.0f;
        float gain_db = 0.0f;
        float q = 1.0f;
        bool dirty = true;
        uint32_t num_sections = 1u;
        std::array<BiquadSection, kMaxSectionsPerBand> sections{};
    };

    static void init_band(Band& b, BandKind kind, bool enabled, float freq, float gain_db, float q) noexcept {
        b.kind = kind;
        b.enabled = enabled;
        b.freq = freq;
        b.gain_db = gain_db;
        b.q = q;
        b.dirty = true;
        b.num_sections = 1u;
        clear_band_states(b);
    }

    static void clear_band_states(Band& b) noexcept {
        for (auto& s : b.sections) {
            s.z1_l = s.z2_l = s.z1_r = s.z2_r = 0.0f;
        }
    }

    static void assign_normalized(BiquadSection& sec, float b0, float b1, float b2, float a0, float a1, float a2) noexcept {
        const float inv_a0 = 1.0f / std::max(1e-12f, a0);
        sec.b0 = b0 * inv_a0;
        sec.b1 = b1 * inv_a0;
        sec.b2 = b2 * inv_a0;
        sec.a1 = a1 * inv_a0;
        sec.a2 = a2 * inv_a0;
    }

    void update_all_coeffs() noexcept {
        for (auto& b : bands_) {
            if (b.dirty) {
                compute_coeffs(b);
                b.dirty = false;
            }
        }
    }

    void compute_coeffs(Band& b) const noexcept {
        const float sr = static_cast<float>(sr_ > 0 ? sr_ : 48000u);
        const float max_f = std::max(40.0f, 0.45f * sr);
        const float f0 = std::clamp(b.freq, 20.0f, max_f);
        const float w0 = 2.0f * kPi * (f0 / sr);
        const float cos_w0 = std::cos(w0);
        const float sin_w0 = std::sin(w0);

        const uint32_t prev_sections = b.num_sections;

        if (b.kind == BandKind::LowCut || b.kind == BandKind::HighCut) {
            const bool is_hp = (b.kind == BandKind::LowCut);
            const uint32_t order = q_to_cutoff_order(b.q); // 1..8 -> 6..48 dB/oct
            uint32_t idx = 0u;

            // Odd Butterworth orders include one 1st-order bilinear section
            if ((order & 1u) != 0u) {
                const float K = std::tan(kPi * (f0 / sr));
                const float norm = 1.0f / (1.0f + K);
                BiquadSection& sec = b.sections[idx++];
                if (is_hp) {
                    sec.b0 = norm;
                    sec.b1 = -norm;
                } else {
                    sec.b0 = K * norm;
                    sec.b1 = K * norm;
                }
                sec.b2 = 0.0f;
                sec.a1 = (K - 1.0f) * norm;
                sec.a2 = 0.0f;
            }

            const uint32_t pairs = order / 2u;
            for (uint32_t m = 0u; m < pairs && idx < kMaxSectionsPerBand; ++m) {
                const float pole_sin = std::sin(kPi * static_cast<float>(2u * m + 1u) / static_cast<float>(2u * order));
                const float q_m = 1.0f / std::max(1e-4f, 2.0f * pole_sin);
                const float alpha = sin_w0 / (2.0f * q_m);
                if (is_hp) {
                    const float c = 0.5f * (1.0f + cos_w0);
                    assign_normalized(b.sections[idx++], c, -(1.0f + cos_w0), c, 1.0f + alpha, -2.0f * cos_w0, 1.0f - alpha);
                } else {
                    const float c = 0.5f * (1.0f - cos_w0);
                    assign_normalized(b.sections[idx++], c, (1.0f - cos_w0), c, 1.0f + alpha, -2.0f * cos_w0, 1.0f - alpha);
                }
            }

            b.num_sections = idx;
            for (uint32_t s = b.num_sections; s < kMaxSectionsPerBand; ++s) {
                b.sections[s].z1_l = b.sections[s].z2_l = b.sections[s].z1_r = b.sections[s].z2_r = 0.0f;
            }
            if (b.num_sections > prev_sections) {
                for (uint32_t s = prev_sections; s < b.num_sections; ++s) {
                    b.sections[s].z1_l = b.sections[s].z2_l = b.sections[s].z1_r = b.sections[s].z2_r = 0.0f;
                }
            }
            return;
        }

        // Single-section RBJ filters (Low Shelf, Bell, Notch, High Shelf)
        b.num_sections = 1u;
        for (uint32_t s = 1u; s < kMaxSectionsPerBand; ++s) {
            b.sections[s].z1_l = b.sections[s].z2_l = b.sections[s].z1_r = b.sections[s].z2_r = 0.0f;
        }

        const float A = std::pow(10.0f, b.gain_db / 40.0f);
        const float q = std::max(0.1f, b.q);
        float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
        float a0 = 1.0f, a1 = 0.0f, a2 = 0.0f;

        if (b.kind == BandKind::Bell) {
            const float alpha = sin_w0 / (2.0f * q);
            b0 = 1.0f + alpha * A;
            b1 = -2.0f * cos_w0;
            b2 = 1.0f - alpha * A;
            a0 = 1.0f + alpha / A;
            a1 = -2.0f * cos_w0;
            a2 = 1.0f - alpha / A;
        } else if (b.kind == BandKind::Notch) {
            const float alpha = sin_w0 / (2.0f * q);
            b0 = 1.0f;
            b1 = -2.0f * cos_w0;
            b2 = 1.0f;
            a0 = 1.0f + alpha;
            a1 = -2.0f * cos_w0;
            a2 = 1.0f - alpha;
        } else if (b.kind == BandKind::LowShelf) {
            const float alpha = (sin_w0 / 2.0f) * std::sqrt(std::max(0.01f, (A + 1.0f / A) * (1.0f / q - 1.0f) + 2.0f));
            const float two_sqrt_a_alpha = 2.0f * std::sqrt(A) * alpha;
            b0 = A * ((A + 1.0f) - (A - 1.0f) * cos_w0 + two_sqrt_a_alpha);
            b1 = 2.0f * A * ((A - 1.0f) - (A + 1.0f) * cos_w0);
            b2 = A * ((A + 1.0f) - (A - 1.0f) * cos_w0 - two_sqrt_a_alpha);
            a0 = (A + 1.0f) + (A - 1.0f) * cos_w0 + two_sqrt_a_alpha;
            a1 = -2.0f * ((A - 1.0f) + (A + 1.0f) * cos_w0);
            a2 = (A + 1.0f) + (A - 1.0f) * cos_w0 - two_sqrt_a_alpha;
        } else { // HighShelf
            const float alpha = (sin_w0 / 2.0f) * std::sqrt(std::max(0.01f, (A + 1.0f / A) * (1.0f / q - 1.0f) + 2.0f));
            const float two_sqrt_a_alpha = 2.0f * std::sqrt(A) * alpha;
            b0 = A * ((A + 1.0f) + (A - 1.0f) * cos_w0 + two_sqrt_a_alpha);
            b1 = -2.0f * A * ((A - 1.0f) + (A + 1.0f) * cos_w0);
            b2 = A * ((A + 1.0f) + (A - 1.0f) * cos_w0 - two_sqrt_a_alpha);
            a0 = (A + 1.0f) - (A - 1.0f) * cos_w0 + two_sqrt_a_alpha;
            a1 = 2.0f * ((A - 1.0f) - (A + 1.0f) * cos_w0);
            a2 = (A + 1.0f) - (A - 1.0f) * cos_w0 - two_sqrt_a_alpha;
        }

        assign_normalized(b.sections[0], b0, b1, b2, a0, a1, a2);
    }

    uint32_t sr_ = 48000u;
    std::array<Band, 4> bands_{};
    float meter_peak_ = 0.0f;
};

} // namespace sin_fx

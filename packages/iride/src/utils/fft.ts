/**
 * Zero-allocation 1024-point LUT-accelerated radix-2 FFT and logarithmic frequency mapper
 * for high-precision real-time spectrum analysis in IRIDE.
 */

export const FFT_SIZE = 1024;
const FFT_BITS = 10;
const HALF_FFT = FFT_SIZE >> 1;

const HANN_WINDOW = new Float32Array(FFT_SIZE);
const BIT_REV = new Uint16Array(FFT_SIZE);
const TWIDDLE_COS = new Float32Array(HALF_FFT);
const TWIDDLE_SIN = new Float32Array(HALF_FFT);

const scratchRe = new Float32Array(FFT_SIZE);
const scratchIm = new Float32Array(FFT_SIZE);
const scratchMag = new Float32Array(HALF_FFT);

// Precompute window, bit-reversal table, and exact trig lookup tables once at module load
(function initFftTables() {
    for (let i = 0; i < FFT_SIZE; i++) {
        HANN_WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
        let rev = 0;
        let val = i;
        for (let b = 0; b < FFT_BITS; b++) {
            rev = (rev << 1) | (val & 1);
            val >>= 1;
        }
        BIT_REV[i] = rev;
    }
    for (let k = 0; k < HALF_FFT; k++) {
        const angle = (-2 * Math.PI * k) / FFT_SIZE;
        TWIDDLE_COS[k] = Math.cos(angle);
        TWIDDLE_SIN[k] = Math.sin(angle);
    }
})();

/**
 * Computes normalized [0..1] logarithmic frequency points (30 Hz - 20 kHz)
 * from a time-domain sample slice using a 1024-point LUT radix-2 FFT.
 */
export function computeLogSpectrum(
    samples: Float32Array,
    outBands: Float32Array,
    sampleRate = 44100
): void {
    const numBands = outBands.length;
    if (numBands === 0) return;

    // Fast silence short-circuit
    let energy = 0;
    const len = Math.min(FFT_SIZE, samples.length);
    for (let i = 0; i < len; i++) {
        const s = samples[i];
        energy += s * s;
    }
    if (energy < 1e-10) {
        outBands.fill(0);
        return;
    }

    // Window and bit-reverse copy (zero-pad if input slice is shorter than FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) {
        const s = i < len ? samples[i] : 0;
        const revIdx = BIT_REV[i];
        scratchRe[revIdx] = s * HANN_WINDOW[i];
        scratchIm[revIdx] = 0;
    }

    // In-place radix-2 Cooley-Tukey FFT using precomputed twiddle LUTs
    for (let size = 2; size <= FFT_SIZE; size <<= 1) {
        const half = size >> 1;
        const stride = FFT_SIZE / size;

        for (let start = 0; start < FFT_SIZE; start += size) {
            for (let k = 0; k < half; k++) {
                const twiddleIdx = k * stride;
                const wRe = TWIDDLE_COS[twiddleIdx];
                const wIm = TWIDDLE_SIN[twiddleIdx];

                const evenIdx = start + k;
                const oddIdx = evenIdx + half;

                const oRe = scratchRe[oddIdx];
                const oIm = scratchIm[oddIdx];

                const tRe = wRe * oRe - wIm * oIm;
                const tIm = wRe * oIm + wIm * oRe;

                scratchRe[oddIdx] = scratchRe[evenIdx] - tRe;
                scratchIm[oddIdx] = scratchIm[evenIdx] - tIm;
                scratchRe[evenIdx] += tRe;
                scratchIm[evenIdx] += tIm;
            }
        }
    }

    // Normalized magnitudes for positive frequencies
    const invScale = 1 / (len * 0.25);
    scratchMag[0] = 0;
    for (let k = 1; k < HALF_FFT; k++) {
        const re = scratchRe[k];
        const im = scratchIm[k];
        scratchMag[k] = Math.sqrt(re * re + im * im) * invScale;
    }

    // Map FFT bins to logarithmic frequency coordinates (30 Hz to 20 kHz)
    const minFreq = 30;
    const maxFreq = Math.min(20000, sampleRate * 0.48);
    const freqRatio = maxFreq / minFreq;
    const binHz = sampleRate / FFT_SIZE;
    const minDb = -64;
    const invDbRange = 1 / 64;

    for (let b = 0; b < numBands; b++) {
        const t0 = b / numBands;
        const t1 = (b + 1) / numBands;
        const f0 = minFreq * Math.pow(freqRatio, t0);
        const f1 = minFreq * Math.pow(freqRatio, t1);
        const centerFreq = Math.sqrt(f0 * f1);

        const bin0 = Math.max(1, Math.min(HALF_FFT - 1, f0 / binHz));
        const bin1 = Math.max(bin0, Math.min(HALF_FFT - 1, f1 / binHz));

        let mag = 0;
        if (bin1 - bin0 < 1.0) {
            // Smooth cubic/linear interpolation between adjacent bins for sub-bass precision
            const i0 = Math.floor(bin0);
            const frac = bin0 - i0;
            const m0 = scratchMag[i0] || 0;
            const m1 = scratchMag[Math.min(HALF_FFT - 1, i0 + 1)] || 0;
            mag = m0 + (m1 - m0) * frac;
        } else {
            const i0 = Math.floor(bin0);
            const i1 = Math.ceil(bin1);
            for (let k = i0; k <= i1; k++) {
                if (scratchMag[k] > mag) mag = scratchMag[k];
            }
        }

        if (mag <= 1e-5) {
            outBands[b] = 0;
        } else {
            // +3 dB/octave analytical tilt relative to 400 Hz so highs and lows read clearly
            const tiltDb = 3.0 * Math.log2(Math.max(60, centerFreq) / 400);
            const db = 20 * Math.log10(mag) + tiltDb;
            outBands[b] = Math.max(0, Math.min(1, (db - minDb) * invDbRange));
        }
    }
}

/**
 * Maps WebAudio AnalyserNode byte frequency bins (0..255) into logarithmic coordinates.
 */
export function computeLogSpectrumFromByteBins(
    byteBins: Uint8Array,
    outBands: Float32Array
): void {
    const numBands = outBands.length;
    const binCount = byteBins.length;
    if (numBands === 0 || binCount === 0) {
        outBands.fill(0);
        return;
    }

    for (let b = 0; b < numBands; b++) {
        const t0 = Math.pow(b / numBands, 2.0);
        const t1 = Math.pow((b + 1) / numBands, 2.0);
        const bin0 = Math.max(1, Math.min(binCount - 1, t0 * (binCount - 1)));
        const bin1 = Math.max(bin0, Math.min(binCount - 1, t1 * (binCount - 1)));

        if (bin1 - bin0 < 1.0) {
            const i0 = Math.floor(bin0);
            const frac = bin0 - i0;
            const v0 = byteBins[i0] || 0;
            const v1 = byteBins[Math.min(binCount - 1, i0 + 1)] || 0;
            outBands[b] = (v0 + (v1 - v0) * frac) / 255;
        } else {
            const i0 = Math.floor(bin0);
            const i1 = Math.ceil(bin1);
            let maxVal = 0;
            for (let k = i0; k <= i1; k++) {
                if (byteBins[k] > maxVal) maxVal = byteBins[k];
            }
            outBands[b] = maxVal / 255;
        }
    }
}

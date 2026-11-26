import {
    type ChainModuleInstance,
    type DspProcessorDef,
    type ProcessorParamDef,
    getPrePostGainDb,
    readChainParamValue,
} from '../../../dsp/processorRegistry.ts';
import { type BaseNode } from '../../../nodes/BaseNode.ts';
import { defaultTransportClock } from '../../../../../packages/iride/src/telemetry/TransportClock.ts';
import { type SignalTelemetry, type WaveformSignal } from '../../../../../packages/iride/src/types.ts';
import {
    FFT_SIZE,
    computeLogSpectrum,
    computeLogSpectrumFromByteBins,
} from '../../../../../packages/iride/src/utils/fft.ts';

export interface FxVisualHandle {
    element: HTMLElement;
    syncFromParams(): void;
    updateMeter(meterValue: number): void;
    refreshWaveform?(): void;
    destroy(): void;
}

export interface FxVisualContext {
    node?: BaseNode;
    module: ChainModuleInstance;
    def: DspProcessorDef;
    onParamChange: (paramKey: string, value: number) => void;
}

type FxVisualFactory = (ctx: FxVisualContext) => FxVisualHandle;

/* ---------------- Shared Canvas & Minimal Control Helpers ---------------- */

function setupHiDpiCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D | null {
    const dpr = Math.min(2, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

interface PillOverrides {
    label?: () => string;
    formatValue?: (v: number) => string;
    hidden?: () => boolean;
}

function makeParamPill(
    ctx: FxVisualContext,
    param: ProcessorParamDef,
    onLocalUpdate: () => void,
    overrides?: PillOverrides
): { element: HTMLElement; sync: () => void } {
    const pill = document.createElement('div');
    pill.className = 'fx-vis-param-pill';
    pill.title = `${param.label} (drag horizontally, scroll, or double-click to type)`;

    const fill = document.createElement('span');
    fill.className = 'fx-vis-pill-fill';
    const lbl = document.createElement('span');
    lbl.className = 'fx-vis-pill-label';
    const valEl = document.createElement('span');
    valEl.className = 'fx-vis-pill-val';
    pill.append(fill, lbl, valEl);

    const defaultFormatVal = (v: number): string => {
        if (param.unit === '%') return `${Math.round(v)}%`;
        if (param.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(2)}k` : `${Math.round(v)}`;
        if (param.unit === ':1') return `${v.toFixed(1)}:1`;
        const decimals = param.step < 0.1 ? 2 : (param.step < 1 ? 1 : 0);
        return `${v.toFixed(decimals)}${param.unit ? ` ${param.unit}` : ''}`;
    };

    const toNorm = (v: number): number => {
        if (param.scale === 'log' && param.min > 0 && param.max > param.min) {
            const lMin = Math.log(param.min);
            const lMax = Math.log(param.max);
            return Math.max(0, Math.min(1, (Math.log(Math.max(param.min, v)) - lMin) / (lMax - lMin)));
        }
        const span = param.max - param.min || 1;
        return Math.max(0, Math.min(1, (v - param.min) / span));
    };

    const fromNorm = (t: number): number => {
        const clampedT = Math.max(0, Math.min(1, t));
        let raw: number;
        if (param.scale === 'log' && param.min > 0 && param.max > param.min) {
            const lMin = Math.log(param.min);
            const lMax = Math.log(param.max);
            raw = Math.exp(lMin + clampedT * (lMax - lMin));
        } else {
            raw = param.min + clampedT * (param.max - param.min);
        }
        const step = param.step || 0.1;
        const snapped = Math.round(raw / step) * step;
        return Math.max(param.min, Math.min(param.max, Number(snapped.toFixed(4))));
    };

    const sync = () => {
        if (overrides?.hidden) {
            pill.hidden = overrides.hidden();
        }
        lbl.textContent = overrides?.label ? overrides.label() : param.label;
        const cur = readChainParamValue(ctx.module, param);
        valEl.textContent = overrides?.formatValue ? overrides.formatValue(cur) : defaultFormatVal(cur);
        fill.style.width = `${toNorm(cur) * 100}%`;
    };
    sync();

    let dragging = false;
    let startX = 0;
    let startNorm = 0;
    pill.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || pill.querySelector('input')) return;
        dragging = true;
        startX = e.clientX;
        startNorm = toNorm(readChainParamValue(ctx.module, param));
        try { pill.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault();
    });
    pill.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const nextVal = fromNorm(startNorm + (e.clientX - startX) / 135);
        ctx.onParamChange(param.key, nextVal);
        sync();
        onLocalUpdate();
    });
    const stop = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        try { pill.releasePointerCapture(e.pointerId); } catch { }
    };
    pill.addEventListener('pointerup', stop);
    pill.addEventListener('pointercancel', stop);
    pill.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const curNorm = toNorm(readChainParamValue(ctx.module, param));
        const nextVal = fromNorm(curNorm + dir * 0.035);
        ctx.onParamChange(param.key, nextVal);
        sync();
        onLocalUpdate();
    }, { passive: false });

    pill.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const cur = readChainParamValue(ctx.module, param);
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'fx-vis-direct-input';
        input.min = String(param.min);
        input.max = String(param.max);
        input.step = String(param.step);
        input.value = String(cur);
        pill.replaceChildren(input);
        input.focus();
        input.select();
        const finish = (apply: boolean) => {
            const parsed = Number(input.value);
            pill.replaceChildren(fill, lbl, valEl);
            if (apply && Number.isFinite(parsed)) {
                const clamped = Math.max(param.min, Math.min(param.max, parsed));
                ctx.onParamChange(param.key, clamped);
                onLocalUpdate();
            }
            sync();
        };
        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') finish(true);
            else if (evt.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true), { once: true });
    });

    return { element: pill, sync };
}

function makeMinimalControlRow(
    ctx: FxVisualContext,
    params: ProcessorParamDef[],
    onLocalUpdate: () => void
): { element: HTMLElement; sync: () => void } {
    const strip = document.createElement('div');
    strip.className = 'fx-visual-controls fx-minimal-controls';
    const updaters: Array<() => void> = [];

    for (const param of params) {
        if (param.kind === 'enum' && param.options?.length) {
            const seg = document.createElement('div');
            seg.className = 'fx-vis-seg';
            const btns: HTMLButtonElement[] = [];
            for (const opt of param.options) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'fx-vis-seg-btn';
                btn.textContent = opt.label;
                btn.addEventListener('click', () => {
                    ctx.onParamChange(param.key, opt.value);
                    syncAll();
                    onLocalUpdate();
                });
                btns.push(btn);
                seg.appendChild(btn);
            }
            const syncOpt = () => {
                const cur = Math.round(readChainParamValue(ctx.module, param));
                btns.forEach((b, i) => b.classList.toggle('is-active', param.options![i].value === cur));
            };
            syncOpt();
            updaters.push(syncOpt);
            strip.appendChild(seg);
            continue;
        }
        const pill = makeParamPill(ctx, param, onLocalUpdate);
        updaters.push(pill.sync);
        strip.appendChild(pill.element);
    }

    const syncAll = () => updaters.forEach(fn => fn());
    return { element: strip, sync: syncAll };
}

/* ---------------- Shared IRIDE Wave / Audio Source Resolver ---------------- */

interface IrideWaveSource {
    peaks: Float32Array | null;
    buffer: AudioBuffer | null;
    duration: number;
    nodeKey: string;
    isPreFx: boolean;
}

/**
 * Resolves the best already-calculated IRIDE wave source for a node without running
 * audio synthesis in JS. Prefers the node's pre-FX / upstream IRIDE peaks or buffer.
 */
function resolveIrideWaveSource(node: BaseNode | undefined, telemetry?: SignalTelemetry): IrideWaveSource {
    if (!node) {
        return { peaks: null, buffer: null, duration: 0, nodeKey: '', isPreFx: false };
    }
    const nodeAny = node as any;
    const nodeKey = String(node.id ?? '');

    // 1. SampleNode: its dry AudioBuffer (already decoded for IRIDE) is the exact pre-FX wave
    if (nodeAny.nodeType === 'sample') {
        const dryBuf = typeof nodeAny.getAudioBuffer === 'function' ? (nodeAny.getAudioBuffer() as AudioBuffer | null) : null;
        if (dryBuf && dryBuf.length > 0) {
            return {
                peaks: null,
                buffer: dryBuf,
                duration: dryBuf.duration || Number(nodeAny.realtimePeaksDuration || 0) || (telemetry?.duration || 1),
                nodeKey,
                isPreFx: true,
            };
        }
    }

    // 2. Single-input pass-through / track (e.g. NullNode or single-source Track):
    //    Use upstream node's already-calculated IRIDE buffer/peaks as the exact pre-FX wave.
    const inputs = typeof nodeAny.getInputNodes === 'function' ? (nodeAny.getInputNodes() as any[]) : [];
    if (inputs.length === 1 && inputs[0]) {
        const up = inputs[0];
        const upBuf = (up.manifestStemBuffer || (typeof up.getAudioBuffer === 'function' ? up.getAudioBuffer() : null)) as AudioBuffer | null;
        const upPeaks = up.realtimePeaks as Float32Array | undefined;
        if (upPeaks && upPeaks.length >= 2) {
            return {
                peaks: upPeaks,
                buffer: (upBuf && upBuf.length > 0) ? upBuf : null,
                duration: Number(up.realtimePeaksDuration || nodeAny.realtimePeaksDuration || upBuf?.duration || telemetry?.duration || 2),
                nodeKey: String(up.id ?? nodeKey),
                isPreFx: true,
            };
        }
        if (upBuf && upBuf.length > 0) {
            return {
                peaks: null,
                buffer: upBuf,
                duration: upBuf.duration || Number(nodeAny.realtimePeaksDuration || telemetry?.duration || 2),
                nodeKey: String(up.id ?? nodeKey),
                isPreFx: true,
            };
        }
    }

    // 3. Fallback: this node's own already-calculated IRIDE signal (realtimePeaks / buffer)
    const ownPeaks = nodeAny.realtimePeaks as Float32Array | undefined;
    const ownBuf = (nodeAny.manifestStemBuffer || nodeAny._lastRenderedBuffer || null) as AudioBuffer | null;
    if (ownPeaks && ownPeaks.length >= 2) {
        return {
            peaks: ownPeaks,
            buffer: (ownBuf && ownBuf.length > 0) ? ownBuf : null,
            duration: Number(nodeAny.realtimePeaksDuration || ownBuf?.duration || telemetry?.duration || 2),
            nodeKey,
            isPreFx: false,
        };
    }
    const sig: WaveformSignal | undefined = typeof nodeAny.resolveVisualizationSignal === 'function'
        ? nodeAny.resolveVisualizationSignal(telemetry)
        : undefined;
    return {
        peaks: sig?.peaks || null,
        buffer: sig?.buffer || null,
        duration: Number(sig?.duration || telemetry?.duration || 2),
        nodeKey,
        isPreFx: false,
    };
}

/* ---------------- 1. Param EQ (Ableton EQ Eight + Lightweight RTA) ---------------- */

export const EQ_CURVE_OPTIONS = [
    {
        value: 0,
        id: 'low_cut',
        label: 'Low Cut',
        isCutoff: true,
        usesGain: false,
        svg: '<svg viewBox="0 0 18 12" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10.5 L6.5 3.5 Q8 2.5 10.5 2.5 L16 2.5"/></svg>',
    },
    {
        value: 1,
        id: 'low_shelf',
        label: 'Low Shelf',
        isCutoff: false,
        usesGain: true,
        svg: '<svg viewBox="0 0 18 12" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3 C6 3 6.5 9 11 9 L16 9"/></svg>',
    },
    {
        value: 2,
        id: 'bell',
        label: 'Bell',
        isCutoff: false,
        usesGain: true,
        svg: '<svg viewBox="0 0 18 12" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 9.5 C5.2 9.5 6.5 2.5 9 2.5 C11.5 2.5 12.8 9.5 16 9.5"/></svg>',
    },
    {
        value: 3,
        id: 'notch',
        label: 'Notch',
        isCutoff: false,
        usesGain: false,
        svg: '<svg viewBox="0 0 18 12" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3 L6.5 3 L9 10.5 L11.5 3 L16 3"/></svg>',
    },
    {
        value: 4,
        id: 'high_shelf',
        label: 'High Shelf',
        isCutoff: false,
        usesGain: true,
        svg: '<svg viewBox="0 0 18 12" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 9 L7 9 C11.5 9 12 3 16 3"/></svg>',
    },
    {
        value: 5,
        id: 'high_cut',
        label: 'High Cut',
        isCutoff: true,
        usesGain: false,
        svg: '<svg viewBox="0 0 18 12" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2.5 L7.5 2.5 Q10 2.5 11.5 3.5 L16 10.5"/></svg>',
    },
] as const;

const EQ_BANDS = [
    { prefix: 'b1', num: '1', defaultType: 1, defaultFreq: 100, defaultQ: 0.71 },
    { prefix: 'b2', num: '2', defaultType: 2, defaultFreq: 400, defaultQ: 1.0 },
    { prefix: 'b3', num: '3', defaultType: 2, defaultFreq: 2500, defaultQ: 1.0 },
    { prefix: 'b4', num: '4', defaultType: 4, defaultFreq: 8000, defaultQ: 0.71 },
] as const;

const EQ_RTA_BANDS = 64;
const EQ_RTA_MIN_HZ = 30;
const EQ_RTA_MAX_HZ = 20000;
const EQ_RTA_FREQS = new Float32Array(EQ_RTA_BANDS);
for (let i = 0; i < EQ_RTA_BANDS; i++) {
    const t = (i + 0.5) / EQ_RTA_BANDS;
    EQ_RTA_FREQS[i] = EQ_RTA_MIN_HZ * Math.pow(EQ_RTA_MAX_HZ / EQ_RTA_MIN_HZ, t);
}

export function qToCutoffOrder(q: number): number {
    const minQ = 0.2;
    const maxQ = 12.0;
    const clamped = Math.max(minQ, Math.min(maxQ, Number.isFinite(q) ? q : 0.71));
    const t = (Math.log(clamped) - Math.log(minQ)) / (Math.log(maxQ) - Math.log(minQ));
    return Math.max(1, Math.min(8, Math.round(1 + Math.max(0, Math.min(1, t)) * 7)));
}

export function qToSlopeDbPerOct(q: number): number {
    return qToCutoffOrder(q) * 6;
}

export function isCutoffCurveType(bandType: number): boolean {
    return bandType === 0 || bandType === 5;
}

export function curveUsesGain(bandType: number): boolean {
    return bandType === 1 || bandType === 2 || bandType === 4;
}

function evalBiquadMagSq(
    b0: number, b1: number, b2: number, a1: number, a2: number,
    cw: number, sw: number, c2: number, s2: number
): number {
    const numRe = b0 + b1 * cw + b2 * c2;
    const numIm = -b1 * sw - b2 * s2;
    const denRe = 1 + a1 * cw + a2 * c2;
    const denIm = -a1 * sw - a2 * s2;
    return (numRe * numRe + numIm * numIm) / Math.max(1e-18, denRe * denRe + denIm * denIm);
}

/**
 * Exact transfer-function magnitude in dB matching `dsp_modules/include/sin_fx/param_eq.hpp`
 * for all 6 curve types (including 1st..8th-order cascaded Butterworth cutoffs).
 */
export function computeEqBandMagDb(
    bandType: number,
    freq: number,
    gainDb: number,
    q: number,
    evalFreq: number,
    sr: number = 48000
): number {
    const f0 = Math.max(20, Math.min(0.45 * sr, freq));
    const w0 = (2 * Math.PI * f0) / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const qv = Math.max(0.1, q);

    const w = (2 * Math.PI * Math.min(0.49 * sr, evalFreq)) / sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);

    if (bandType === 0 || bandType === 5) {
        const isHp = bandType === 0;
        const order = qToCutoffOrder(qv);
        let magSq = 1.0;

        if ((order & 1) !== 0) {
            const K = Math.tan(Math.PI * (f0 / sr));
            const norm = 1 / (1 + K);
            const b0 = isHp ? norm : K * norm;
            const b1 = isHp ? -norm : K * norm;
            const a1 = (K - 1) * norm;
            magSq *= evalBiquadMagSq(b0, b1, 0, a1, 0, cw, sw, c2, s2);
        }
        const pairs = Math.floor(order / 2);
        for (let m = 0; m < pairs; m++) {
            const poleSin = Math.sin((Math.PI * (2 * m + 1)) / (2 * order));
            const qm = 1 / Math.max(1e-4, 2 * poleSin);
            const alpha = sinW0 / (2 * qm);
            const invA0 = 1 / (1 + alpha);
            const c = isHp ? 0.5 * (1 + cosW0) : 0.5 * (1 - cosW0);
            const b1 = isHp ? -(1 + cosW0) : (1 - cosW0);
            magSq *= evalBiquadMagSq(
                c * invA0, b1 * invA0, c * invA0,
                (-2 * cosW0) * invA0, (1 - alpha) * invA0,
                cw, sw, c2, s2
            );
        }
        return 10 * Math.log10(Math.max(1e-12, magSq));
    }

    if (bandType === 3) {
        const alpha = sinW0 / (2 * qv);
        const invA0 = 1 / (1 + alpha);
        const magSq = evalBiquadMagSq(
            invA0, (-2 * cosW0) * invA0, invA0,
            (-2 * cosW0) * invA0, (1 - alpha) * invA0,
            cw, sw, c2, s2
        );
        return 10 * Math.log10(Math.max(1e-12, magSq));
    }

    if (Math.abs(gainDb) < 1e-3) return 0;
    const A = Math.pow(10, gainDb / 40);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

    if (bandType === 2) {
        const alpha = sinW0 / (2 * qv);
        b0 = 1 + alpha * A; b1 = -2 * cosW0; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cosW0; a2 = 1 - alpha / A;
    } else if (bandType === 1) {
        const alpha = (sinW0 / 2) * Math.sqrt(Math.max(0.01, (A + 1 / A) * (1 / qv - 1) + 2));
        const sq = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cosW0 + sq);
        b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
        b2 = A * ((A + 1) - (A - 1) * cosW0 - sq);
        a0 = (A + 1) + (A - 1) * cosW0 + sq;
        a1 = -2 * ((A - 1) + (A + 1) * cosW0);
        a2 = (A + 1) + (A - 1) * cosW0 - sq;
    } else {
        const alpha = (sinW0 / 2) * Math.sqrt(Math.max(0.01, (A + 1 / A) * (1 / qv - 1) + 2));
        const sq = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cosW0 + sq);
        b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
        b2 = A * ((A + 1) + (A - 1) * cosW0 - sq);
        a0 = (A + 1) - (A - 1) * cosW0 + sq;
        a1 = 2 * ((A - 1) - (A + 1) * cosW0);
        a2 = (A + 1) - (A - 1) * cosW0 - sq;
    }

    const invA0 = 1 / Math.max(1e-12, a0);
    const magSq = evalBiquadMagSq(b0 * invA0, b1 * invA0, b2 * invA0, a1 * invA0, a2 * invA0, cw, sw, c2, s2);
    return 10 * Math.log10(Math.max(1e-12, magSq));
}

function createParamEqVisual(ctx: FxVisualContext): FxVisualHandle {
    const root = document.createElement('div');
    root.className = 'fx-visual-container fx-eq8-container';

    // 1. Dark Ableton EQ Eight-style Bode graph + lightweight background RTA
    const canvas = document.createElement('canvas');
    canvas.className = 'fx-visual-canvas fx-eq8-canvas';
    canvas.style.height = '132px';
    root.appendChild(canvas);

    // 2. Single-row bottom band selector + Ableton-style curve selector
    const selectorRow = document.createElement('div');
    selectorRow.className = 'fx-eq8-selector-row';

    const bandGroup = document.createElement('div');
    bandGroup.className = 'fx-eq8-band-pills';
    const bandBtns: HTMLButtonElement[] = [];

    const curveGroup = document.createElement('div');
    curveGroup.className = 'fx-eq8-curve-selector';
    const curveBtns: HTMLButtonElement[] = [];

    let selectedBand: number | null = null;
    let meterPeak = 0;
    let destroyed = false;

    // Lightweight zero-allocation RTA state (reuses IRIDE 1024-pt LUT FFT)
    const rtaSlice = new Float32Array(FFT_SIZE);
    const rtaTarget = new Float32Array(EQ_RTA_BANDS);
    const rtaSmooth = new Float32Array(EQ_RTA_BANDS);
    let rtaActive = false;
    let rtaUsesPreFxSource = false;
    let lastRtaComputeMs = 0;

    const getParamDef = (key: string): ProcessorParamDef =>
        ctx.def.params.find(p => p.key === key) || {
            key, label: key, unit: '', min: 0, max: 1, step: 0.01, defaultValue: 0, paramIndex: 0, kind: 'float', scale: 'linear',
        };

    const getBandState = (idx: number) => {
        const meta = EQ_BANDS[idx];
        const p = ctx.module.params || {};
        return {
            enabled: Number(p[`${meta.prefix}_enabled`] ?? 1) >= 0.5,
            type: Math.max(0, Math.min(5, Math.round(Number(p[`${meta.prefix}_type`] ?? meta.defaultType)))),
            freq: Number(p[`${meta.prefix}_freq`] ?? meta.defaultFreq),
            gain: Number(p[`${meta.prefix}_gain`] ?? 0),
            q: Number(p[`${meta.prefix}_q`] ?? meta.defaultQ),
        };
    };

    // 3. Contextual selected-band parameter strip (hidden until a band is clicked)
    const paramsStrip = document.createElement('div');
    paramsStrip.className = 'fx-eq8-band-params';
    paramsStrip.hidden = true;

    let activeBandParamSync: (() => void) | null = null;

    const rebuildSelectedBandParams = () => {
        paramsStrip.replaceChildren();
        activeBandParamSync = null;
        if (selectedBand === null) {
            paramsStrip.hidden = true;
            return;
        }
        paramsStrip.hidden = false;
        const idx = selectedBand;
        const meta = EQ_BANDS[idx];

        const onBtn = document.createElement('button');
        onBtn.type = 'button';
        onBtn.className = 'fx-eq8-enable-btn';
        onBtn.title = `Toggle Band ${meta.num} active`;
        onBtn.addEventListener('click', () => {
            const st = getBandState(idx);
            ctx.onParamChange(`${meta.prefix}_enabled`, st.enabled ? 0 : 1);
            syncAll();
            draw();
        });

        const freqParam = getParamDef(`${meta.prefix}_freq`);
        const gainParam = getParamDef(`${meta.prefix}_gain`);
        const qParam = getParamDef(`${meta.prefix}_q`);

        const freqPill = makeParamPill(ctx, freqParam, () => { syncSelectorRow(); draw(); }, {
            label: () => 'Freq',
            formatValue: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`),
        });

        const gainPill = makeParamPill(ctx, gainParam, () => { syncSelectorRow(); draw(); }, {
            label: () => 'Gain',
            formatValue: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`,
            hidden: () => !curveUsesGain(getBandState(idx).type),
        });

        const qPill = makeParamPill(ctx, qParam, () => { syncSelectorRow(); draw(); }, {
            label: () => (isCutoffCurveType(getBandState(idx).type) ? 'Slope' : 'Q'),
            formatValue: (v) => (isCutoffCurveType(getBandState(idx).type) ? `${qToSlopeDbPerOct(v)} dB/oct` : v.toFixed(2)),
        });

        const syncBandStrip = () => {
            const st = getBandState(idx);
            onBtn.classList.toggle('is-active', st.enabled);
            onBtn.textContent = meta.num;
            freqPill.sync();
            gainPill.sync();
            qPill.sync();
        };
        syncBandStrip();
        activeBandParamSync = syncBandStrip;
        paramsStrip.append(onBtn, freqPill.element, gainPill.element, qPill.element);
    };

    const selectBand = (idx: number | null) => {
        if (selectedBand === idx) return;
        selectedBand = idx;
        rebuildSelectedBandParams();
        syncSelectorRow();
        draw();
    };

    EQ_BANDS.forEach((meta, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fx-eq8-band-pill';
        btn.dataset.bandIndex = String(idx);
        btn.title = `Band ${meta.num}: click to show/hide parameters, double-click to bypass`;
        btn.innerHTML = `<span class="fx-eq8-band-dot" aria-hidden="true"></span><span>${meta.num}</span>`;

        const dot = btn.querySelector('.fx-eq8-band-dot') as HTMLElement | null;
        dot?.addEventListener('click', (e) => {
            e.stopPropagation();
            const st = getBandState(idx);
            ctx.onParamChange(`${meta.prefix}_enabled`, st.enabled ? 0 : 1);
            syncAll();
            draw();
        });
        btn.addEventListener('click', () => {
            selectBand(selectedBand === idx ? null : idx);
        });
        btn.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const st = getBandState(idx);
            ctx.onParamChange(`${meta.prefix}_enabled`, st.enabled ? 0 : 1);
            syncAll();
            draw();
        });
        bandBtns.push(btn);
        bandGroup.appendChild(btn);
    });

    EQ_CURVE_OPTIONS.forEach((curve) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fx-eq8-curve-btn';
        btn.dataset.curveValue = String(curve.value);
        btn.title = curve.label;
        btn.innerHTML = curve.svg;
        btn.addEventListener('click', () => {
            if (selectedBand === null) return;
            const meta = EQ_BANDS[selectedBand];
            ctx.onParamChange(`${meta.prefix}_type`, curve.value);
            syncAll();
            draw();
        });
        curveBtns.push(btn);
        curveGroup.appendChild(btn);
    });

    const divider = document.createElement('span');
    divider.className = 'fx-eq8-row-divider';
    selectorRow.append(bandGroup, divider, curveGroup);
    root.append(selectorRow, paramsStrip);

    const syncSelectorRow = () => {
        bandBtns.forEach((btn, idx) => {
            const st = getBandState(idx);
            btn.classList.toggle('is-selected', idx === selectedBand);
            btn.classList.toggle('is-enabled', st.enabled);
        });
        const selType = selectedBand !== null ? getBandState(selectedBand).type : -1;
        curveGroup.classList.toggle('is-disabled', selectedBand === null);
        curveBtns.forEach((btn, i) => {
            const cVal = EQ_CURVE_OPTIONS[i].value;
            btn.classList.toggle('is-active', selectedBand !== null && selType === cVal);
            btn.disabled = selectedBand === null;
        });
    };

    const syncAll = () => {
        syncSelectorRow();
        activeBandParamSync?.();
    };

    // Graph coordinate system
    const W = 320;
    const H = 132;
    const padX = 10;
    const padTop = 10;
    const padBottom = 16;
    const plotW = W - padX * 2;
    const plotH = H - padTop - padBottom;
    const minLogF = Math.log10(20);
    const maxLogF = Math.log10(20000);

    const freqToX = (f: number) => {
        const t = (Math.log10(Math.max(20, Math.min(20000, f))) - minLogF) / (maxLogF - minLogF);
        return padX + t * plotW;
    };
    const xToFreq = (x: number) => {
        const t = Math.max(0, Math.min(1, (x - padX) / plotW));
        return Math.pow(10, minLogF + t * (maxLogF - minLogF));
    };
    const dbToY = (db: number) => padTop + ((18 - Math.max(-18, Math.min(18, db))) / 36) * plotH;
    const yToDb = (y: number) => Math.max(-18, Math.min(18, 18 - ((y - padTop) / plotH) * 36));
    const bandDotY = (st: { type: number; gain: number }) => (curveUsesGain(st.type) ? dbToY(st.gain) : dbToY(0));

    const updateRtaFromTelemetry = (telemetry: SignalTelemetry): boolean => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (telemetry.isPlaying && (now - lastRtaComputeMs) < 30) {
            return false;
        }
        lastRtaComputeMs = now;

        let computed = false;
        rtaUsesPreFxSource = false;

        if (telemetry.isPlaying) {
            const src = resolveIrideWaveSource(ctx.node, telemetry);
            const buf = src.buffer;
            if (buf && buf.length > 0) {
                const sr = buf.sampleRate || 48000;
                const total = buf.length;
                const dur = src.duration > 0 ? src.duration : (total / sr);
                const normPos = dur > 0 ? ((((telemetry.time % dur) + dur) % dur) / dur) : 0;
                const center = Math.floor(normPos * total);
                const start = Math.max(0, Math.min(total - FFT_SIZE, center - (FFT_SIZE >> 1)));
                const ch0 = buf.getChannelData(0);
                const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
                if (ch1) {
                    for (let i = 0; i < FFT_SIZE; i++) {
                        const idx = (start + i) % total;
                        rtaSlice[i] = (ch0[idx] + ch1[idx]) * 0.5;
                    }
                } else {
                    for (let i = 0; i < FFT_SIZE; i++) {
                        rtaSlice[i] = ch0[(start + i) % total];
                    }
                }
                computeLogSpectrum(rtaSlice, rtaTarget, sr);
                rtaUsesPreFxSource = src.isPreFx;
                computed = true;
            } else if (telemetry.realtimeSpectrum && telemetry.realtimeSpectrum.length > 0) {
                computeLogSpectrumFromByteBins(telemetry.realtimeSpectrum, rtaTarget);
                computed = true;
            } else if (telemetry.realtimeScope && telemetry.realtimeScope.length >= 32) {
                // Center short C++ scope packet inside FFT_SIZE with local Hann window & unity energy compensation
                const scope = telemetry.realtimeScope;
                const sLen = Math.min(FFT_SIZE, scope.length);
                const offset = (FFT_SIZE - sLen) >> 1;
                const normGain = FFT_SIZE / sLen;
                rtaSlice.fill(0);
                const invDenom = sLen > 1 ? (2 * Math.PI) / (sLen - 1) : 0;
                for (let i = 0; i < sLen; i++) {
                    const win = 0.5 * (1 - Math.cos(invDenom * i));
                    rtaSlice[offset + i] = scope[i] * win * normGain;
                }
                computeLogSpectrum(rtaSlice, rtaTarget, 48000);
                computed = true;
            }
        }

        if (!computed) {
            rtaTarget.fill(0);
        }

        let anyEnergy = false;
        for (let i = 0; i < EQ_RTA_BANDS; i++) {
            const target = rtaTarget[i];
            const prev = rtaSmooth[i];
            const next = target > prev
                ? prev * 0.25 + target * 0.75
                : prev * 0.72;
            rtaSmooth[i] = next < 0.004 ? 0 : next;
            if (rtaSmooth[i] > 0.004) anyEnergy = true;
        }
        const changed = anyEnergy || rtaActive;
        rtaActive = anyEnergy;
        return changed;
    };

    const draw = () => {
        if (destroyed) return;
        const rectW = canvas.clientWidth || W;
        const c = setupHiDpiCanvas(canvas, rectW, H);
        if (!c) return;
        const scaleX = rectW / W;
        c.save();
        c.scale(scaleX, 1);

        // Ableton dark slate-charcoal display
        c.fillStyle = '#14171c';
        c.fillRect(0, 0, W, H);

        // Vertical frequency grid
        c.lineWidth = 1;
        for (const gf of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
            const x = Math.round(freqToX(gf)) + 0.5;
            c.strokeStyle = (gf === 100 || gf === 1000 || gf === 10000)
                ? 'rgba(148, 163, 184, 0.16)'
                : 'rgba(148, 163, 184, 0.07)';
            c.beginPath(); c.moveTo(x, padTop); c.lineTo(x, padTop + plotH); c.stroke();
        }
        // Horizontal dB grid
        for (const gd of [-12, -6, 0, 6, 12]) {
            const y = Math.round(dbToY(gd)) + 0.5;
            c.strokeStyle = gd === 0 ? 'rgba(203, 213, 225, 0.28)' : 'rgba(148, 163, 184, 0.08)';
            c.beginPath(); c.moveTo(padX, y); c.lineTo(W - padX, y); c.stroke();
        }

        const bands = EQ_BANDS.map((_, i) => getBandState(i));
        const bottomY = padTop + plotH;

        // Lightweight background RTA silhouette aligned precisely to the EQ Hz grid
        if (rtaActive) {
            const eqEnabled = ctx.module.enabled !== false;
            c.beginPath();
            c.moveTo(freqToX(EQ_RTA_FREQS[0]), bottomY);
            for (let i = 0; i < EQ_RTA_BANDS; i++) {
                const f = EQ_RTA_FREQS[i];
                let norm = rtaSmooth[i];
                if (rtaUsesPreFxSource && eqEnabled && norm > 0.004) {
                    let eqDb = 0;
                    for (let b = 0; b < 4; b++) {
                        if (bands[b].enabled) {
                            eqDb += computeEqBandMagDb(bands[b].type, bands[b].freq, bands[b].gain, bands[b].q, f);
                        }
                    }
                    norm = Math.max(0, Math.min(1, norm + eqDb / 64));
                }
                const rx = freqToX(f);
                const ry = bottomY - norm * plotH;
                c.lineTo(rx, ry);
            }
            c.lineTo(freqToX(EQ_RTA_FREQS[EQ_RTA_BANDS - 1]), bottomY);
            c.closePath();
            c.fillStyle = 'rgba(148, 163, 184, 0.16)';
            c.fill();

            c.beginPath();
            for (let i = 0; i < EQ_RTA_BANDS; i++) {
                const f = EQ_RTA_FREQS[i];
                let norm = rtaSmooth[i];
                if (rtaUsesPreFxSource && eqEnabled && norm > 0.004) {
                    let eqDb = 0;
                    for (let b = 0; b < 4; b++) {
                        if (bands[b].enabled) {
                            eqDb += computeEqBandMagDb(bands[b].type, bands[b].freq, bands[b].gain, bands[b].q, f);
                        }
                    }
                    norm = Math.max(0, Math.min(1, norm + eqDb / 64));
                }
                const rx = freqToX(f);
                const ry = bottomY - norm * plotH;
                if (i === 0) c.moveTo(rx, ry);
                else c.lineTo(rx, ry);
            }
            c.strokeStyle = 'rgba(203, 213, 225, 0.34)';
            c.lineWidth = 1;
            c.stroke();
        }

        // Minimal axis tick labels
        c.fillStyle = 'rgba(148, 163, 184, 0.55)';
        c.font = '8px monospace';
        c.textAlign = 'center';
        c.textBaseline = 'top';
        for (const [f, txt] of [[100, '100'], [1000, '1k'], [10000, '10k']] as const) {
            c.fillText(txt, freqToX(f), bottomY + 3);
        }

        const steps = 112;
        const zeroY = dbToY(0);

        // Selected individual band highlight curve
        if (selectedBand !== null && bands[selectedBand].enabled) {
            const sel = bands[selectedBand];
            c.beginPath();
            c.moveTo(padX, zeroY);
            for (let s = 0; s <= steps; s++) {
                const x = padX + (s / steps) * plotW;
                const f = xToFreq(x);
                const db = computeEqBandMagDb(sel.type, sel.freq, sel.gain, sel.q, f);
                c.lineTo(x, dbToY(db));
            }
            c.lineTo(padX + plotW, zeroY);
            c.closePath();
            c.fillStyle = 'rgba(245, 158, 11, 0.11)';
            c.fill();
        }

        // Composite EQ response fill + crisp amber-gold Ableton curve
        c.beginPath();
        const ptsX: number[] = new Array(steps + 1);
        const ptsY: number[] = new Array(steps + 1);
        for (let s = 0; s <= steps; s++) {
            const x = padX + (s / steps) * plotW;
            const f = xToFreq(x);
            let sumDb = 0;
            for (let i = 0; i < 4; i++) {
                if (bands[i].enabled) {
                    sumDb += computeEqBandMagDb(bands[i].type, bands[i].freq, bands[i].gain, bands[i].q, f);
                }
            }
            ptsX[s] = x;
            ptsY[s] = dbToY(sumDb);
            if (s === 0) c.moveTo(x, zeroY);
            c.lineTo(x, ptsY[s]);
        }
        c.lineTo(padX + plotW, zeroY);
        c.closePath();
        c.fillStyle = 'rgba(245, 158, 11, 0.14)';
        c.fill();

        c.beginPath();
        for (let s = 0; s <= steps; s++) {
            if (s === 0) c.moveTo(ptsX[s], ptsY[s]);
            else c.lineTo(ptsX[s], ptsY[s]);
        }
        c.strokeStyle = '#f59e0b';
        c.lineWidth = 1.75;
        c.stroke();

        // Numbered circular band dots (Ableton EQ Eight style)
        bands.forEach((st, idx) => {
            const hx = freqToX(st.freq);
            const hy = bandDotY(st);
            const isSel = idx === selectedBand;
            const r = isSel ? 7.2 : 6.0;

            c.beginPath();
            c.arc(hx, hy, r, 0, Math.PI * 2);
            if (!st.enabled) {
                c.fillStyle = 'rgba(30, 41, 59, 0.85)';
                c.fill();
                c.lineWidth = 1.25;
                c.strokeStyle = isSel ? 'rgba(245, 158, 11, 0.7)' : 'rgba(148, 163, 184, 0.45)';
                c.stroke();
            } else if (isSel) {
                c.fillStyle = '#f59e0b';
                c.fill();
                c.lineWidth = 1.5;
                c.strokeStyle = '#fef3c7';
                c.stroke();
            } else {
                c.fillStyle = '#1e293b';
                c.fill();
                c.lineWidth = 1.4;
                c.strokeStyle = '#fbbf24';
                c.stroke();
            }

            c.fillStyle = (!st.enabled) ? 'rgba(148, 163, 184, 0.6)' : (isSel ? '#0f172a' : '#f8fafc');
            c.font = 'bold 8.5px Inter, system-ui, sans-serif';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(EQ_BANDS[idx].num, hx, hy + 0.5);
        });

        // Subtle live output peak hair-line along bottom edge
        if (meterPeak > 0.002) {
            const norm = Math.min(1, meterPeak);
            c.fillStyle = norm > 0.98 ? '#ef4444' : 'rgba(245, 158, 11, 0.75)';
            c.fillRect(padX, H - 2.5, plotW * norm, 1.5);
        }

        c.restore();
    };

    let dragBand = -1;
    let dragStartY = 0;
    let dragStartQ = 1.0;

    const toLocalCoords = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = W / Math.max(1, rect.width);
        return { x: (e.clientX - rect.left) * scaleX, y: e.clientY - rect.top };
    };

    canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const pt = toLocalCoords(e);
        let bestIdx = -1;
        let bestDist = 16;
        EQ_BANDS.forEach((_, idx) => {
            const st = getBandState(idx);
            const d = Math.hypot(pt.x - freqToX(st.freq), pt.y - bandDotY(st));
            if (d < bestDist) {
                bestDist = d;
                bestIdx = idx;
            }
        });
        if (bestIdx >= 0) {
            dragBand = bestIdx;
            dragStartY = pt.y;
            dragStartQ = getBandState(bestIdx).q;
            selectBand(bestIdx);
            try { canvas.setPointerCapture(e.pointerId); } catch { }
            e.preventDefault();
        } else {
            selectBand(null);
        }
    });

    canvas.addEventListener('pointermove', (e) => {
        if (dragBand < 0) return;
        const pt = toLocalCoords(e);
        const meta = EQ_BANDS[dragBand];
        const st = getBandState(dragBand);
        const nextF = Math.round(Math.max(20, Math.min(20000, xToFreq(pt.x))));
        ctx.onParamChange(`${meta.prefix}_freq`, nextF);

        if (curveUsesGain(st.type)) {
            const nextG = Math.round(yToDb(pt.y) * 10) / 10;
            ctx.onParamChange(`${meta.prefix}_gain`, nextG);
        } else {
            const minLogQ = Math.log(0.2);
            const maxLogQ = Math.log(12.0);
            const curLogQ = Math.log(Math.max(0.2, Math.min(12.0, dragStartQ)));
            const deltaNorm = (dragStartY - pt.y) / 90;
            const nextLogQ = Math.max(minLogQ, Math.min(maxLogQ, curLogQ + deltaNorm * (maxLogQ - minLogQ)));
            const nextQ = Math.round(Math.exp(nextLogQ) * 100) / 100;
            ctx.onParamChange(`${meta.prefix}_q`, nextQ);
        }
        syncAll();
        draw();
    });

    const endDrag = (e: PointerEvent) => {
        if (dragBand >= 0) {
            dragBand = -1;
            try { canvas.releasePointerCapture(e.pointerId); } catch { }
        }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('dblclick', (e) => {
        const pt = toLocalCoords(e);
        let bestIdx = -1;
        let bestDist = 16;
        EQ_BANDS.forEach((_, idx) => {
            const st = getBandState(idx);
            const d = Math.hypot(pt.x - freqToX(st.freq), pt.y - bandDotY(st));
            if (d < bestDist) {
                bestDist = d;
                bestIdx = idx;
            }
        });
        if (bestIdx >= 0) {
            const meta = EQ_BANDS[bestIdx];
            const st = getBandState(bestIdx);
            ctx.onParamChange(`${meta.prefix}_enabled`, st.enabled ? 0 : 1);
            syncAll();
            draw();
        }
    });

    canvas.addEventListener('wheel', (e) => {
        if (selectedBand === null) return;
        e.preventDefault();
        const meta = EQ_BANDS[selectedBand];
        const st = getBandState(selectedBand);
        const minLogQ = Math.log(0.2);
        const maxLogQ = Math.log(12.0);
        const curT = (Math.log(Math.max(0.2, st.q)) - minLogQ) / (maxLogQ - minLogQ);
        const stepT = isCutoffCurveType(st.type) ? (1 / 7) : 0.045;
        const nextT = Math.max(0, Math.min(1, curT + (e.deltaY < 0 ? stepT : -stepT)));
        const nextQ = Math.round(Math.exp(minLogQ + nextT * (maxLogQ - minLogQ)) * 100) / 100;
        ctx.onParamChange(`${meta.prefix}_q`, nextQ);
        syncAll();
        draw();
    }, { passive: false });

    // Subscribe to TransportClock strictly while expanded & mounted (zero overhead when collapsed/closed)
    const unsubscribeClock = defaultTransportClock.subscribe((telemetry) => {
        if (destroyed) return;
        if (updateRtaFromTelemetry(telemetry)) {
            draw();
        }
    });

    syncSelectorRow();
    draw();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(canvas);

    return {
        element: root,
        syncFromParams() {
            syncAll();
            draw();
        },
        updateMeter(val: number) {
            if (Math.abs(val - meterPeak) > 0.008) {
                meterPeak = val;
                if (!rtaActive) draw();
            }
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            unsubscribeClock();
            ro?.disconnect();
        },
    };
}

/* ---------------- 2. Shared Zoomed Unipolar IRIDE Dynamics Scope ---------------- */

const SCOPE_COLS = 160;
const SCOPE_LIVE_WINDOW_SEC = 0.85;
const SCOPE_PAUSED_MAX_WINDOW_SEC = 1.6;

/**
 * Extracts a single-sided (rectified peak [0..inf]) zoomed column envelope from
 * already-calculated IRIDE peaks or AudioBuffer. Zero synthesis in JS.
 */
function sampleUnipolarIrideColumns(
    src: IrideWaveSource,
    outPeak: Float32Array,
    endTimeSec: number | null,
    liveWindowSec: number,
    inputGainLin: number
): boolean {
    const N = outPeak.length;
    const dur = src.duration > 0 ? src.duration : liveWindowSec;

    if (src.peaks && src.peaks.length >= 2) {
        const srcCols = Math.floor(src.peaks.length / 2);
        if (srcCols <= 0) return false;

        let spanSec: number;
        let startTime: number;
        if (endTimeSec !== null) {
            spanSec = Math.min(liveWindowSec, dur);
            startTime = endTimeSec - spanSec;
        } else {
            // Zoomed static view while paused: focus on up to 1.6s starting at first active audio
            spanSec = Math.min(SCOPE_PAUSED_MAX_WINDOW_SEC, dur);
            let firstActiveCol = 0;
            if (dur > spanSec) {
                for (let c = 0; c < srcCols; c++) {
                    if (Math.max(Math.abs(src.peaks[c * 2]), Math.abs(src.peaks[c * 2 + 1])) > 0.015) {
                        firstActiveCol = Math.max(0, c - 2);
                        break;
                    }
                }
            }
            startTime = (firstActiveCol / srcCols) * dur;
        }

        for (let i = 0; i < N; i++) {
            const t = startTime + (i / (N - 1)) * spanSec;
            const norm = (((t % dur) + dur) % dur) / dur;
            const pos = norm * (srcCols - 1);
            const c0 = Math.floor(pos);
            const c1 = Math.min(srcCols - 1, c0 + 1);
            const frac = pos - c0;
            const p0 = Math.max(Math.abs(src.peaks[c0 * 2]), Math.abs(src.peaks[c0 * 2 + 1]));
            const p1 = Math.max(Math.abs(src.peaks[c1 * 2]), Math.abs(src.peaks[c1 * 2 + 1]));
            outPeak[i] = (p0 + (p1 - p0) * frac) * inputGainLin;
        }
        return true;
    }

    if (src.buffer && src.buffer.length > 0) {
        const ch0 = src.buffer.getChannelData(0);
        const total = ch0.length;
        const sr = src.buffer.sampleRate || 48000;
        const bufDur = total / sr;

        let spanSec: number;
        let startTime: number;
        if (endTimeSec !== null) {
            spanSec = Math.min(liveWindowSec, bufDur);
            startTime = endTimeSec - spanSec;
        } else {
            spanSec = Math.min(SCOPE_PAUSED_MAX_WINDOW_SEC, bufDur);
            let firstSample = 0;
            if (bufDur > spanSec) {
                const scanStride = Math.max(1, Math.floor(total / 256));
                for (let s = 0; s < total; s += scanStride) {
                    if (Math.abs(ch0[s]) > 0.015) {
                        firstSample = Math.max(0, s - Math.floor(0.02 * sr));
                        break;
                    }
                }
            }
            startTime = firstSample / sr;
        }

        const samplesPerCol = Math.max(1, Math.floor((spanSec / N) * sr));
        const stride = Math.max(1, Math.floor(samplesPerCol / 24));

        for (let i = 0; i < N; i++) {
            const tCol = (((startTime + (i / N) * spanSec) % bufDur) + bufDur) % bufDur;
            const sStart = Math.floor(tCol * sr);
            let pk = 0;
            for (let k = 0; k < samplesPerCol; k += stride) {
                const a = Math.abs(ch0[(sStart + k) % total]);
                if (a > pk) pk = a;
            }
            outPeak[i] = pk * inputGainLin;
        }
        return true;
    }

    return false;
}

interface DynamicsScopeConfig {
    height: number;
    accentColor: string;
    highlightFill: string;
    highlightStroke: string;
    lineColor: string;
    thresholdParamKey: string;
    thresholdLabel: string;
    meterLabel: string;
    minThreshDb: number;
    maxThreshDb: number;
    /** Unipolar full-height mapping: a <= 1 -> zeroDbSplit * a^ampExp */
    ampExp: number;
    zeroDbSplit: number;
    refDbTicks: readonly number[];
    showGrTrace: boolean;
    getDriveGainLin: () => number;
    computeReducedAmp?: (inAmp: number) => number;
}

function createDynamicsScopeVisual(ctx: FxVisualContext, cfg: DynamicsScopeConfig): FxVisualHandle {
    const root = document.createElement('div');
    root.className = 'fx-visual-container fx-dynamics-container';

    const canvas = document.createElement('canvas');
    canvas.className = 'fx-visual-canvas fx-dynamics-canvas';
    canvas.style.height = `${cfg.height}px`;
    root.appendChild(canvas);

    const colPeak = new Float32Array(SCOPE_COLS);
    const ringPeak = new Float32Array(SCOPE_COLS);
    const grHistory = new Float32Array(SCOPE_COLS);
    const drawY = new Float32Array(SCOPE_COLS);
    const reducedY = new Float32Array(SCOPE_COLS);
    let ringHead = 0;
    let currentMeterDb = 0;
    let latestTelemetry: SignalTelemetry = defaultTransportClock.getTelemetry();
    let destroyed = false;

    const dbToLin = (db: number) => Math.pow(10, db / 20);

    const mapAmpToNorm = (amp: number): number => {
        const a = Math.max(0, amp);
        if (a <= 1.0) {
            return cfg.zeroDbSplit * Math.pow(a, cfg.ampExp);
        }
        return cfg.zeroDbSplit + (1 - cfg.zeroDbSplit) * Math.tanh((a - 1.0) * 0.65);
    };

    const mapNormToDb = (norm: number): number => {
        const clamped = Math.max(0.005, Math.min(cfg.zeroDbSplit, norm));
        const a = Math.pow(clamped / cfg.zeroDbSplit, 1 / cfg.ampExp);
        const db = 20 * Math.log10(Math.max(1e-4, a));
        return Math.max(cfg.minThreshDb, Math.min(cfg.maxThreshDb, Math.round(db * 10) / 10));
    };

    const getPreGainLin = (): number => {
        const chain = ctx.node?.properties?.chain;
        if (!Array.isArray(chain)) return 1.0;
        const { preDb } = getPrePostGainDb(chain);
        return dbToLin(preDb);
    };

    const draw = () => {
        if (destroyed) return;
        const W = canvas.clientWidth || 320;
        const H = cfg.height;
        const c = setupHiDpiCanvas(canvas, W, H);
        if (!c) return;

        c.fillStyle = '#14171c';
        c.fillRect(0, 0, W, H);

        const padLeft = 24;
        const padRight = 6;
        const padTop = 8;
        const padBottom = 6;
        const plotW = Math.max(24, W - padLeft - padRight);
        const plotH = Math.max(24, H - padTop - padBottom);
        const bottomY = padTop + plotH;

        const ampToY = (amp: number) => bottomY - mapAmpToNorm(amp) * plotH;

        // Subtle horizontal dB reference hairlines & crisp left-edge dB scale
        c.lineWidth = 1;
        c.font = '8px monospace';
        c.textAlign = 'right';
        c.textBaseline = 'middle';
        for (const dbTick of cfg.refDbTicks) {
            const y = Math.round(ampToY(dbToLin(dbTick))) + 0.5;
            c.strokeStyle = dbTick === 0
                ? 'rgba(148, 163, 184, 0.22)'
                : 'rgba(148, 163, 184, 0.08)';
            c.beginPath();
            c.moveTo(padLeft, y);
            c.lineTo(padLeft + plotW, y);
            c.stroke();

            c.fillStyle = 'rgba(148, 163, 184, 0.5)';
            c.fillText(`${dbTick}`, padLeft - 4, y);
        }

        // Bottom baseline
        c.strokeStyle = 'rgba(148, 163, 184, 0.20)';
        c.beginPath();
        c.moveTo(padLeft, Math.round(bottomY) + 0.5);
        c.lineTo(padLeft + plotW, Math.round(bottomY) + 0.5);
        c.stroke();

        const threshDb = Number(ctx.module.params?.[cfg.thresholdParamKey] ?? 0);
        const threshLin = dbToLin(threshDb);
        const threshY = ampToY(threshLin);

        // Sample single-sided zoomed IRIDE wave
        const src = resolveIrideWaveSource(ctx.node, latestTelemetry);
        const driveLin = cfg.getDriveGainLin();
        const totalInGain = (src.isPreFx ? getPreGainLin() : 1.0) * driveLin;
        const isPlaying = Boolean(latestTelemetry?.isPlaying);
        const hasIrideWave = sampleUnipolarIrideColumns(
            src,
            colPeak,
            isPlaying ? latestTelemetry.time : null,
            SCOPE_LIVE_WINDOW_SEC,
            totalInGain
        );

        let anySignal = false;
        for (let i = 0; i < SCOPE_COLS; i++) {
            let pk: number;
            if (hasIrideWave) {
                pk = colPeak[i];
                if (!src.isPreFx && isPlaying) {
                    const grAtCol = grHistory[(ringHead + i) % SCOPE_COLS];
                    if (grAtCol < -0.1) pk *= dbToLin(-grAtCol);
                }
            } else {
                pk = ringPeak[(ringHead + i) % SCOPE_COLS] * driveLin;
            }
            if (pk > 0.001) anySignal = true;
            drawY[i] = ampToY(pk);
            if (cfg.computeReducedAmp) {
                reducedY[i] = ampToY(cfg.computeReducedAmp(pk));
            }
        }

        const stepX = plotW / (SCOPE_COLS - 1);

        const traceWavePath = (yArr: Float32Array, closedToBottom: boolean) => {
            c.beginPath();
            if (closedToBottom) {
                c.moveTo(padLeft, bottomY);
                for (let i = 0; i < SCOPE_COLS; i++) {
                    c.lineTo(padLeft + i * stepX, yArr[i]);
                }
                c.lineTo(padLeft + plotW, bottomY);
                c.closePath();
            } else {
                for (let i = 0; i < SCOPE_COLS; i++) {
                    const x = padLeft + i * stepX;
                    if (i === 0) c.moveTo(x, yArr[i]);
                    else c.lineTo(x, yArr[i]);
                }
            }
        };

        if (anySignal) {
            if (cfg.computeReducedAmp) {
                // Compressor: subtle input wave silhouette behind bright compressed output contour
                traceWavePath(drawY, true);
                c.fillStyle = 'rgba(148, 163, 184, 0.22)';
                c.fill();
                traceWavePath(drawY, false);
                c.strokeStyle = 'rgba(148, 163, 184, 0.48)';
                c.lineWidth = 1;
                c.stroke();

                // Highlight only the actual wave tips exceeding threshold (no background area box!)
                c.save();
                c.beginPath();
                c.rect(padLeft, padTop, plotW, Math.max(0, threshY - padTop));
                c.clip();
                traceWavePath(drawY, true);
                c.fillStyle = cfg.highlightFill;
                c.fill();
                traceWavePath(drawY, false);
                c.strokeStyle = cfg.highlightStroke;
                c.lineWidth = 1.25;
                c.stroke();
                c.restore();

                // Compressed output waveform body
                traceWavePath(reducedY, true);
                const compGrad = c.createLinearGradient(0, padTop, 0, bottomY);
                compGrad.addColorStop(0, 'rgba(56, 189, 248, 0.52)');
                compGrad.addColorStop(1, 'rgba(56, 189, 248, 0.14)');
                c.fillStyle = compGrad;
                c.fill();
                traceWavePath(reducedY, false);
                c.strokeStyle = '#38bdf8';
                c.lineWidth = 1.25;
                c.stroke();
            } else {
                // Clipper / Limiter: crisp single-sided full-height wave split cleanly at the 1px ceiling line
                // 1. Unclipped portion below ceiling line
                c.save();
                c.beginPath();
                c.rect(padLeft, threshY, plotW, Math.max(0, bottomY - threshY));
                c.clip();
                traceWavePath(drawY, true);
                const waveGrad = c.createLinearGradient(0, padTop, 0, bottomY);
                waveGrad.addColorStop(0, 'rgba(226, 232, 240, 0.58)');
                waveGrad.addColorStop(1, 'rgba(148, 163, 184, 0.16)');
                c.fillStyle = waveGrad;
                c.fill();
                traceWavePath(drawY, false);
                c.strokeStyle = '#e2e8f0';
                c.lineWidth = 1.15;
                c.stroke();
                c.restore();

                // 2. Clipped / limited material ONLY where waveform actually rises above ceiling line
                c.save();
                c.beginPath();
                c.rect(padLeft, padTop, plotW, Math.max(0, threshY - padTop));
                c.clip();
                traceWavePath(drawY, true);
                c.fillStyle = cfg.highlightFill;
                c.fill();
                traceWavePath(drawY, false);
                c.strokeStyle = cfg.highlightStroke;
                c.lineWidth = 1.35;
                c.stroke();
                c.restore();
            }
        }

        // Thin Gain Reduction trace line hanging from top edge (Compressor & Limiter)
        if (cfg.showGrTrace) {
            let anyGr = false;
            for (let i = 0; i < SCOPE_COLS; i++) {
                if (grHistory[(ringHead + i) % SCOPE_COLS] < -0.05) {
                    anyGr = true;
                    break;
                }
            }
            if (anyGr) {
                c.beginPath();
                for (let i = 0; i < SCOPE_COLS; i++) {
                    const gr = grHistory[(ringHead + i) % SCOPE_COLS];
                    const x = padLeft + i * stepX;
                    const y = padTop + Math.min(1, Math.max(0, -gr / 24)) * (plotH * 0.55);
                    if (i === 0) c.moveTo(x, y);
                    else c.lineTo(x, y);
                }
                c.strokeStyle = '#fbbf24';
                c.lineWidth = 1.15;
                c.stroke();
            }
        }

        // Single razor-thin 1px Threshold / Ceiling line (NO shaded area!)
        const crispThreshY = Math.round(threshY) + 0.5;
        c.strokeStyle = cfg.lineColor;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(padLeft, crispThreshY);
        c.lineTo(padLeft + plotW, crispThreshY);
        c.stroke();

        // Live scrolling playhead hairline at right edge while playing
        if (isPlaying) {
            c.strokeStyle = 'rgba(248, 250, 252, 0.3)';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(padLeft + plotW - 0.5, padTop);
            c.lineTo(padLeft + plotW - 0.5, bottomY);
            c.stroke();
        }

        // Minimal HUD readouts
        c.font = '8.5px monospace';
        c.textBaseline = 'top';
        c.textAlign = 'left';
        c.fillStyle = cfg.accentColor;
        c.fillText(`${cfg.thresholdLabel} ${threshDb.toFixed(1)} dB`, padLeft + 4, padTop + 1);

        if (currentMeterDb < -0.05) {
            c.textAlign = 'right';
            c.fillStyle = cfg.highlightStroke;
            c.fillText(`${cfg.meterLabel} ${currentMeterDb.toFixed(1)} dB`, padLeft + plotW - 4, padTop + 1);
        }
    };

    // Interactive vertical dragging directly on the full-height single-sided scope moves the thin threshold line
    let draggingThresh = false;
    const updateThreshFromPointer = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        const padTop = 8;
        const padBottom = 6;
        const plotH = Math.max(24, cfg.height - padTop - padBottom);
        const bottomY = padTop + plotH;
        const localY = e.clientY - rect.top;
        const norm = (bottomY - localY) / plotH;
        const nextDb = mapNormToDb(norm);
        ctx.onParamChange(cfg.thresholdParamKey, nextDb);
        strip.sync();
        draw();
    };

    canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        draggingThresh = true;
        try { canvas.setPointerCapture(e.pointerId); } catch { }
        updateThreshFromPointer(e);
        e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!draggingThresh) return;
        updateThreshFromPointer(e);
    });
    const endDrag = (e: PointerEvent) => {
        if (!draggingThresh) return;
        draggingThresh = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch { }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const cur = Number(ctx.module.params?.[cfg.thresholdParamKey] ?? 0);
        const next = Math.max(cfg.minThreshDb, Math.min(cfg.maxThreshDb, Math.round((cur + (e.deltaY < 0 ? 0.5 : -0.5)) * 10) / 10));
        ctx.onParamChange(cfg.thresholdParamKey, next);
        strip.sync();
        draw();
    }, { passive: false });

    const strip = makeMinimalControlRow(ctx, ctx.def.params, draw);
    root.appendChild(strip.element);

    // Subscribe to IRIDE TransportClock ONLY while expanded & mounted (0 overhead when collapsed/closed)
    let wasPlaying = false;
    const unsubscribeClock = defaultTransportClock.subscribe((telemetry) => {
        if (destroyed) return;
        latestTelemetry = telemetry;
        if (telemetry.isPlaying) {
            wasPlaying = true;
            const nodeIdKey = String(ctx.node?.id ?? '');
            const busLvl = telemetry.busLevels?.get(nodeIdKey);
            let livePeak = busLvl ? busLvl.peak : 0;
            if (livePeak <= 0 && telemetry.realtimeScope && telemetry.realtimeScope.length > 0) {
                for (let i = 0; i < telemetry.realtimeScope.length; i++) {
                    const a = Math.abs(telemetry.realtimeScope[i]);
                    if (a > livePeak) livePeak = a;
                }
            }
            ringPeak[ringHead] = livePeak;
            grHistory[ringHead] = currentMeterDb;
            ringHead = (ringHead + 1) % SCOPE_COLS;
            draw();
        } else if (wasPlaying) {
            wasPlaying = false;
            currentMeterDb = 0;
            grHistory.fill(0);
            draw();
        }
    });

    draw();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(canvas);

    return {
        element: root,
        syncFromParams() {
            strip.sync();
            draw();
        },
        updateMeter(val: number) {
            currentMeterDb = val;
            if (!latestTelemetry.isPlaying && Math.abs(val) > 0.05) {
                draw();
            }
        },
        refreshWaveform() {
            draw();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            unsubscribeClock();
            ro?.disconnect();
        },
    };
}

/* ---------------- 3. Clipper Visual (Zoomed Single-Sided Scope + Clipped Peak Highlight) ---------------- */

function createClipperVisual(ctx: FxVisualContext): FxVisualHandle {
    return createDynamicsScopeVisual(ctx, {
        height: 136,
        accentColor: '#fda4af',
        highlightFill: 'rgba(244, 63, 94, 0.56)',
        highlightStroke: '#fb7185',
        lineColor: '#fb7185',
        thresholdParamKey: 'ceiling_db',
        thresholdLabel: 'CEIL',
        meterLabel: 'CLIP',
        minThreshDb: -24,
        maxThreshDb: 0,
        ampExp: 0.58,
        zeroDbSplit: 0.84,
        refDbTicks: [0, -6, -12, -18, -24],
        showGrTrace: false,
        getDriveGainLin: () => Math.pow(10, Number(ctx.module.params?.drive_db ?? 0) / 20),
    });
}

/* ---------------- 4. Compressor Visual (Zoomed Single-Sided Scope + Threshold + GR) ---------------- */

function createCompVisual(ctx: FxVisualContext): FxVisualHandle {
    return createDynamicsScopeVisual(ctx, {
        height: 136,
        accentColor: '#7dd3fc',
        highlightFill: 'rgba(245, 158, 11, 0.42)',
        highlightStroke: '#f59e0b',
        lineColor: '#38bdf8',
        thresholdParamKey: 'threshold_db',
        thresholdLabel: 'THR',
        meterLabel: 'GR',
        minThreshDb: -60,
        maxThreshDb: 0,
        ampExp: 0.42,
        zeroDbSplit: 0.90,
        refDbTicks: [0, -6, -12, -24, -36],
        showGrTrace: true,
        getDriveGainLin: () => 1.0,
        computeReducedAmp: (inAmp: number) => {
            if (inAmp <= 1e-6) return 0;
            const p = ctx.module.params || {};
            const thresh = Number(p.threshold_db ?? -18);
            const ratio = Math.max(1, Number(p.ratio ?? 4));
            const knee = Math.max(0, Number(p.knee_db ?? 3));
            const mix = Math.max(0, Math.min(1, Number(p.mix ?? 100) * 0.01));
            const inDb = 20 * Math.log10(inAmp);
            const over = inDb - thresh;
            const slope = 1 - 1 / ratio;
            const halfKnee = 0.5 * knee;
            let gr = 0;
            if (knee > 1e-4) {
                if (over >= halfKnee) gr = -slope * over;
                else if (over > -halfKnee) {
                    const x = over + halfKnee;
                    gr = -slope * (x * x) / (2 * knee);
                }
            } else if (over > 0) {
                gr = -slope * over;
            }
            const gainLin = (1 - mix) + mix * Math.pow(10, gr / 20);
            return inAmp * gainLin;
        },
    });
}

/* ---------------- 5. Limiter Visual (Zoomed Single-Sided Scope + Ceiling + GR) ---------------- */

function createLimiterVisual(ctx: FxVisualContext): FxVisualHandle {
    return createDynamicsScopeVisual(ctx, {
        height: 136,
        accentColor: '#fcd34d',
        highlightFill: 'rgba(245, 158, 11, 0.54)',
        highlightStroke: '#fbbf24',
        lineColor: '#fbbf24',
        thresholdParamKey: 'ceiling_db',
        thresholdLabel: 'CEIL',
        meterLabel: 'GR',
        minThreshDb: -24,
        maxThreshDb: 0,
        ampExp: 0.58,
        zeroDbSplit: 0.84,
        refDbTicks: [0, -6, -12, -18, -24],
        showGrTrace: true,
        getDriveGainLin: () => Math.pow(10, Number(ctx.module.params?.input_gain_db ?? 0) / 20),
    });
}

export const FX_VISUAL_REGISTRY: Record<string, FxVisualFactory> = {
    param_eq: createParamEqVisual,
    comp: createCompVisual,
    clipper: createClipperVisual,
    limiter: createLimiterVisual,
};

export function createFxVisualWidget(ctx: FxVisualContext): FxVisualHandle | null {
    const factory = FX_VISUAL_REGISTRY[ctx.def.type];
    return factory ? factory(ctx) : null;
}

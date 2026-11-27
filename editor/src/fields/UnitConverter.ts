export type MeasurementUnitId =
    | 'time'
    | 's'
    | 'ms'
    | 'beats'
    | 'bars'
    | 'percent'
    | 'fraction'
    | 'samples';

export type UnitFamily = 'audio_position' | 'audio_duration' | 'time';
export type CanonicalUnit = 'fraction' | 'seconds' | 'beats';

export interface UnitConversionContext {
    durationSec: number;
    bpm: number;
    sampleRate: number;
    beatsPerBar?: number;
    warpEnabled?: boolean;
}

export interface UnitFieldConfig {
    family: UnitFamily;
    canonical: CanonicalUnit;
    units: readonly MeasurementUnitId[];
    unitGroup?: string;
    defaultUnit?: MeasurementUnitId | ((ctx: UnitConversionContext) => MeasurementUnitId);
}

export interface UnitDefinition {
    id: MeasurementUnitId;
    shortLabel: string;
    label: string;
    isInteger: boolean;
    defaultStep: number;
    wheelSteps: readonly number[];
}

export const UNIT_DEFINITIONS: Record<MeasurementUnitId, UnitDefinition> = {
    time: {
        id: 'time',
        shortLabel: 'TC',
        label: 'Timecode (M:SS.ms)',
        isInteger: false,
        defaultStep: 0.1,
        wheelSteps: [60, 10, 1, 0.1, 0.01],
    },
    s: {
        id: 's',
        shortLabel: 's',
        label: 'Seconds',
        isInteger: false,
        defaultStep: 0.1,
        wheelSteps: [60, 10, 1, 0.1, 0.01, 0.001],
    },
    ms: {
        id: 'ms',
        shortLabel: 'ms',
        label: 'Milliseconds',
        isInteger: false,
        defaultStep: 10,
        wheelSteps: [1000, 100, 10, 1, 0.1],
    },
    beats: {
        id: 'beats',
        shortLabel: 'bt',
        label: 'Beats',
        isInteger: false,
        defaultStep: 0.25,
        wheelSteps: [4, 1, 0.25, 0.0625, 0.01],
    },
    bars: {
        id: 'bars',
        shortLabel: 'bar',
        label: 'Bars',
        isInteger: false,
        defaultStep: 0.25,
        wheelSteps: [4, 1, 0.25, 0.0625],
    },
    percent: {
        id: 'percent',
        shortLabel: '%',
        label: 'Percent (0–100%)',
        isInteger: false,
        defaultStep: 1,
        wheelSteps: [10, 1, 0.1, 0.01],
    },
    fraction: {
        id: 'fraction',
        shortLabel: '0-1',
        label: 'Fraction (0–1)',
        isInteger: false,
        defaultStep: 0.01,
        wheelSteps: [0.1, 0.01, 0.001, 0.0001],
    },
    samples: {
        id: 'samples',
        shortLabel: 'smp',
        label: 'Samples',
        isInteger: true,
        defaultStep: 100,
        wheelSteps: [10000, 1000, 100, 10, 1],
    },
};

export const AUDIO_POSITION_UNITS: readonly MeasurementUnitId[] = [
    'time',
    's',
    'ms',
    'beats',
    'bars',
    'percent',
    'fraction',
    'samples',
];

export const TIME_DURATION_UNITS: readonly MeasurementUnitId[] = [
    'time',
    's',
    'ms',
    'beats',
    'bars',
    'samples',
];

function safePositive(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getUnitDefinition(unit: MeasurementUnitId): UnitDefinition {
    return UNIT_DEFINITIONS[unit] || UNIT_DEFINITIONS.s;
}

export function resolveNodeUnitContext(node: any): UnitConversionContext {
    const props = node?.properties || {};
    const slots = typeof node?.getSlots === 'function'
        ? node.getSlots()
        : (Array.isArray(props.slots) ? props.slots : []);
    const activeIdx = Math.max(0, Number(node?.activeSlotIndex ?? props.active_slot ?? 0));
    const activeSlot = Array.isArray(slots) && slots[activeIdx] ? slots[activeIdx] : null;

    const audioDur = Number(node?.audioBuffer?.duration || 0);
    const peakDur = typeof node?.getActivePeakDuration === 'function'
        ? Number(node.getActivePeakDuration() || 0)
        : 0;
    const slotDur = Number(activeSlot?.duration_seconds || 0);
    const propDur = Number(props.duration_seconds || 0);
    const durationSec = (audioDur > 0 && Number.isFinite(audioDur))
        ? audioDur
        : (peakDur > 0 && Number.isFinite(peakDur))
            ? peakDur
            : (slotDur > 0 && Number.isFinite(slotDur))
                ? slotDur
                : (propDur > 0 && Number.isFinite(propDur) ? propDur : 0);

    const win = typeof window !== 'undefined' ? (window as any) : undefined;
    const globalBpm = Number(win?.getGlobalParameter?.('bpm') ?? win?.activeWorkspaceManifest?.bpm ?? 120);
    const safeGlobalBpm = safePositive(globalBpm, 120);

    const origBpm = Number(activeSlot?.original_bpm ?? props.original_bpm ?? 0);
    const rawTarget = activeSlot?.target_bpm ?? props.target_bpm;
    const targetBpm = (rawTarget != null && String(rawTarget).toLowerCase() !== 'global' && Number(rawTarget) > 0)
        ? Number(rawTarget)
        : safeGlobalBpm;

    // For source-relative audio positions (crop start/end/length), source BPM maps
    // directly to musical beats of the loop (which remain 1:1 aligned when warped to Target BPM).
    const bpm = (Number.isFinite(origBpm) && origBpm >= 20 && origBpm <= 400)
        ? origBpm
        : safePositive(targetBpm, 120);

    const sampleRate = safePositive(
        Number(node?.audioBuffer?.sampleRate || props.sample_rate || 48000),
        48000
    );

    const warpEnabled = typeof node?.isWarpEnabled === 'function'
        ? Boolean(node.isWarpEnabled())
        : (props.warp !== undefined
            ? Boolean(props.warp)
            : String(props.stretch_mode || 'time_stretch').toLowerCase() === 'time_stretch'
                && String(props.sample_type || 'loop').toLowerCase() !== 'one_shot');

    return {
        durationSec,
        bpm,
        sampleRate,
        beatsPerBar: 4,
        warpEnabled,
    };
}

export function canonicalToUnit(
    canonicalVal: number,
    canonicalUnit: CanonicalUnit,
    targetUnit: MeasurementUnitId,
    ctx: UnitConversionContext
): number {
    if (!Number.isFinite(canonicalVal)) return 0;

    const bpm = safePositive(ctx.bpm, 120);
    const sr = safePositive(ctx.sampleRate, 48000);
    const bpb = safePositive(ctx.beatsPerBar ?? 4, 4);
    const dur = Number.isFinite(ctx.durationSec) && ctx.durationSec > 0 ? ctx.durationSec : 0;

    // Fast path for dimensionless conversions even before audio duration is known
    if (canonicalUnit === 'fraction') {
        if (targetUnit === 'fraction') return canonicalVal;
        if (targetUnit === 'percent') return canonicalVal * 100;
        if (dur <= 0) return 0;
    }

    let seconds = 0;
    if (canonicalUnit === 'fraction') {
        seconds = canonicalVal * dur;
    } else if (canonicalUnit === 'beats') {
        seconds = canonicalVal * (60 / bpm);
    } else {
        seconds = canonicalVal;
    }

    switch (targetUnit) {
        case 'time':
        case 's':
            return seconds;
        case 'ms':
            return seconds * 1000;
        case 'beats':
            return seconds * (bpm / 60);
        case 'bars':
            return (seconds * (bpm / 60)) / bpb;
        case 'percent':
            return dur > 0 ? (seconds / dur) * 100 : 0;
        case 'fraction':
            return dur > 0 ? seconds / dur : 0;
        case 'samples':
            return Math.round(seconds * sr);
        default:
            return seconds;
    }
}

export function unitToCanonical(
    displayVal: number,
    sourceUnit: MeasurementUnitId,
    canonicalUnit: CanonicalUnit,
    ctx: UnitConversionContext
): number {
    if (!Number.isFinite(displayVal)) return 0;

    const bpm = safePositive(ctx.bpm, 120);
    const sr = safePositive(ctx.sampleRate, 48000);
    const bpb = safePositive(ctx.beatsPerBar ?? 4, 4);
    const dur = Number.isFinite(ctx.durationSec) && ctx.durationSec > 0 ? ctx.durationSec : 0;

    // Fast path for dimensionless conversions even before duration is known
    if (canonicalUnit === 'fraction') {
        if (sourceUnit === 'fraction') return displayVal;
        if (sourceUnit === 'percent') return displayVal / 100;
        if (dur <= 0) return 0;
    }

    let seconds = 0;
    switch (sourceUnit) {
        case 'time':
        case 's':
            seconds = displayVal;
            break;
        case 'ms':
            seconds = displayVal / 1000;
            break;
        case 'beats':
            seconds = displayVal * (60 / bpm);
            break;
        case 'bars':
            seconds = displayVal * bpb * (60 / bpm);
            break;
        case 'percent':
            seconds = dur > 0 ? (displayVal / 100) * dur : 0;
            break;
        case 'fraction':
            seconds = dur > 0 ? displayVal * dur : 0;
            break;
        case 'samples':
            seconds = displayVal / sr;
            break;
        default:
            seconds = displayVal;
            break;
    }

    if (canonicalUnit === 'fraction') {
        return dur > 0 ? seconds / dur : 0;
    }
    if (canonicalUnit === 'beats') {
        return seconds * (bpm / 60);
    }
    return seconds;
}

function trimFixed(val: number, maxDecimals: number, minDecimals = 0): string {
    if (!Number.isFinite(val)) return '0';
    const fixed = val.toFixed(maxDecimals);
    if (maxDecimals <= minDecimals) return fixed;
    const [intPart, fracPart] = fixed.split('.');
    if (!fracPart) return intPart;
    let trimmed = fracPart;
    while (trimmed.length > minDecimals && trimmed.endsWith('0')) {
        trimmed = trimmed.slice(0, -1);
    }
    return trimmed.length > 0 ? `${intPart}.${trimmed}` : intPart;
}

export function formatTimecode(seconds: number): string {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const totalMs = Math.round(safe * 1000);
    const hours = Math.floor(totalMs / 3600000);
    const remAfterH = totalMs - hours * 3600000;
    const mins = Math.floor(remAfterH / 60000);
    const remAfterM = remAfterH - mins * 60000;
    const secs = Math.floor(remAfterM / 1000);
    const ms = remAfterM - secs * 1000;

    // Show centiseconds (2 digits) unless sub-10ms precision is present
    const frac = (ms % 10 === 0)
        ? String(Math.floor(ms / 10)).padStart(2, '0')
        : String(ms).padStart(3, '0');

    if (hours > 0) {
        return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${frac}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}.${frac}`;
}

export function formatUnitValue(displayVal: number, unit: MeasurementUnitId): string {
    if (!Number.isFinite(displayVal)) return '0';
    switch (unit) {
        case 'time':
            return formatTimecode(displayVal);
        case 's':
            return trimFixed(displayVal, 3, 2);
        case 'ms':
            return trimFixed(displayVal, 1, 0);
        case 'beats':
            return trimFixed(displayVal, 3, 2);
        case 'bars':
            return trimFixed(displayVal, 3, 2);
        case 'percent':
            return trimFixed(displayVal, 2, 1);
        case 'fraction':
            return trimFixed(displayVal, 4, 2);
        case 'samples':
            return String(Math.round(displayVal));
        default:
            return trimFixed(displayVal, 3, 0);
    }
}

export function parseUnitInput(
    raw: string,
    activeUnit: MeasurementUnitId
): { value: number; unit: MeasurementUnitId } | null {
    const str = String(raw || '').trim();
    if (!str) return null;

    // Timecode syntax: H:MM:SS(.ms) or M:SS(.ms)
    if (str.includes(':')) {
        const parts = str.split(':').map(p => p.trim());
        if (parts.length === 2 || parts.length === 3) {
            const nums = parts.map(p => Number(p));
            if (nums.every(n => Number.isFinite(n) && n >= 0)) {
                const seconds = parts.length === 3
                    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
                    : nums[0] * 60 + nums[1];
                return { value: seconds, unit: 'time' };
            }
        }
        return null;
    }

    // Explicit inline unit suffix (e.g. "250ms", "1.5s", "4bt", "2bars", "50%", "48000smp")
    const suffixMatch = str.match(/^([+-]?\d*\.?\d+)\s*(ms|sec|s|beats|beat|bt|bars|bar|%|pct|samples|sample|smp|frac|norm)$/i);
    if (suffixMatch) {
        const num = Number(suffixMatch[1]);
        if (!Number.isFinite(num)) return null;
        const tok = suffixMatch[2].toLowerCase();
        if (tok === 'ms') return { value: num, unit: 'ms' };
        if (tok === 's' || tok === 'sec') return { value: num, unit: 's' };
        if (tok === 'beats' || tok === 'beat' || tok === 'bt') return { value: num, unit: 'beats' };
        if (tok === 'bars' || tok === 'bar') return { value: num, unit: 'bars' };
        if (tok === '%' || tok === 'pct') return { value: num, unit: 'percent' };
        if (tok === 'samples' || tok === 'sample' || tok === 'smp') return { value: num, unit: 'samples' };
        if (tok === 'frac' || tok === 'norm') return { value: num, unit: 'fraction' };
    }

    const plain = Number(str);
    if (!Number.isFinite(plain)) return null;
    return { value: plain, unit: activeUnit };
}

export function resolveFieldUnit(
    node: any,
    fieldKey: string,
    config: UnitFieldConfig,
    ctx: UnitConversionContext
): MeasurementUnitId {
    const fieldUnits = node?.properties?.field_units;
    const allowed = config.units;
    const isValid = (u: unknown): u is MeasurementUnitId =>
        typeof u === 'string' && allowed.includes(u as MeasurementUnitId);

    if (fieldUnits && typeof fieldUnits === 'object') {
        if (config.unitGroup) {
            const groupSaved = fieldUnits[`__group:${config.unitGroup}`];
            if (isValid(groupSaved)) return groupSaved;
        }
        const saved = fieldUnits[fieldKey];
        if (isValid(saved)) return saved;
    }

    if (typeof config.defaultUnit === 'function') {
        const resolved = config.defaultUnit(ctx);
        if (isValid(resolved)) return resolved;
    } else if (isValid(config.defaultUnit)) {
        return config.defaultUnit;
    }

    // Sensible auto-default when no manual override has been picked yet
    if (ctx.warpEnabled && allowed.includes('beats')) {
        return 'beats';
    }
    if (allowed.includes('time')) return 'time';
    return allowed[0] || 's';
}

export function setFieldUnit(
    node: any,
    fieldKey: string,
    config: UnitFieldConfig,
    nextUnit: MeasurementUnitId
): void {
    if (!node) return;
    if (!node.properties) node.properties = {};
    const prevMap = (node.properties.field_units && typeof node.properties.field_units === 'object')
        ? { ...node.properties.field_units }
        : {};
    prevMap[fieldKey] = nextUnit;
    if (config.unitGroup) {
        prevMap[`__group:${config.unitGroup}`] = nextUnit;
    }
    if (typeof node.updateProperty === 'function') {
        node.updateProperty('field_units', prevMap);
    } else {
        node.properties.field_units = prevMap;
    }
    if (typeof window !== 'undefined' && node.id != null) {
        window.dispatchEvent(new CustomEvent('node-field-unit-changed', {
            detail: {
                nodeId: node.id,
                key: fieldKey,
                unitGroup: config.unitGroup || null,
                unit: nextUnit,
            },
        }));
    }
}

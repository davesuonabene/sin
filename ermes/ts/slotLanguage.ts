/**
 * ERMES Deterministic Slot & Seed Pseudo-Language Engine
 *
 * Provides cross-language bit-identical PRNG (SplitMix32 + Mulberry32)
 * and evaluates slot/seed pseudo-language expressions:
 * - Single integer: "0", "42"
 * - Whitespaced sequence: "0 1", "42 108" (cycles deterministically)
 * - Random keyword: "rand", "random", or mixed "0 0 1 rand"
 */

export interface NodeSlot {
    slot?: number;
    index?: number;
    label?: string;
    filepath?: string;
    library_item_id?: number | string | null;
    original_bpm?: number | null;
    key?: string | null;
    duration_seconds?: number | null;
    crop_start?: number;
    crop_end?: number;
    sample_start?: number;
    sample_end?: number;
    pitch_shift?: number;
    time_stretch?: number;
    sequence?: number[];
    step_parameters?: Array<Record<string, any>>;
    step_length?: number;
    sample_slot?: string;
    step_slots?: number[];
    seed?: string | number;
    cycle_seeds?: number[];
}

/**
 * 32-bit SplitMix32 avalanching hash (bit-identical to Python `hash_seed`).
 */
export function hashSeed(baseSeed: number, index: number = 0, salt: number = 0, extraSalt: number = 0): number {
    let h = (
        (baseSeed >>> 0) ^
        Math.imul(index >>> 0, 0x9E3779B9) ^
        Math.imul(salt >>> 0, 0x85EBCA6B) ^
        Math.imul(extraSalt >>> 0, 0xC2B2AE35)
    ) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Fast, deterministic 32-bit PRNG returning floats in [0, 1) (bit-identical to Python `mulberry32`).
 */
export function mulberry32(seed: number): () => number {
    let a = (seed >>> 0) || 1;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296.0;
    };
}

/**
 * Convert any string or numeric seed value into a stable 32-bit unsigned integer.
 */
export function normalizeNumericSeed(val: unknown, fallback: number = 42): number {
    if (typeof val === 'number' && Number.isFinite(val)) {
        if (val > 0 && val < 1) {
            return Math.floor(val * 10000);
        }
        return (Math.round(val) >>> 0);
    }
    const str = String(val ?? '').trim();
    if (!str) return fallback >>> 0;
    const parsed = Number(str);
    if (Number.isFinite(parsed)) {
        if (parsed > 0 && parsed < 1) {
            return Math.floor(parsed * 10000);
        }
        return (Math.round(parsed) >>> 0);
    }
    // FNV-1a string hash for non-numeric tokens
    let h = 0x811C9DC5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/**
 * Modulo-wraps a requested slot index around the available upstream slot count N >= 1.
 * Ensures overflowing indices (e.g. requesting slot 1 when N=1) safely wrap to 0.
 */
export function wrapSlotIndex(slotIndex: number, upstreamSlotCount: number): number {
    const safeCount = Math.max(1, Math.floor(Number(upstreamSlotCount) || 1));
    const idx = Math.floor(Number(slotIndex) || 0);
    return ((idx % safeCount) + safeCount) % safeCount;
}

export function isRandomToken(token: string): boolean {
    const t = token.trim().toLowerCase();
    return t === 'rand' || t === 'random';
}

/**
 * Tokenizes a whitespace-separated pseudo-language string (or number).
 */
export function tokenizeExpression(expr: unknown, defaultToken: string = '0'): string[] {
    const raw = String(expr ?? '').trim();
    if (!raw) return [defaultToken];
    const tokens = raw.split(/[\s,]+/).filter(Boolean);
    return tokens.length > 0 ? tokens : [defaultToken];
}

/**
 * Resolves a seed expression (e.g. "42", "42 108", "rand", "42 42 42 rand")
 * across `numCycles` repetitions of a pattern.
 * - Single seed "42" -> [42, 42, ...] (1-cycle fixed deterministic loop)
 * - Sequence "42 108" -> [42, 108, 42, 108, ...] (multi-cycle deterministic loop)
 * - "rand" -> pseudo-random seed per cycle derived from runtimeSalt + cycleIndex
 */
export function resolveCycleSeeds(
    seedExpr: unknown,
    numCycles: number,
    runtimeSalt: number = 42
): number[] {
    const count = Math.max(1, Math.floor(Number(numCycles) || 1));
    const tokens = tokenizeExpression(seedExpr, '42');
    const baseSalt = normalizeNumericSeed(runtimeSalt, 42);
    const result: number[] = [];

    for (let c = 0; c < count; c++) {
        const token = tokens[c % tokens.length];
        if (isRandomToken(token)) {
            result.push((hashSeed(baseSalt, c, 0xCAFE) % 9999) + 1);
        } else {
            result.push(normalizeNumericSeed(token, 42));
        }
    }
    return result;
}

/**
 * Resolves per-slot seeds when a Modifier (AssetFilter Pool or RandomNode)
 * populates `slotCount` slots on its owner node.
 * - If a single numeric seed "42" is given, Slot 0 gets 42 and Slot s > 0 gets
 *   a deterministic sub-seed `hashSeed(42, s)` so different slots receive distinct variations.
 * - If a sequence "10 25" is given, Slot 0 gets 10 and Slot 1 gets 25.
 */
export function resolveModifierSlotSeeds(
    seedExpr: unknown,
    slotCount: number,
    runtimeSalt: number = 42
): number[] {
    const count = Math.max(1, Math.floor(Number(slotCount) || 1));
    const tokens = tokenizeExpression(seedExpr, '42');
    const baseSalt = normalizeNumericSeed(runtimeSalt, 42);
    const result: number[] = [];

    if (tokens.length === 1 && !isRandomToken(tokens[0])) {
        const baseSeed = normalizeNumericSeed(tokens[0], 42);
        for (let s = 0; s < count; s++) {
            result.push(s === 0 ? baseSeed : ((hashSeed(baseSeed, s, 0x7777) % 9999) + 1));
        }
        return result;
    }

    for (let s = 0; s < count; s++) {
        const token = tokens[s % tokens.length];
        if (isRandomToken(token)) {
            result.push((hashSeed(baseSalt, s, 0xBEEF) % 9999) + 1);
        } else {
            result.push(normalizeNumericSeed(token, 42));
        }
    }
    return result;
}

/**
 * Resolves a `sample_slot` pseudo-language expression (e.g. "0", "0 1", "0 0 1 rand")
 * across `stepCount` steps (e.g. 16), wrapping all resolved indices modulo `upstreamSlotCount`.
 */
export function resolveStepSlots(
    slotExpr: unknown,
    stepCount: number,
    upstreamSlotCount: number,
    cycleSeed: number = 42
): number[] {
    const count = Math.max(1, Math.floor(Number(stepCount) || 16));
    const safeSlotCount = Math.max(1, Math.floor(Number(upstreamSlotCount) || 1));
    const tokens = tokenizeExpression(slotExpr, '0');
    const numericSeed = normalizeNumericSeed(cycleSeed, 42);
    const result: number[] = [];

    for (let i = 0; i < count; i++) {
        const token = tokens[i % tokens.length];
        let rawSlot = 0;
        if (isRandomToken(token)) {
            const prng = mulberry32(hashSeed(numericSeed, i, 0x5107));
            rawSlot = Math.floor(prng() * safeSlotCount);
        } else {
            const parsed = parseInt(token, 10);
            rawSlot = Number.isFinite(parsed) ? parsed : 0;
        }
        result.push(wrapSlotIndex(rawSlot, safeSlotCount));
    }
    return result;
}

/**
 * Re-rolls all numeric tokens in a seed expression while preserving "rand" / "random" tokens.
 * Used when the user clicks the global Refresh button on armed seed fields.
 */
export function rollSeedExpression(seedExpr: unknown, randomFn: () => number = Math.random): string {
    const tokens = tokenizeExpression(seedExpr, '42');
    const nextTokens = tokens.map(token => {
        if (isRandomToken(token)) return 'rand';
        let nextInt = Math.floor(randomFn() * 9999) + 1;
        if (String(nextInt) === token) {
            nextInt = (nextInt % 9999) + 1;
        }
        return String(nextInt);
    });
    return nextTokens.join(' ');
}

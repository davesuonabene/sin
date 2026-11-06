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
    pool_query?: string;
    sequence_name?: string;
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
    field_operators?: Record<string, string>;
    [key: string]: any;
}

export interface CopiedNodeSlotPayload {
    nodeType: string;
    slot: NodeSlot;
    copiedAt: number;
}

const SLOT_CLIPBOARD_STORAGE_KEY = 'sin_node_slot_clipboard_v1';
let inMemorySlotClipboard: CopiedNodeSlotPayload | null = null;

export function copyNodeSlotToClipboard(nodeType: string, slot: NodeSlot): NodeSlot {
    const cloned: NodeSlot = JSON.parse(JSON.stringify(slot || {}));
    const payload: CopiedNodeSlotPayload = {
        nodeType: String(nodeType || '').toLowerCase(),
        slot: cloned,
        copiedAt: Date.now()
    };
    inMemorySlotClipboard = payload;
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(SLOT_CLIPBOARD_STORAGE_KEY, JSON.stringify(payload));
        }
    } catch {
        // Ignore storage quota/access errors
    }
    return JSON.parse(JSON.stringify(cloned));
}

export function getCopiedNodeSlotFromClipboard(expectedNodeType?: string): CopiedNodeSlotPayload | null {
    let payload: CopiedNodeSlotPayload | null = inMemorySlotClipboard;
    if (!payload) {
        try {
            if (typeof localStorage !== 'undefined') {
                const raw = localStorage.getItem(SLOT_CLIPBOARD_STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && parsed.slot) {
                        payload = parsed;
                        inMemorySlotClipboard = parsed;
                    }
                }
            }
        } catch {
            // Ignore malformed clipboard
        }
    }
    if (!payload || !payload.slot) return null;
    if (expectedNodeType && payload.nodeType !== String(expectedNodeType).toLowerCase()) {
        return null;
    }
    return {
        nodeType: payload.nodeType,
        slot: JSON.parse(JSON.stringify(payload.slot)),
        copiedAt: payload.copiedAt
    };
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

export function isDefaultSlotToken(token: unknown): boolean {
    const t = String(token ?? '').trim().toLowerCase();
    return t === '*' || t === 'default' || t === 'active';
}

/**
 * Parses a range operator token such as "-12..12", "0.1..0.9", or "rand(-5, 5)".
 * Returns `{ min, max }` when matched, or `null` otherwise.
 */
export function isRangeOperatorToken(token: unknown): { min: number; max: number } | null {
    const raw = String(token ?? '').trim();
    if (!raw) return null;

    const funcMatch = raw.match(/^(?:rand|random)\s*\(\s*(-?\d+(?:\.\d+)?)\s*[,;:]\s*(-?\d+(?:\.\d+)?)\s*\)$/i);
    if (funcMatch) {
        const a = parseFloat(funcMatch[1]);
        const b = parseFloat(funcMatch[2]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
            return { min: Math.min(a, b), max: Math.max(a, b) };
        }
    }

    const dotMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/);
    if (dotMatch) {
        const a = parseFloat(dotMatch[1]);
        const b = parseFloat(dotMatch[2]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
            return { min: Math.min(a, b), max: Math.max(a, b) };
        }
    }

    return null;
}

/**
 * Tokenizes a Field Operator expression into individual tokens.
 * Supports:
 * - Quoted strings ("Kick 01.wav" "Kick 02.wav")
 * - Function-style tokens with internal commas ("rand(-5, 5)")
 * - Whitespace- or comma-separated token lists ("0 0 0 1", "kick_a kick_b", "0, 5, -3")
 */
export function tokenizeFieldOperator(expr: unknown): string[] {
    const raw = String(expr ?? '').trim();
    if (!raw) return [];

    const tokens: string[] = [];
    const regex = /"([^"]+)"|'([^']+)'|((?:rand|random)\s*\([^)]+\))|[^\s,]+/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
        const token = (match[1] ?? match[2] ?? match[3] ?? match[0]).trim();
        if (token) tokens.push(token);
    }
    return tokens;
}

/**
 * Returns `true` if `expr` is an active Field Operator (calculated value):
 * - A random keyword ("rand", "random")
 * - A range operator ("-12..12", "rand(-5, 5)")
 * - A multi-token cycle list ("0 0 0 1", "kick_a.wav kick_b.wav", "0 5 -3")
 * Returns `false` for empty strings, single fixed numbers, or single fixed names.
 */
export function isFieldOperatorExpression(expr: unknown): boolean {
    const raw = String(expr ?? '').trim();
    if (!raw) return false;
    const tokens = tokenizeFieldOperator(raw);
    if (tokens.length === 0) return false;
    if (tokens.length > 1) return true;
    const single = tokens[0];
    return isRandomToken(single) || isRangeOperatorToken(single) !== null;
}

/**
 * Formats an array of dropped pool/library items into a clean list operator string
 * (e.g. `"kick_a.wav kick_b.wav"`) that cycles deterministically by node trigger count.
 */
export function formatPoolListExpression(items: any[]): string {
    if (!Array.isArray(items) || items.length === 0) return '';
    const formatted = items
        .map(item => {
            const fp = String(item?.filepath || item?.absolute_path || '').trim();
            const base = (fp ? fp.split(/[\\/]/).pop() : '') || String(item?.name || '').trim();
            if (!base) return '';
            return /\s/.test(base) ? `"${base.replace(/"/g, '')}"` : base;
        })
        .filter(Boolean);
    return formatted.join(' ');
}

/**
 * Evaluates a numeric Field Operator expression (list cycle, `rand`, or range `min..max`)
 * into a concrete number.
 * - List selection (`a b c`) is strictly driven by `triggerCount` (independent of `seed`).
 * - Random/range tokens (`rand`, `min..max`) are driven by `seed` + `triggerCount`.
 */
export function evaluateNumericFieldOperator(
    expr: unknown,
    options: {
        triggerCount?: number;
        seed?: unknown;
        salt?: number;
        min?: number;
        max?: number;
        step?: number;
        isInteger?: boolean;
        fallback?: number;
    } = {}
): number {
    const tokens = tokenizeFieldOperator(expr);
    const triggerIdx = Math.max(0, Math.floor(Number(options.triggerCount) || 0));
    const fallback = Number.isFinite(Number(options.fallback)) ? Number(options.fallback) : 0;
    if (tokens.length === 0) return fallback;

    const token = tokens[wrapSlotIndex(triggerIdx, tokens.length)];
    const numericSeed = normalizeNumericSeed(options.seed, 42);
    const salt = options.salt ?? 0xF1E1;
    let rawVal: number;

    const rangeSpec = isRangeOperatorToken(token);
    if (rangeSpec) {
        const prng = mulberry32(hashSeed(numericSeed, triggerIdx, salt));
        rawVal = rangeSpec.min + prng() * (rangeSpec.max - rangeSpec.min);
    } else if (isRandomToken(token)) {
        const lo = Number.isFinite(Number(options.min)) ? Number(options.min) : -1;
        const hi = Number.isFinite(Number(options.max)) ? Number(options.max) : 1;
        const prng = mulberry32(hashSeed(numericSeed, triggerIdx, salt));
        rawVal = Math.min(lo, hi) + prng() * Math.abs(hi - lo);
    } else {
        const parsed = parseFloat(token);
        rawVal = Number.isFinite(parsed) ? parsed : fallback;
    }

    if (options.isInteger) {
        rawVal = Math.round(rawVal);
    } else if (options.step !== undefined && options.step > 0) {
        const step = options.step;
        const precision = step.toString().includes('.') ? step.toString().split('.')[1].length : 0;
        rawVal = Number((Math.round(rawVal / step) * step).toFixed(precision));
    } else {
        rawVal = Number(rawVal.toFixed(4));
    }

    if (options.min !== undefined && Number.isFinite(options.min)) {
        rawVal = Math.max(options.min, rawVal);
    }
    if (options.max !== undefined && Number.isFinite(options.max)) {
        rawVal = Math.min(options.max, rawVal);
    }
    return rawVal;
}

/**
 * Evaluates a select/radio Field Operator expression against a list of options.
 * - List selection is driven by `triggerCount` (independent of `seed`).
 * - `rand` selects an option using `seed`.
 */
export function evaluateSelectFieldOperator(
    expr: unknown,
    optionsList: Array<string | { value: any; label?: string }>,
    options: {
        triggerCount?: number;
        seed?: unknown;
        salt?: number;
        fallback?: any;
    } = {}
): any {
    if (!Array.isArray(optionsList) || optionsList.length === 0) return options.fallback;
    const normalized = optionsList.map(opt =>
        typeof opt === 'object' && opt !== null
            ? { value: String(opt.value), label: String(opt.label ?? opt.value) }
            : { value: String(opt), label: String(opt) }
    );
    const tokens = tokenizeFieldOperator(expr);
    if (tokens.length === 0) return options.fallback ?? normalized[0].value;

    const triggerIdx = Math.max(0, Math.floor(Number(options.triggerCount) || 0));
    const token = tokens[wrapSlotIndex(triggerIdx, tokens.length)];
    const lower = token.toLowerCase();

    if (isRandomToken(token)) {
        const numericSeed = normalizeNumericSeed(options.seed, 42);
        const prng = mulberry32(hashSeed(numericSeed, triggerIdx, options.salt ?? 0x5E1E));
        const idx = Math.floor(prng() * normalized.length);
        return normalized[idx]?.value ?? options.fallback;
    }

    const direct = normalized.find(o => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower);
    if (direct) return direct.value;

    if (/^-?\d+$/.test(token)) {
        const idx = wrapSlotIndex(parseInt(token, 10), normalized.length);
        return normalized[idx]?.value ?? options.fallback;
    }

    const prefix = normalized.find(o => o.value.toLowerCase().startsWith(lower) || o.label.toLowerCase().startsWith(lower));
    return prefix ? prefix.value : (options.fallback ?? normalized[0].value);
}

/**
 * Tokenizes a whitespace-separated pseudo-language string (or number).
 */
export function tokenizeExpression(expr: unknown, defaultToken: string = '*'): string[] {
    const tokens = tokenizeFieldOperator(expr);
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
 * Resolves a `sample_slot` pseudo-language expression (e.g. "*", "0", "0 1", "* 1", "0 0 1 rand")
 * across `stepCount` steps (e.g. 16), wrapping all resolved indices modulo `upstreamSlotCount`.
 * The special token "*" listens to the upstream node's default/active slot (`upstreamActiveSlot`).
 */
export function resolveStepSlots(
    slotExpr: unknown,
    stepCount: number,
    upstreamSlotCount: number,
    cycleSeed: number = 42,
    upstreamActiveSlot: number = 0
): number[] {
    const count = Math.max(1, Math.floor(Number(stepCount) || 16));
    const safeSlotCount = Math.max(1, Math.floor(Number(upstreamSlotCount) || 1));
    const safeActiveSlot = Math.max(0, Math.floor(Number(upstreamActiveSlot) || 0));
    const tokens = tokenizeExpression(slotExpr, '*');
    const numericSeed = normalizeNumericSeed(cycleSeed, 42);
    const result: number[] = [];

    for (let i = 0; i < count; i++) {
        const token = tokens[i % tokens.length];
        let rawSlot = 0;
        if (isDefaultSlotToken(token)) {
            rawSlot = safeActiveSlot;
        } else if (isRandomToken(token)) {
            const prng = mulberry32(hashSeed(numericSeed, i, 0x5107));
            rawSlot = Math.floor(prng() * safeSlotCount);
        } else {
            const parsed = parseInt(token, 10);
            rawSlot = Number.isFinite(parsed) ? parsed : safeActiveSlot;
        }
        result.push(wrapSlotIndex(rawSlot, safeSlotCount));
    }
    return result;
}

/**
 * Resolves a single section slot selector (e.g. "*", 0, 1, "rand") against the connected
 * upstream node's slot count and active slot index.
 */
export function resolveSectionSlot(
    slotValue: unknown,
    upstreamSlotCount: number,
    upstreamActiveSlot: number = 0,
    sectionSeed: unknown = 42,
    sectionIndex: number = 0
): number {
    const safeSlotCount = Math.max(1, Math.floor(Number(upstreamSlotCount) || 1));
    const safeActiveSlot = Math.max(0, Math.floor(Number(upstreamActiveSlot) || 0));
    if (slotValue == null || isDefaultSlotToken(slotValue) || String(slotValue).trim() === '') {
        return wrapSlotIndex(safeActiveSlot, safeSlotCount);
    }
    const token = String(slotValue).trim();
    if (isRandomToken(token)) {
        const numericSeed = normalizeNumericSeed(sectionSeed, 42);
        const prng = mulberry32(hashSeed(numericSeed, sectionIndex, 0x5107));
        return wrapSlotIndex(Math.floor(prng() * safeSlotCount), safeSlotCount);
    }
    const parsed = Number(token);
    const rawSlot = Number.isFinite(parsed) ? Math.floor(parsed) : safeActiveSlot;
    return wrapSlotIndex(rawSlot, safeSlotCount);
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

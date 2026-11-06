/**
 * ERMES Deterministic Slot, Pool & Bracketed Field Operator Engine (TypeScript)
 *
 * Provides cross-language bit-identical PRNG (SplitMix32 + Mulberry32)
 * matching `ermes/py/slot_language.py` and evaluates hierarchical Field Operators:
 *
 * - Top-level (unbracketed): Global Scope (spans or subdivides Ancestor Master Global Length `G`)
 *   - `random` -> 1 random value per Global Trigger
 *   - `0 1` or `random random` -> subdivides Global Length `G` into equal slices
 * - `[ ... ]`: Cycle Scope (refreshes every Cycle Trigger `cycleIdx` and subdivides Cycle Length `C`)
 *   - `[random]` -> 1 random value per Cycle Trigger
 *   - `[0 1]` or `[0 random]` -> subdivides Cycle Length `C` into equal slices
 *   - `[random][random]` -> 2 top-level Global halves, each refreshing every Cycle Trigger
 * - `< ... >`: Sequential Event Scope (advances 1 item per active Event Request `eventIdx`)
 *   - `<0 1 2>` -> sequential round-robin across active events
 *   - `<random>` -> new random value on every active event
 *   - `<0 random>` -> alternates fixed `0` and fresh `random` on sequential events
 *   - `[0 <random>]` -> first half of cycle is `0`, second half rolls `random` on every event
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

export interface FieldEvalContext {
    /** Effective seed for field operators (derived from globalSeed + fieldRefreshEpoch + nodeId) */
    seed?: unknown;
    /** Salt for parameter key disambiguation */
    salt?: number;
    /** Global trigger index from ancestor Master (0, 1, 2, ...) */
    globalIdx?: number;
    /** Normalized progress within the current Global Trigger [0.0, 1.0) */
    globalProgress?: number;
    /** Cycle trigger index within the current Global Trigger (0, 1, 2, ...) */
    cycleIdx?: number;
    /** Normalized progress within the current Cycle Trigger [0.0, 1.0) */
    cycleProgress?: number;
    /** Continuous sequential event index within the current Global Trigger (0, 1, 2, ...) */
    eventIdx?: number;
    /** Window-local sequential event index when inside a subdivided slice (defaults to eventIdx) */
    windowEventIdx?: number;
    /** Legacy / simple sequential fallback (maps to cycleIdx and eventIdx when omitted) */
    triggerCount?: number;
}

export type FieldScope = 'global' | 'cycle' | 'event';

export type FieldAstNode =
    | { kind: 'global_group'; items: FieldAstNode[] }
    | { kind: 'cycle_group'; items: FieldAstNode[]; groupIndex: number }
    | { kind: 'event_group'; items: FieldAstNode[]; groupIndex: number }
    | { kind: 'atom'; value: string; tokenIndex: number };

export interface ResolvedFieldLeaf {
    expr: string;
    token: string;
    tokenIndex: number;
    scope: FieldScope;
    sliceIndex: number;
    isSubdividedWindow: boolean;
    effectiveEventIdx: number;
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
export function normalizeNumericSeed(val: unknown, fallback: number = 0): number {
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
 */
export function wrapSlotIndex(slotIndex: number, upstreamSlotCount: number): number {
    const safeCount = Math.max(1, Math.floor(Number(upstreamSlotCount) || 1));
    const idx = Math.floor(Number(slotIndex) || 0);
    return ((idx % safeCount) + safeCount) % safeCount;
}

/**
 * Computes a deterministic Fisher-Yates permutation of `[0, 1, ..., length - 1]`
 * driven by `poolSeed` and `nodeId`.
 * - When `poolSeed <= 0` (`global_seed == 0`), returns the identity order `[0, 1, ..., length - 1]`.
 * - When `poolSeed > 0`, returns a deterministically shuffled index mapping (bit-identical to Python).
 */
export function getPoolPermutationOrder(length: number, poolSeed: unknown, nodeId: number = 0): number[] {
    const n = Math.max(0, Math.floor(Number(length) || 0));
    const indices = Array.from({ length: n }, (_, i) => i);
    const seedInt = normalizeNumericSeed(poolSeed, 0);
    if (seedInt <= 0 || n <= 1) return indices;
    const prng = mulberry32(hashSeed(seedInt, Math.floor(Number(nodeId) || 0), 0x7001));
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(prng() * (i + 1));
        const tmp = indices[i];
        indices[i] = indices[j];
        indices[j] = tmp;
    }
    return indices;
}

/**
 * Returns a copy of `items` reordered deterministically by `poolSeed` (keeping `poolSeed == 0` as user order).
 */
export function permutePoolItems<T>(items: T[], poolSeed: unknown, nodeId: number = 0): T[] {
    if (!Array.isArray(items) || items.length <= 1) return Array.isArray(items) ? [...items] : [];
    const order = getPoolPermutationOrder(items.length, poolSeed, nodeId);
    return order.map(idx => items[idx]);
}

export function isRandomToken(token: string): boolean {
    const t = String(token ?? '').trim().toLowerCase();
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

const SINGLE_ASSET_FILENAME_RE = /^[^,[\]<>]+\.(?:wav|mp3|ogg|flac|aif|aiff|m4a|mid|midi|seq)$/i;

/**
 * Checks if a raw string is a single unbracketed asset filename (even if it contains spaces, e.g. "Kick 01.wav").
 */
export function isSingleAssetFilenameLiteral(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed || /[,[\]<>]/.test(trimmed)) return false;
    if (!SINGLE_ASSET_FILENAME_RE.test(trimmed)) return false;
    const extMatches = trimmed.match(/\.(?:wav|mp3|ogg|flac|aif|aiff|m4a|mid|midi|seq)\b/gi);
    return Boolean(extMatches && extMatches.length === 1);
}

/**
 * Lexical scanner for Field Operator strings.
 * Treats whitespace, commas (`,`), and bracket boundaries (`[`, `]`, `<`, `>`) as element dividers,
 * while preserving quoted strings and `rand(a, b)` function calls as atomic tokens.
 */
export function lexFieldOperator(expr: unknown): string[] {
    const raw = String(expr ?? '').trim();
    if (!raw) return [];
    if (isSingleAssetFilenameLiteral(raw)) {
        return [raw];
    }

    const tokens: string[] = [];
    const regex = /"([^"]+)"|'([^']+)'|((?:rand|random)\s*\([^)]+\))|(\[|\]|<|>)|[^\s,[\]<>]+/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
        if (match[1] !== undefined) {
            const q = match[1].trim();
            if (q) tokens.push(q);
        } else if (match[2] !== undefined) {
            const q = match[2].trim();
            if (q) tokens.push(q);
        } else if (match[3] !== undefined) {
            tokens.push(match[3].trim());
        } else if (match[4] !== undefined) {
            tokens.push(match[4]);
        } else {
            const atom = match[0].trim();
            if (atom) tokens.push(atom);
        }
    }
    return tokens;
}

/**
 * Flat tokenizer returning leaf tokens (stripping structural brackets) for legacy callers.
 */
export function tokenizeFieldOperator(expr: unknown): string[] {
    return lexFieldOperator(expr).filter(tok => tok !== '[' && tok !== ']' && tok !== '<' && tok !== '>');
}

/**
 * Parses a Field Operator string into a hierarchical AST:
 * - Outer `global_group` subdivides the Ancestor Global Length (`G`)
 * - `[ ... ]` `cycle_group` refreshes each Cycle Trigger and subdivides the Cycle Length (`C`)
 * - `< ... >` `event_group` advances sequentially on each active Event Request
 */
export function parseFieldOperatorAST(expr: unknown): Extract<FieldAstNode, { kind: 'global_group' }> {
    if (typeof expr === 'object' && expr !== null && 'kind' in expr) {
        const node = expr as FieldAstNode;
        if (node.kind === 'global_group') return node;
        return { kind: 'global_group', items: [node] };
    }
    const lexemes = lexFieldOperator(expr);
    let pos = 0;
    let nextTokenIndex = 0;
    let nextGroupIndex = 0;

    const parseItems = (closingBracket?: ']' | '>'): FieldAstNode[] => {
        const items: FieldAstNode[] = [];
        while (pos < lexemes.length) {
            const tok = lexemes[pos];
            if (closingBracket && tok === closingBracket) {
                pos++;
                break;
            }
            if (tok === ']' || tok === '>') {
                // Unmatched closing bracket: consume and continue gracefully
                pos++;
                continue;
            }
            if (tok === '[') {
                pos++;
                const groupIdx = nextGroupIndex++;
                const children = parseItems(']');
                if (children.length > 0) {
                    items.push({ kind: 'cycle_group', items: children, groupIndex: groupIdx });
                }
            } else if (tok === '<') {
                pos++;
                const groupIdx = nextGroupIndex++;
                const children = parseItems('>');
                if (children.length > 0) {
                    items.push({ kind: 'event_group', items: children, groupIndex: groupIdx });
                }
            } else {
                pos++;
                items.push({ kind: 'atom', value: tok, tokenIndex: nextTokenIndex++ });
            }
        }
        return items;
    };

    return {
        kind: 'global_group',
        items: parseItems(undefined)
    };
}

/**
 * Returns `true` if `expr` is an active Field Operator (calculated value):
 * - Contains any bracket operators `[ ... ]` or `< ... >`
 * - Contains a random keyword (`rand`, `random`)
 * - Contains a range operator (`-12..12`, `rand(-5, 5)`)
 * - Contains multiple space- or comma-separated tokens (`0 1`, `0, 5, -3`)
 * Returns `false` for empty strings, single fixed numbers, or single fixed asset names.
 */
export function isFieldOperatorExpression(expr: unknown, poolItems?: any[]): boolean {
    const raw = String(expr ?? '').trim();
    if (!raw) return false;

    if (Array.isArray(poolItems) && poolItems.length > 0 && !/[,[\]<>]/.test(raw) && !isRandomToken(raw) && !isRangeOperatorToken(raw)) {
        const lower = raw.toLowerCase();
        for (const item of poolItems) {
            const name = String(item?.name || '').trim().toLowerCase();
            const nameStem = name.replace(/\.[^.]+$/, '');
            const fp = String(item?.filepath || item?.absolute_path || '').trim();
            const base = (fp.split(/[\\/]/).pop() || '').toLowerCase();
            const baseStem = base.replace(/\.[^.]+$/, '');
            if (lower === name || lower === nameStem || lower === base || lower === baseStem) {
                return false;
            }
        }
    }

    if (/[\[\]<>]/.test(raw)) {
        return tokenizeFieldOperator(raw).length > 0;
    }

    const tokens = tokenizeFieldOperator(raw);
    if (tokens.length === 0) return false;
    if (tokens.length > 1) return true;
    const single = tokens[0];
    return isRandomToken(single) || isRangeOperatorToken(single) !== null;
}

/**
 * Evaluates a parsed Field Operator AST at the given hierarchical trigger context,
 * returning the selected leaf token and its deterministic evaluation scope.
 */
export function resolveFieldOperatorLeaf(
    expr: unknown,
    ctx: FieldEvalContext = {}
): ResolvedFieldLeaf | null {
    const ast = parseFieldOperatorAST(expr);
    if (ast.items.length === 0) return null;

    const legacyTrigger = ctx.triggerCount !== undefined ? Math.max(0, Math.floor(Number(ctx.triggerCount) || 0)) : undefined;
    const cycleIdx = Math.max(0, Math.floor(Number(ctx.cycleIdx ?? legacyTrigger ?? 0)));
    const eventIdx = Math.max(0, Math.floor(Number(ctx.eventIdx ?? legacyTrigger ?? 0)));
    const windowEventIdx = Math.max(0, Math.floor(Number(ctx.windowEventIdx ?? eventIdx)));

    const hasExplicitGlobalProgress = ctx.globalProgress !== undefined && Number.isFinite(Number(ctx.globalProgress));
    const hasExplicitCycleProgress = ctx.cycleProgress !== undefined && Number.isFinite(Number(ctx.cycleProgress));

    let globalProgress = hasExplicitGlobalProgress
        ? Math.max(0, Math.min(0.999999, Number(ctx.globalProgress)))
        : 0;
    let cycleProgress = hasExplicitCycleProgress
        ? Math.max(0, Math.min(0.999999, Number(ctx.cycleProgress)))
        : 0;

    const evalNode = (
        node: FieldAstNode,
        currentScope: FieldScope,
        gProg: number,
        cProg: number,
        activeSliceIdx: number,
        inSubdividedWindow: boolean
    ): ResolvedFieldLeaf | null => {
        if (node.kind === 'atom') {
            return {
                expr: node.value,
                token: node.value,
                tokenIndex: node.tokenIndex,
                scope: currentScope,
                sliceIndex: activeSliceIdx,
                isSubdividedWindow: inSubdividedWindow,
                effectiveEventIdx: inSubdividedWindow ? windowEventIdx : eventIdx,
            };
        }

        const items = node.items;
        const count = items.length;
        if (count === 0) return null;

        if (node.kind === 'global_group') {
            if (count === 1) {
                return evalNode(items[0], 'global', gProg, cProg, 0, inSubdividedWindow);
            }
            let sliceIdx: number;
            let localGProg: number;
            if (hasExplicitGlobalProgress) {
                const scaled = gProg * count;
                sliceIdx = Math.min(count - 1, Math.max(0, Math.floor(scaled)));
                localGProg = scaled - sliceIdx;
            } else {
                // Fallback when evaluated without timeline progress (e.g. direct triggerCount step)
                const fallbackIdx = legacyTrigger ?? cycleIdx;
                sliceIdx = wrapSlotIndex(fallbackIdx, count);
                localGProg = 0;
            }
            return evalNode(items[sliceIdx], 'global', localGProg, cProg, sliceIdx, true);
        }

        if (node.kind === 'cycle_group') {
            if (count === 1) {
                return evalNode(items[0], 'cycle', gProg, cProg, activeSliceIdx, inSubdividedWindow);
            }
            let sliceIdx: number;
            let localCProg: number;
            if (hasExplicitCycleProgress) {
                const scaled = cProg * count;
                sliceIdx = Math.min(count - 1, Math.max(0, Math.floor(scaled)));
                localCProg = scaled - sliceIdx;
            } else {
                const fallbackIdx = legacyTrigger ?? eventIdx;
                sliceIdx = wrapSlotIndex(fallbackIdx, count);
                localCProg = 0;
            }
            return evalNode(items[sliceIdx], 'cycle', gProg, localCProg, sliceIdx, true);
        }

        // node.kind === 'event_group' (`< ... >`)
        const effEvt = inSubdividedWindow ? windowEventIdx : eventIdx;
        const chosenIdx = wrapSlotIndex(effEvt, count);
        return evalNode(items[chosenIdx], 'event', gProg, cProg, chosenIdx, inSubdividedWindow);
    };

    return evalNode(ast, 'global', globalProgress, cycleProgress, 0, false);
}

/**
 * Computes the deterministic 32-bit PRNG seed for a resolved AST leaf based on its bracket scope:
 * - `'global'`: depends on `(seed, globalIdx, tokenIndex, salt)` (1 value per Global Trigger slice)
 * - `'cycle'`: depends on `(seed, globalIdx, cycleIdx, tokenIndex, salt)` (1 value per Cycle Trigger slice)
 * - `'event'`: depends on `(seed, globalIdx, cycleIdx, effectiveEventIdx, tokenIndex, salt)` (1 value per Event)
 */
export function computeLeafPrngSeed(leaf: ResolvedFieldLeaf, ctx: FieldEvalContext = {}): number {
    const baseSeed = normalizeNumericSeed(ctx.seed, 0);
    const salt = (ctx.salt ?? 0xF1E1) >>> 0;
    const legacyTrigger = ctx.triggerCount !== undefined ? Math.max(0, Math.floor(Number(ctx.triggerCount) || 0)) : 0;
    const globalIdx = Math.max(0, Math.floor(Number(ctx.globalIdx ?? 0)));
    const cycleIdx = Math.max(0, Math.floor(Number(ctx.cycleIdx ?? legacyTrigger)));
    const tokenSalt = hashSeed(salt, leaf.tokenIndex + 1, leaf.sliceIndex + 1);

    if (leaf.scope === 'global') {
        // When legacy callers only pass triggerCount (and no globalIdx), include legacyTrigger so rand advances when expected
        const effectiveGlobalIdx = ctx.globalIdx !== undefined ? globalIdx : legacyTrigger;
        return hashSeed(baseSeed, effectiveGlobalIdx, tokenSalt, 0x1001);
    }
    if (leaf.scope === 'cycle') {
        const combo = hashSeed(globalIdx, cycleIdx, 0x2002);
        return hashSeed(baseSeed, combo, tokenSalt, 0x2002);
    }
    // leaf.scope === 'event'
    const combo = hashSeed(globalIdx, cycleIdx, leaf.effectiveEventIdx + 1);
    return hashSeed(baseSeed, combo, tokenSalt, 0x3003);
}

/**
 * Formats an array of dropped pool/library items into a clean Field Operator expression:
 * - `'event'` (default, for SampleNode): `<item1, item2>` (round-robins per step trigger)
 * - `'cycle'` (for SequenceNode): `[item1][item2]` (subdivides Global Length across cycles)
 */
export function formatPoolListExpression(items: any[], mode: 'plain' | 'event' | 'cycle' | 'global' = 'plain'): string {
    if (!Array.isArray(items) || items.length === 0) return '';
    const formatted = items
        .map(item => {
            const fp = String(item?.filepath || item?.absolute_path || '').trim();
            const base = (fp ? fp.split(/[\\/]/).pop() : '') || String(item?.name || '').trim();
            if (!base) return '';
            return /[\s,[\]<>]/.test(base) ? `"${base.replace(/"/g, '')}"` : base;
        })
        .filter(Boolean);
    if (formatted.length === 0) return '';
    if (formatted.length === 1) return formatted[0];
    if (mode === 'cycle') {
        return formatted.map(tok => `[${tok}]`).join('');
    }
    if (mode === 'event') {
        return `<${formatted.join(', ')}>`;
    }
    if (mode === 'global') {
        return formatted.join(', ');
    }
    return formatted.join(' ');
}

/**
 * Evaluates a numeric Field Operator expression (unbracketed global, `[...]` cycle, `<...>` event,
 * `rand`/`random`, or range `min..max`) into a concrete number.
 */
export function evaluateNumericFieldOperator(
    expr: unknown,
    options: FieldEvalContext & {
        min?: number;
        max?: number;
        step?: number;
        isInteger?: boolean;
        fallback?: number;
    } = {}
): number {
    const fallback = Number.isFinite(Number(options.fallback)) ? Number(options.fallback) : 0;
    const leaf = resolveFieldOperatorLeaf(expr, options);
    if (!leaf) return fallback;

    const token = leaf.token;
    let rawVal: number;

    const rangeSpec = isRangeOperatorToken(token);
    if (rangeSpec) {
        const prng = mulberry32(computeLeafPrngSeed(leaf, options));
        rawVal = rangeSpec.min + prng() * (rangeSpec.max - rangeSpec.min);
    } else if (isRandomToken(token)) {
        const lo = Number.isFinite(Number(options.min)) ? Number(options.min) : -1;
        const hi = Number.isFinite(Number(options.max)) ? Number(options.max) : 1;
        const prng = mulberry32(computeLeafPrngSeed(leaf, options));
        if (options.isInteger) {
            const minInt = Math.ceil(Math.min(lo, hi));
            const maxInt = Math.floor(Math.max(lo, hi));
            const span = Math.max(1, maxInt - minInt + 1);
            rawVal = minInt + Math.floor(prng() * span);
        } else {
            rawVal = Math.min(lo, hi) + prng() * Math.abs(hi - lo);
        }
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
 */
export function evaluateSelectFieldOperator(
    expr: unknown,
    optionsList: Array<string | { value: any; label?: string }>,
    options: FieldEvalContext & {
        fallback?: any;
    } = {}
): any {
    if (!Array.isArray(optionsList) || optionsList.length === 0) return options.fallback;
    const normalized = optionsList.map(opt =>
        typeof opt === 'object' && opt !== null
            ? { value: String(opt.value), label: String(opt.label ?? opt.value) }
            : { value: String(opt), label: String(opt) }
    );
    const leaf = resolveFieldOperatorLeaf(expr, options);
    if (!leaf) return options.fallback ?? normalized[0].value;

    const token = leaf.token;
    const lower = token.toLowerCase();

    if (isRandomToken(token)) {
        const prng = mulberry32(computeLeafPrngSeed(leaf, { ...options, salt: options.salt ?? 0x5E1E }));
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
 * Resolves a seed expression across `numCycles` repetitions of a pattern.
 */
export function resolveCycleSeeds(
    seedExpr: unknown,
    numCycles: number,
    runtimeSalt: number = 0
): number[] {
    const count = Math.max(1, Math.floor(Number(numCycles) || 1));
    const tokens = tokenizeExpression(seedExpr, '0');
    const baseSalt = normalizeNumericSeed(runtimeSalt, 0);
    const result: number[] = [];

    for (let c = 0; c < count; c++) {
        const token = tokens[c % tokens.length];
        if (isRandomToken(token)) {
            result.push((hashSeed(baseSalt, c, 0xCAFE) % 9999) + 1);
        } else {
            result.push(normalizeNumericSeed(token, 0));
        }
    }
    return result;
}

/**
 * Resolves per-slot seeds when a Modifier (AssetFilter Pool or RandomNode)
 * populates `slotCount` slots on its owner node.
 */
export function resolveModifierSlotSeeds(
    seedExpr: unknown,
    slotCount: number,
    runtimeSalt: number = 0
): number[] {
    const count = Math.max(1, Math.floor(Number(slotCount) || 1));
    const tokens = tokenizeExpression(seedExpr, '0');
    const baseSalt = normalizeNumericSeed(runtimeSalt, 0);
    const result: number[] = [];

    if (tokens.length === 1 && !isRandomToken(tokens[0])) {
        const baseSeed = normalizeNumericSeed(tokens[0], 0);
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
            result.push(normalizeNumericSeed(token, 0));
        }
    }
    return result;
}

/**
 * Resolves a `sample_slot` expression across `stepCount` steps within a cycle,
 * supporting the full bracketed Field Operator grammar (`unbracketed` global, `[...]` cycle, `<...>` event).
 *
 * Notice:
 * - For legacy/simple callers that do not pass `options`, `0 1` or `<0 1>` or `[0 1]`
 *   evaluates across the steps of the cycle.
 * - When `options` provides `{ globalIdx, cycleIdx, numCycles, activeSequence, startEventIdx }`,
 *   `<...>` advances strictly on active steps (`activeSequence[i] == 1`),
 *   `[...]` subdivides `cycleProgress = i / stepCount`, and
 *   unbracketed expressions subdivide `globalProgress = (cycleIdx + cycleProgress) / numCycles`!
 */
export function resolveStepSlots(
    slotExpr: unknown,
    stepCount: number,
    upstreamSlotCount: number,
    cycleSeed: number = 0,
    upstreamActiveSlot: number = 0,
    options?: {
        globalIdx?: number;
        cycleIdx?: number;
        numCycles?: number;
        activeSequence?: number[];
        startEventIdx?: number;
    }
): number[] {
    const count = Math.max(1, Math.floor(Number(stepCount) || 16));
    const safeSlotCount = Math.max(1, Math.floor(Number(upstreamSlotCount) || 1));
    const safeActiveSlot = Math.max(0, Math.floor(Number(upstreamActiveSlot) || 0));
    const raw = String(slotExpr ?? '*').trim();
    if (!raw || isDefaultSlotToken(raw)) {
        return Array.from({ length: count }, () => wrapSlotIndex(safeActiveSlot, safeSlotCount));
    }

    const numericSeed = normalizeNumericSeed(cycleSeed, 0);
    const hasBrackets = /[\[\]<>]/.test(raw);
    const globalIdx = Math.max(0, Math.floor(Number(options?.globalIdx ?? 0)));
    const cycleIdx = Math.max(0, Math.floor(Number(options?.cycleIdx ?? 0)));
    const numCycles = Math.max(1, Math.floor(Number(options?.numCycles ?? 1)));
    const activeSeq = options?.activeSequence;

    // If no hierarchical options and no brackets are used, preserve direct per-step token indexing
    // when multiple unbracketed tokens are given (or when options is omitted).
    if (!options && !hasBrackets) {
        const tokens = tokenizeExpression(raw, '*');
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

    const result: number[] = [];
    let runningEventIdx = Math.max(0, Math.floor(Number(options?.startEventIdx ?? 0)));
    let runningWindowEventIdx = 0;
    let lastSliceKey = '';

    for (let i = 0; i < count; i++) {
        const isStepActive = activeSeq ? Boolean(activeSeq[i]) : true;
        const cycleProgress = i / count;
        const globalProgress = (cycleIdx + cycleProgress) / numCycles;

        // Probe AST slice to reset window-local event counter on slice transitions
        const probeLeaf = resolveFieldOperatorLeaf(raw, {
            seed: numericSeed,
            salt: 0x5107,
            globalIdx,
            globalProgress,
            cycleIdx,
            cycleProgress,
            eventIdx: runningEventIdx,
            windowEventIdx: runningWindowEventIdx,
        });

        const sliceKey = probeLeaf ? `${probeLeaf.scope}:${probeLeaf.sliceIndex}` : '';
        if (sliceKey !== lastSliceKey) {
            runningWindowEventIdx = 0;
            lastSliceKey = sliceKey;
        }

        const leaf = resolveFieldOperatorLeaf(raw, {
            seed: numericSeed,
            salt: 0x5107,
            globalIdx,
            globalProgress,
            cycleIdx,
            cycleProgress,
            eventIdx: runningEventIdx,
            windowEventIdx: runningWindowEventIdx,
        });

        let rawSlot = safeActiveSlot;
        if (leaf) {
            const tok = leaf.token;
            const rangeSpec = isRangeOperatorToken(tok);
            if (isDefaultSlotToken(tok)) {
                rawSlot = safeActiveSlot;
            } else if (rangeSpec) {
                const prng = mulberry32(computeLeafPrngSeed(leaf, {
                    seed: numericSeed,
                    salt: 0x5107,
                    globalIdx,
                    cycleIdx,
                }));
                const lo = Math.floor(rangeSpec.min);
                const hi = Math.floor(rangeSpec.max);
                rawSlot = lo + Math.floor(prng() * Math.max(1, hi - lo + 1));
            } else if (isRandomToken(tok)) {
                const prng = mulberry32(computeLeafPrngSeed(leaf, {
                    seed: numericSeed,
                    salt: 0x5107,
                    globalIdx,
                    cycleIdx,
                }));
                rawSlot = Math.floor(prng() * safeSlotCount);
            } else {
                const parsed = parseInt(tok, 10);
                rawSlot = Number.isFinite(parsed) ? parsed : safeActiveSlot;
            }
        }

        result.push(wrapSlotIndex(rawSlot, safeSlotCount));
        if (isStepActive) {
            runningEventIdx++;
            runningWindowEventIdx++;
        }
    }
    return result;
}

/**
 * Resolves a single section slot selector (e.g. "*", 0, 1, "rand", or bracketed expression)
 * against the connected upstream node's slot count and active slot index.
 */
export function resolveSectionSlot(
    slotValue: unknown,
    upstreamSlotCount: number,
    upstreamActiveSlot: number = 0,
    sectionSeed: unknown = 0,
    sectionIndex: number = 0
): number {
    const safeSlotCount = Math.max(1, Math.floor(Number(upstreamSlotCount) || 1));
    const safeActiveSlot = Math.max(0, Math.floor(Number(upstreamActiveSlot) || 0));
    if (slotValue == null || isDefaultSlotToken(slotValue) || String(slotValue).trim() === '') {
        return wrapSlotIndex(safeActiveSlot, safeSlotCount);
    }
    const token = String(slotValue).trim();
    if (isFieldOperatorExpression(token)) {
        const val = evaluateNumericFieldOperator(token, {
            seed: sectionSeed,
            salt: 0x5107,
            globalIdx: 0,
            cycleIdx: sectionIndex,
            eventIdx: sectionIndex,
            triggerCount: sectionIndex,
            min: 0,
            max: Math.max(0, safeSlotCount - 1),
            step: 1,
            isInteger: true,
            fallback: safeActiveSlot,
        });
        return wrapSlotIndex(val, safeSlotCount);
    }
    if (isRandomToken(token)) {
        const numericSeed = normalizeNumericSeed(sectionSeed, 0);
        const prng = mulberry32(hashSeed(numericSeed, sectionIndex, 0x5107));
        return wrapSlotIndex(Math.floor(prng() * safeSlotCount), safeSlotCount);
    }
    const parsed = Number(token);
    const rawSlot = Number.isFinite(parsed) ? Math.floor(parsed) : safeActiveSlot;
    return wrapSlotIndex(rawSlot, safeSlotCount);
}

/**
 * Re-rolls all numeric tokens in a seed expression while preserving "rand" / "random" tokens.
 */
export function rollSeedExpression(seedExpr: unknown, randomFn: () => number = Math.random): string {
    const tokens = tokenizeExpression(seedExpr, '0');
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

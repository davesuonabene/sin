/**
 * ERMES Deterministic Slot, Pool & Bracketed Field Operator Engine (TypeScript)
 *
 * Provides cross-language bit-identical PRNG (SplitMix32 + Mulberry32)
 * matching `ermes/py/slot_language.py` and evaluates hierarchical Field Operators
 * driven strictly by the 2 runtime triggers: **Cycle** (Wrapper & Local) and **Event**:
 *
 * - Top-level (unbracketed): Wrapper Cycle Scope (spans or subdivides the Parent Master's Wrapper Cycle `W`)
 *   - `random` -> 1 random value per Wrapper Cycle
 *   - `0 1` or `random random` -> subdivides Wrapper Cycle `W` into equal slices
 * - `[ ... ]`: Local Cycle Scope (refreshes every Node Cycle `cycleIdx` and subdivides Local Cycle Length `C`)
 *   - `[random]` -> 1 random value per Local Cycle
 *   - `[0 1]` or `[0 random]` -> subdivides Local Cycle Length `C` into equal slices
 *   - `[random][random]` -> 2 top-level Wrapper Cycle halves, each refreshing every Local Cycle
 * - `< ... >`: Sequential Event Scope (advances 1 item per active Event Request `eventIdx`)
 *   - `<0 1 2>` -> sequential round-robin across active events
 *   - `<random>` -> new random value on every active event
 *   - `<0 random>` -> alternates fixed `0` and fresh `random` on sequential events
 *   - `[0 <random>]` -> first half of local cycle is `0`, second half rolls `random` on every event
 */

export interface NodeSlot {
    slot?: number;
    index?: number;
    label?: string;
    pool_query?: string;
    sequence_name?: string;
    filepath?: string;
    library_item_id?: number | string | null;
    is_external?: boolean;
    is_inline?: boolean;
    source?: 'gaia' | 'external' | 'inline';
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
    /** Parent/Wrapper cycle trigger index (0, 1, 2, ...) */
    wrapperIdx?: number;
    /** Normalized progress within the Parent/Wrapper Cycle [0.0, 1.0) */
    wrapperProgress?: number;
    /** Legacy alias for wrapperIdx */
    globalIdx?: number;
    /** Legacy alias for wrapperProgress */
    globalProgress?: number;
    /** Local cycle trigger index (0, 1, 2, ...) */
    cycleIdx?: number;
    /** Normalized progress within the current Local Cycle [0.0, 1.0) */
    cycleProgress?: number;
    /** Continuous sequential event index (0, 1, 2, ...) */
    eventIdx?: number;
    /** Window-local sequential event index when inside a subdivided slice (defaults to eventIdx) */
    windowEventIdx?: number;
    /** Legacy / simple sequential fallback (maps to cycleIdx and eventIdx when omitted) */
    triggerCount?: number;
}

export type FieldScope = 'wrapper' | 'cycle' | 'event' | 'global';

export type FieldAstNode =
    | { kind: 'wrapper_group'; items: FieldAstNode[] }
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

export function isPoolIndexToken(expr: unknown): boolean {
    const raw = String(expr ?? '').trim();
    return /^-?\d+$/.test(raw);
}

export function isExternalPoolItem(item: any): boolean {
    if (!item || typeof item !== 'object') return false;
    return Boolean(
        item.is_external
        || item.source === 'external'
        || String(item.id ?? '').startsWith('ext:')
    );
}

export function isInlinePoolItem(item: any): boolean {
    if (!item || typeof item !== 'object') return false;
    const fp = String(item.absolute_path || item.filepath || '').trim();
    return Boolean(
        item.is_inline
        || item.source === 'inline'
        || String(item.id ?? '').startsWith('inline:')
        || (Array.isArray(item.sequence) && !fp)
    );
}

export function getPoolItemIdentityKey(item: any): string {
    if (!item || typeof item !== 'object') return '';
    if (isInlinePoolItem(item)) {
        const inlineId = String(item.id ?? '').trim();
        if (inlineId) return `inline:${inlineId.toLowerCase()}`;
        const inlineName = String(item.name || item.sequence_name || '').trim().toLowerCase();
        return inlineName ? `inline-name:${inlineName}` : '';
    }
    const fp = String(item.absolute_path || item.filepath || '').trim();
    if (fp) {
        return fp.replace(/\\/g, '/').toLowerCase();
    }
    const idStr = item.id != null ? String(item.id).trim() : '';
    return idStr ? `id:${idStr.toLowerCase()}` : '';
}

export function getPoolItemCallName(item: any, isSequence: boolean = false): string {
    const rawName = String(item?.name || item?.sequence_name || '').trim();
    const fp = String(item?.filepath || item?.absolute_path || '').trim();
    const fpBase = fp ? (fp.split(/[\\/]/).pop() || '') : '';
    let candidate = rawName || fpBase || (isSequence ? 'Sequence' : 'Sample');
    if (isSequence) {
        candidate = candidate.replace(/\.(?:seq|mid|midi)$/i, '').trim() || candidate;
    }
    return candidate;
}

export function deduplicatePoolItemName(
    baseName: string,
    existingItems: any[],
    excludeKey?: string
): string {
    const clean = String(baseName || '').trim() || 'Asset';
    const used = new Set<string>();
    for (const item of existingItems || []) {
        if (!item || typeof item !== 'object') continue;
        if (excludeKey && getPoolItemIdentityKey(item) === excludeKey) continue;
        const existingName = String(item.name || '').trim().toLowerCase();
        if (existingName) used.add(existingName);
    }
    if (!used.has(clean.toLowerCase())) return clean;

    const extMatch = clean.match(/^(.*?)(\.[a-z0-9]{2,5})$/i);
    const stem = extMatch ? extMatch[1] : clean;
    const ext = extMatch ? extMatch[2] : '';
    for (let n = 2; n < 1000; n++) {
        const next = `${stem} (${n})${ext}`;
        if (!used.has(next.toLowerCase())) return next;
    }
    return `${stem} (${Date.now()})${ext}`;
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

const AST_CACHE_MAX = 256;
const _astCache = new Map<string, Extract<FieldAstNode, { kind: 'wrapper_group' }>>();

/**
 * Parses a Field Operator string into a hierarchical AST:
 * - Outer `wrapper_group` subdivides the Parent Master's Wrapper Cycle (`W`)
 * - `[ ... ]` `cycle_group` refreshes each Local Cycle Trigger and subdivides the Local Cycle Length (`C`)
 * - `< ... >` `event_group` advances sequentially on each active Event Request
 */
export function parseFieldOperatorAST(expr: unknown): Extract<FieldAstNode, { kind: 'wrapper_group' }> {
    if (typeof expr === 'object' && expr !== null && 'kind' in expr) {
        const node = expr as FieldAstNode;
        if (node.kind === 'wrapper_group') return node;
        if (node.kind === 'global_group') return { kind: 'wrapper_group', items: node.items };
        return { kind: 'wrapper_group', items: [node] };
    }
    const cacheKey = String(expr ?? '').trim();
    const cached = _astCache.get(cacheKey);
    if (cached) return cached;

    const lexemes = lexFieldOperator(cacheKey);
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

    const ast: Extract<FieldAstNode, { kind: 'wrapper_group' }> = {
        kind: 'wrapper_group',
        items: parseItems(undefined)
    };
    if (_astCache.size >= AST_CACHE_MAX) {
        const oldestKey = _astCache.keys().next().value;
        if (oldestKey !== undefined) _astCache.delete(oldestKey);
    }
    _astCache.set(cacheKey, ast);
    return ast;
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

    const unwrapped = (
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 && !raw.slice(1, -1).includes('"'))
        || (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2 && !raw.slice(1, -1).includes("'"))
    ) ? raw.slice(1, -1).trim() : null;
    if (unwrapped !== null) {
        return isRandomToken(unwrapped) || isRangeOperatorToken(unwrapped) !== null;
    }

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
 * Returns `true` when `expr` is a calculated pool lookup (either a Field Operator like `rand`, `[0 1]`,
 * `<a b>`, or an integer pool index like `0`, `1` that depends on the current run's `global_seed` order).
 * Direct single-item string name calls (e.g. `Kick_01.wav`, `Breakbeat (edit)`) return `false`.
 */
export function isCalculatedPoolQuery(expr: unknown, poolItems?: any[]): boolean {
    const raw = String(expr ?? '').trim();
    if (!raw) return false;
    if (isPoolIndexToken(raw)) return true;
    return isFieldOperatorExpression(raw, poolItems);
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

    const rawWrapperProg = ctx.wrapperProgress ?? ctx.globalProgress;
    const hasExplicitWrapperProgress = rawWrapperProg !== undefined && Number.isFinite(Number(rawWrapperProg));
    const hasExplicitCycleProgress = ctx.cycleProgress !== undefined && Number.isFinite(Number(ctx.cycleProgress));

    const wrapperProgress = hasExplicitWrapperProgress
        ? Math.max(0, Math.min(0.999999, Number(rawWrapperProg)))
        : 0;
    const cycleProgress = hasExplicitCycleProgress
        ? Math.max(0, Math.min(0.999999, Number(ctx.cycleProgress)))
        : 0;

    const evalNode = (
        node: FieldAstNode,
        currentScope: FieldScope,
        wProg: number,
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

        if (node.kind === 'wrapper_group' || node.kind === 'global_group') {
            if (count === 1) {
                return evalNode(items[0], 'wrapper', wProg, cProg, 0, inSubdividedWindow);
            }
            let sliceIdx: number;
            let localWProg: number;
            if (hasExplicitWrapperProgress) {
                const scaled = wProg * count;
                sliceIdx = Math.min(count - 1, Math.max(0, Math.floor(scaled)));
                localWProg = scaled - sliceIdx;
            } else {
                // Fallback when evaluated without timeline progress (e.g. direct triggerCount step)
                const fallbackIdx = legacyTrigger ?? cycleIdx;
                sliceIdx = wrapSlotIndex(fallbackIdx, count);
                localWProg = 0;
            }
            return evalNode(items[sliceIdx], 'wrapper', localWProg, cProg, sliceIdx, true);
        }

        if (node.kind === 'cycle_group') {
            if (count === 1) {
                return evalNode(items[0], 'cycle', wProg, cProg, activeSliceIdx, inSubdividedWindow);
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
            return evalNode(items[sliceIdx], 'cycle', wProg, localCProg, sliceIdx, true);
        }

        // node.kind === 'event_group' (`< ... >`)
        const effEvt = inSubdividedWindow ? windowEventIdx : eventIdx;
        const chosenIdx = wrapSlotIndex(effEvt, count);
        return evalNode(items[chosenIdx], 'event', wProg, cProg, chosenIdx, inSubdividedWindow);
    };

    return evalNode(ast, 'wrapper', wrapperProgress, cycleProgress, 0, false);
}

/**
 * Computes the deterministic 32-bit PRNG seed for a resolved AST leaf based on its bracket scope:
 * - `'wrapper'` (`'global'`): depends on `(seed, wrapperIdx, tokenIndex, salt)` (1 value per Wrapper Cycle slice)
 * - `'cycle'`: depends on `(seed, wrapperIdx, cycleIdx, tokenIndex, salt)` (1 value per Local Cycle slice)
 * - `'event'`: depends on `(seed, wrapperIdx, cycleIdx, effectiveEventIdx, tokenIndex, salt)` (1 value per Event)
 */
export function computeLeafPrngSeed(leaf: ResolvedFieldLeaf, ctx: FieldEvalContext = {}): number {
    const baseSeed = normalizeNumericSeed(ctx.seed, 0);
    const salt = (ctx.salt ?? 0xF1E1) >>> 0;
    const legacyTrigger = ctx.triggerCount !== undefined ? Math.max(0, Math.floor(Number(ctx.triggerCount) || 0)) : 0;
    const rawWrapperIdx = ctx.wrapperIdx ?? ctx.globalIdx;
    const wrapperIdx = Math.max(0, Math.floor(Number(rawWrapperIdx ?? 0)));
    const cycleIdx = Math.max(0, Math.floor(Number(ctx.cycleIdx ?? legacyTrigger)));
    const tokenSalt = hashSeed(salt, leaf.tokenIndex + 1, leaf.sliceIndex + 1);

    if (leaf.scope === 'wrapper' || leaf.scope === 'global') {
        // When legacy callers only pass triggerCount (and no wrapperIdx), include legacyTrigger so rand advances when expected
        const effectiveWrapperIdx = rawWrapperIdx !== undefined ? wrapperIdx : legacyTrigger;
        return hashSeed(baseSeed, effectiveWrapperIdx, tokenSalt, 0x1001);
    }
    if (leaf.scope === 'cycle') {
        const combo = hashSeed(wrapperIdx, cycleIdx, 0x2002);
        return hashSeed(baseSeed, combo, tokenSalt, 0x2002);
    }
    // leaf.scope === 'event'
    const combo = hashSeed(wrapperIdx, cycleIdx, leaf.effectiveEventIdx + 1);
    return hashSeed(baseSeed, combo, tokenSalt, 0x3003);
}

/**
 * Formats an array of dropped pool/library items into a clean Field Operator expression:
 * - `'event'` (default, for SampleNode): `<item1, item2>` (round-robins per step trigger)
 * - `'cycle'` (for SequenceNode): `[item1][item2]` (subdivides Wrapper Cycle across child cycles)
 */
export function formatPoolListExpression(
    items: any[],
    mode: 'plain' | 'event' | 'cycle' | 'wrapper' | 'global' = 'plain',
    isSequence: boolean = false
): string {
    if (!Array.isArray(items) || items.length === 0) return '';
    const rawNames = items
        .map(item => getPoolItemCallName(item, isSequence))
        .filter(Boolean);
    if (rawNames.length === 0) return '';
    if (rawNames.length === 1) return rawNames[0];
    const formatted = rawNames.map(base =>
        /[\s,[\]<>]/.test(base) ? `"${base.replace(/"/g, '')}"` : base
    );
    if (mode === 'cycle') {
        return formatted.map(tok => `[${tok}]`).join('');
    }
    if (mode === 'event') {
        return `<${formatted.join(', ')}>`;
    }
    if (mode === 'wrapper' || mode === 'global') {
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
 * supporting the full bracketed Field Operator grammar (`unbracketed` wrapper cycle, `[...]` local cycle, `<...>` event).
 *
 * Notice:
 * - For legacy/simple callers that do not pass `options`, `0 1` or `<0 1>` or `[0 1]`
 *   evaluates across the steps of the cycle.
 * - When `options` provides `{ wrapperIdx, cycleIdx, numCycles, activeSequence, startEventIdx }`,
 *   `<...>` advances strictly on active steps (`activeSequence[i] == 1`),
 *   `[...]` subdivides `cycleProgress = i / stepCount`, and
 *   unbracketed expressions subdivide `wrapperProgress = (cycleIdx + cycleProgress) / numCycles`!
 */
export function resolveStepSlots(
    slotExpr: unknown,
    stepCount: number,
    upstreamSlotCount: number,
    cycleSeed: number = 0,
    upstreamActiveSlot: number = 0,
    options?: {
        wrapperIdx?: number;
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
    const wrapperIdx = Math.max(0, Math.floor(Number(options?.wrapperIdx ?? options?.globalIdx ?? 0)));
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

    const ast = parseFieldOperatorAST(raw);
    const result: number[] = [];
    let runningEventIdx = Math.max(0, Math.floor(Number(options?.startEventIdx ?? 0)));
    let runningWindowEventIdx = 0;
    let lastSliceKey = '';

    const localCycleInWrapper = cycleIdx % numCycles;
    for (let i = 0; i < count; i++) {
        const isStepActive = activeSeq ? Boolean(activeSeq[i]) : true;
        const cycleProgress = i / count;
        const wrapperProgress = (localCycleInWrapper + cycleProgress) / numCycles;

        let leaf = resolveFieldOperatorLeaf(ast, {
            seed: numericSeed,
            salt: 0x5107,
            wrapperIdx,
            wrapperProgress,
            cycleIdx,
            cycleProgress,
            eventIdx: runningEventIdx,
            windowEventIdx: runningWindowEventIdx,
        });

        const sliceKey = leaf ? `${leaf.scope}:${leaf.sliceIndex}` : '';
        if (sliceKey !== lastSliceKey) {
            lastSliceKey = sliceKey;
            if (runningWindowEventIdx !== 0) {
                runningWindowEventIdx = 0;
                leaf = resolveFieldOperatorLeaf(ast, {
                    seed: numericSeed,
                    salt: 0x5107,
                    wrapperIdx,
                    wrapperProgress,
                    cycleIdx,
                    cycleProgress,
                    eventIdx: runningEventIdx,
                    windowEventIdx: 0,
                });
            }
        }

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
                    wrapperIdx,
                    cycleIdx,
                }));
                const lo = Math.floor(rangeSpec.min);
                const hi = Math.floor(rangeSpec.max);
                rawSlot = lo + Math.floor(prng() * Math.max(1, hi - lo + 1));
            } else if (isRandomToken(tok)) {
                const prng = mulberry32(computeLeafPrngSeed(leaf, {
                    seed: numericSeed,
                    salt: 0x5107,
                    wrapperIdx,
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
    if (isRandomToken(token)) {
        const numericSeed = normalizeNumericSeed(sectionSeed, 0);
        const prng = mulberry32(hashSeed(numericSeed, sectionIndex, 0x5107));
        return wrapSlotIndex(Math.floor(prng() * safeSlotCount), safeSlotCount);
    }
    if (isFieldOperatorExpression(token)) {
        const val = evaluateNumericFieldOperator(token, {
            seed: sectionSeed,
            salt: 0x5107 + sectionIndex,
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

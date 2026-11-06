"""
ERMES Deterministic Slot, Pool & Bracketed Field Operator Engine (Python)

Provides cross-language bit-identical PRNG (SplitMix32 + Mulberry32)
matching `ermes/ts/slotLanguage.ts` and evaluates hierarchical Field Operators:
- Top-level (unbracketed): Global Scope (spans or subdivides Ancestor Master Global Length `G`)
- `[ ... ]`: Cycle Scope (refreshes every Cycle Trigger `cycle_idx` and subdivides Cycle Length `C`)
- `< ... >`: Sequential Event Scope (advances 1 item per active Event Request `event_idx`)
"""

import math
import random as _py_random
import re
from typing import Any, Callable, Dict, List, Optional, Tuple


def _imul32(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def hash_seed(base_seed: int, index: int = 0, salt: int = 0, extra_salt: int = 0) -> int:
    """32-bit SplitMix32 avalanching hash (bit-identical to TypeScript `hashSeed`)."""
    h = (
        (int(base_seed) & 0xFFFFFFFF)
        ^ _imul32(int(index) & 0xFFFFFFFF, 0x9E3779B9)
        ^ _imul32(int(salt) & 0xFFFFFFFF, 0x85EBCA6B)
        ^ _imul32(int(extra_salt) & 0xFFFFFFFF, 0xC2B2AE35)
    ) & 0xFFFFFFFF
    h = _imul32(h ^ (h >> 16), 0x7FEB352D)
    h = _imul32(h ^ (h >> 15), 0x846CA68B)
    return (h ^ (h >> 16)) & 0xFFFFFFFF


def mulberry32(seed: int) -> Callable[[], float]:
    """Fast, deterministic 32-bit PRNG returning floats in [0, 1) (bit-identical to TypeScript `mulberry32`)."""
    state = (int(seed) & 0xFFFFFFFF) or 1

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = _imul32(state ^ (state >> 15), 1 | state)
        t = ((t + _imul32(t ^ (t >> 7), 61 | t)) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return next_float


def normalize_numeric_seed(val: Any, fallback: int = 0) -> int:
    """Convert any string or numeric seed value into a stable 32-bit unsigned integer."""
    if isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val):
        fval = float(val)
        if 0.0 < fval < 1.0:
            return int(math.floor(fval * 10000.0))
        return int(math.floor(fval + 0.5)) & 0xFFFFFFFF

    s = str(val if val is not None else "").strip()
    if not s:
        return int(fallback) & 0xFFFFFFFF

    try:
        parsed = float(s)
        if math.isfinite(parsed):
            if 0.0 < parsed < 1.0:
                return int(math.floor(parsed * 10000.0))
            return int(math.floor(parsed + 0.5)) & 0xFFFFFFFF
    except (ValueError, TypeError):
        pass

    # FNV-1a string hash for non-numeric tokens
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = _imul32(h, 0x01000193)
    return h & 0xFFFFFFFF


def wrap_slot_index(slot_index: Any, upstream_slot_count: Any) -> int:
    """Modulo-wraps a requested slot index around the available upstream slot count N >= 1."""
    try:
        safe_count = max(1, int(math.floor(float(upstream_slot_count or 1))))
    except (ValueError, TypeError):
        safe_count = 1
    try:
        idx = int(math.floor(float(slot_index or 0)))
    except (ValueError, TypeError):
        idx = 0
    return ((idx % safe_count) + safe_count) % safe_count


def get_pool_permutation_order(length: int, pool_seed: Any, node_id: int = 0) -> List[int]:
    """
    Computes a deterministic Fisher-Yates permutation of `[0, 1, ..., length - 1]`
    driven by `pool_seed` and `node_id` (bit-identical to TypeScript `getPoolPermutationOrder`).
    - When `pool_seed <= 0` (`global_seed == 0`), returns the identity order `[0, 1, ..., length - 1]`.
    - When `pool_seed > 0`, returns a deterministically shuffled index mapping.
    """
    n = max(0, int(length or 0))
    indices = list(range(n))
    seed_int = normalize_numeric_seed(pool_seed, 0)
    if seed_int <= 0 or n <= 1:
        return indices
    prng = mulberry32(hash_seed(seed_int, int(node_id or 0), 0x7001))
    for i in range(n - 1, 0, -1):
        j = int(math.floor(prng() * (i + 1)))
        indices[i], indices[j] = indices[j], indices[i]
    return indices


def permute_pool_items(items: List[Any], pool_seed: Any, node_id: int = 0) -> List[Any]:
    """Returns a copy of `items` reordered deterministically by `pool_seed` (keeping `pool_seed == 0` as user order)."""
    if not isinstance(items, list) or len(items) <= 1:
        return list(items) if isinstance(items, list) else []
    order = get_pool_permutation_order(len(items), pool_seed, node_id)
    return [items[idx] for idx in order]


def is_random_token(token: Any) -> bool:
    t = str(token if token is not None else "").strip().lower()
    return t in ("rand", "random")


def is_default_slot_token(token: Any) -> bool:
    t = str(token if token is not None else "").strip().lower()
    return t in ("*", "default", "active")


def is_range_operator_token(token: Any) -> Optional[Tuple[float, float]]:
    """Parses a range operator token such as '-12..12', '0.1..0.9', or 'rand(-5, 5)'."""
    raw = str(token if token is not None else "").strip()
    if not raw:
        return None

    func_match = re.match(
        r"^(?:rand|random)\s*\(\s*(-?\d+(?:\.\d+)?)\s*[,;:]\s*(-?\d+(?:\.\d+)?)\s*\)$",
        raw,
        re.IGNORECASE,
    )
    if func_match:
        try:
            a = float(func_match.group(1))
            b = float(func_match.group(2))
            if math.isfinite(a) and math.isfinite(b):
                return (min(a, b), max(a, b))
        except (ValueError, TypeError):
            pass

    dot_match = re.match(r"^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$", raw)
    if dot_match:
        try:
            a = float(dot_match.group(1))
            b = float(dot_match.group(2))
            if math.isfinite(a) and math.isfinite(b):
                return (min(a, b), max(a, b))
        except (ValueError, TypeError):
            pass

    return None


_SINGLE_ASSET_FILENAME_RE = re.compile(
    r"^[^,\[\]<>]+\.(?:wav|mp3|ogg|flac|aif|aiff|m4a|mid|midi|seq)$",
    re.IGNORECASE,
)
_EXT_COUNT_RE = re.compile(
    r"\.(?:wav|mp3|ogg|flac|aif|aiff|m4a|mid|midi|seq)\b",
    re.IGNORECASE,
)


def is_single_asset_filename_literal(raw: str) -> bool:
    trimmed = raw.strip()
    if not trimmed or re.search(r"[,\[\]<>]", trimmed):
        return False
    if not _SINGLE_ASSET_FILENAME_RE.match(trimmed):
        return False
    return len(_EXT_COUNT_RE.findall(trimmed)) == 1


def lex_field_operator(expr: Any) -> List[str]:
    """
    Lexical scanner for Field Operator strings.
    Treats whitespace, commas (`,`), and bracket boundaries (`[`, `]`, `<`, `>`) as element dividers,
    while preserving quoted strings and `rand(a, b)` function calls as atomic tokens.
    """
    raw = str(expr if expr is not None else "").strip()
    if not raw:
        return []
    if is_single_asset_filename_literal(raw):
        return [raw]

    pattern = re.compile(
        r'"([^"]+)"|\'([^\']+)\'|((?:rand|random)\s*\([^)]+\))|(\[|\]|<|>)|[^\s,\[\]<>]+',
        re.IGNORECASE,
    )
    tokens: List[str] = []
    for match in pattern.finditer(raw):
        if match.group(1) is not None:
            q = match.group(1).strip()
            if q:
                tokens.append(q)
        elif match.group(2) is not None:
            q = match.group(2).strip()
            if q:
                tokens.append(q)
        elif match.group(3) is not None:
            tokens.append(match.group(3).strip())
        elif match.group(4) is not None:
            tokens.append(match.group(4))
        else:
            atom = (match.group(0) or "").strip()
            if atom:
                tokens.append(atom)
    return tokens


def tokenize_field_operator(expr: Any) -> List[str]:
    """Flat tokenizer returning leaf tokens (stripping structural brackets) for legacy callers."""
    return [tok for tok in lex_field_operator(expr) if tok not in ("[", "]", "<", ">")]


_AST_CACHE_MAX = 256
_ast_cache: Dict[str, Dict[str, Any]] = {}


def parse_field_operator_ast(expr: Any) -> Dict[str, Any]:
    """
    Parses a Field Operator string into a hierarchical AST:
    - Outer `global_group` subdivides the Ancestor Global Length (`G`)
    - `[ ... ]` `cycle_group` refreshes each Cycle Trigger and subdivides the Cycle Length (`C`)
    - `< ... >` `event_group` advances sequentially on each active Event Request
    """
    if isinstance(expr, dict) and "kind" in expr:
        if expr["kind"] == "global_group":
            return expr
        return {"kind": "global_group", "items": [expr]}

    cache_key = str(expr if expr is not None else "").strip()
    cached = _ast_cache.get(cache_key)
    if cached is not None:
        return cached

    lexemes = lex_field_operator(cache_key)
    pos = 0
    next_token_index = 0
    next_group_index = 0

    def parse_items(closing_bracket: Optional[str] = None) -> List[Dict[str, Any]]:
        nonlocal pos, next_token_index, next_group_index
        items: List[Dict[str, Any]] = []
        while pos < len(lexemes):
            tok = lexemes[pos]
            if closing_bracket and tok == closing_bracket:
                pos += 1
                break
            if tok in ("]", ">"):
                pos += 1
                continue
            if tok == "[":
                pos += 1
                g_idx = next_group_index
                next_group_index += 1
                children = parse_items("]")
                if children:
                    items.append({"kind": "cycle_group", "items": children, "groupIndex": g_idx})
            elif tok == "<":
                pos += 1
                g_idx = next_group_index
                next_group_index += 1
                children = parse_items(">")
                if children:
                    items.append({"kind": "event_group", "items": children, "groupIndex": g_idx})
            else:
                pos += 1
                t_idx = next_token_index
                next_token_index += 1
                items.append({"kind": "atom", "value": tok, "tokenIndex": t_idx})
        return items

    ast = {"kind": "global_group", "items": parse_items(None)}
    if len(_ast_cache) >= _AST_CACHE_MAX:
        oldest_key = next(iter(_ast_cache))
        _ast_cache.pop(oldest_key, None)
    _ast_cache[cache_key] = ast
    return ast


def is_field_operator_expression(expr: Any, pool_items: Optional[List[Any]] = None) -> bool:
    """Returns True if `expr` is an active Field Operator (brackets, rand, range, or multi-token list)."""
    raw = str(expr if expr is not None else "").strip()
    if not raw:
        return False

    if (
        isinstance(pool_items, list)
        and pool_items
        and not re.search(r"[,\[\]<>]", raw)
        and not is_random_token(raw)
        and is_range_operator_token(raw) is None
    ):
        lower = raw.lower()
        for item in pool_items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip().lower()
            name_stem = re.sub(r"\.[^.]+$", "", name)
            fp = str(item.get("filepath") or item.get("absolute_path") or "").strip()
            base = re.split(r"[\\/]", fp)[-1].lower() if fp else ""
            base_stem = re.sub(r"\.[^.]+$", "", base)
            if lower in (name, name_stem, base, base_stem):
                return False

    if re.search(r"[\[\]<>]", raw):
        return len(tokenize_field_operator(raw)) > 0

    tokens = tokenize_field_operator(raw)
    if not tokens:
        return False
    if len(tokens) > 1:
        return True
    single = tokens[0]
    return is_random_token(single) or (is_range_operator_token(single) is not None)


def resolve_field_operator_leaf(
    expr: Any,
    trigger_count: Optional[int] = None,
    global_idx: Optional[int] = None,
    global_progress: Optional[float] = None,
    cycle_idx: Optional[int] = None,
    cycle_progress: Optional[float] = None,
    event_idx: Optional[int] = None,
    window_event_idx: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Evaluates a parsed Field Operator AST at the given hierarchical trigger context,
    returning the selected leaf token and its deterministic evaluation scope.
    """
    ast = parse_field_operator_ast(expr)
    if not ast["items"]:
        return None

    legacy_trigger = max(0, int(trigger_count or 0)) if trigger_count is not None else None
    eff_cycle_idx = max(0, int(cycle_idx if cycle_idx is not None else (legacy_trigger if legacy_trigger is not None else 0)))
    eff_event_idx = max(0, int(event_idx if event_idx is not None else (legacy_trigger if legacy_trigger is not None else 0)))
    eff_window_event_idx = max(0, int(window_event_idx if window_event_idx is not None else eff_event_idx))

    has_explicit_g_prog = global_progress is not None and math.isfinite(float(global_progress))
    has_explicit_c_prog = cycle_progress is not None and math.isfinite(float(cycle_progress))

    g_prog_init = max(0.0, min(0.999999, float(global_progress))) if has_explicit_g_prog else 0.0
    c_prog_init = max(0.0, min(0.999999, float(cycle_progress))) if has_explicit_c_prog else 0.0

    def eval_node(
        node: Dict[str, Any],
        current_scope: str,
        g_prog: float,
        c_prog: float,
        active_slice_idx: int,
        in_subdivided_window: bool,
    ) -> Optional[Dict[str, Any]]:
        kind = node["kind"]
        if kind == "atom":
            return {
                "token": node["value"],
                "tokenIndex": node["tokenIndex"],
                "scope": current_scope,
                "sliceIndex": active_slice_idx,
                "isSubdividedWindow": in_subdivided_window,
                "effectiveEventIdx": eff_window_event_idx if in_subdivided_window else eff_event_idx,
            }

        items = node["items"]
        count = len(items)
        if count == 0:
            return None

        if kind == "global_group":
            if count == 1:
                return eval_node(items[0], "global", g_prog, c_prog, 0, in_subdivided_window)
            if has_explicit_g_prog:
                scaled = g_prog * count
                slice_idx = min(count - 1, max(0, int(math.floor(scaled))))
                local_g_prog = scaled - slice_idx
            else:
                fb_idx = legacy_trigger if legacy_trigger is not None else eff_cycle_idx
                slice_idx = wrap_slot_index(fb_idx, count)
                local_g_prog = 0.0
            return eval_node(items[slice_idx], "global", local_g_prog, c_prog, slice_idx, True)

        if kind == "cycle_group":
            if count == 1:
                return eval_node(items[0], "cycle", g_prog, c_prog, active_slice_idx, in_subdivided_window)
            if has_explicit_c_prog:
                scaled = c_prog * count
                slice_idx = min(count - 1, max(0, int(math.floor(scaled))))
                local_c_prog = scaled - slice_idx
            else:
                fb_idx = legacy_trigger if legacy_trigger is not None else eff_event_idx
                slice_idx = wrap_slot_index(fb_idx, count)
                local_c_prog = 0.0
            return eval_node(items[slice_idx], "cycle", g_prog, local_c_prog, slice_idx, True)

        # kind == "event_group" (`< ... >`)
        eff_evt = eff_window_event_idx if in_subdivided_window else eff_event_idx
        chosen_idx = wrap_slot_index(eff_evt, count)
        return eval_node(items[chosen_idx], "event", g_prog, c_prog, chosen_idx, in_subdivided_window)

    return eval_node(ast, "global", g_prog_init, c_prog_init, 0, False)


def compute_leaf_prng_seed(
    leaf: Dict[str, Any],
    seed: Any = 0,
    salt: int = 0xF1E1,
    trigger_count: Optional[int] = None,
    global_idx: Optional[int] = None,
    cycle_idx: Optional[int] = None,
) -> int:
    """Computes the deterministic 32-bit PRNG seed for a resolved AST leaf (bit-identical to TypeScript)."""
    base_seed = normalize_numeric_seed(seed, 0)
    eff_salt = int(salt if salt is not None else 0xF1E1) & 0xFFFFFFFF
    legacy_trigger = max(0, int(trigger_count or 0)) if trigger_count is not None else 0
    eff_global_idx = max(0, int(global_idx or 0))
    eff_cycle_idx = max(0, int(cycle_idx if cycle_idx is not None else legacy_trigger))
    token_salt = hash_seed(eff_salt, int(leaf["tokenIndex"]) + 1, int(leaf["sliceIndex"]) + 1)

    scope = leaf["scope"]
    if scope == "global":
        effective_g = eff_global_idx if global_idx is not None else legacy_trigger
        return hash_seed(base_seed, effective_g, token_salt, 0x1001)
    if scope == "cycle":
        combo = hash_seed(eff_global_idx, eff_cycle_idx, 0x2002)
        return hash_seed(base_seed, combo, token_salt, 0x2002)
    combo = hash_seed(eff_global_idx, eff_cycle_idx, int(leaf["effectiveEventIdx"]) + 1)
    return hash_seed(base_seed, combo, token_salt, 0x3003)


def evaluate_numeric_field_operator(
    expr: Any,
    trigger_count: Optional[int] = None,
    seed: Any = 0,
    salt: int = 0xF1E1,
    min_val: Optional[float] = None,
    max_val: Optional[float] = None,
    step: Optional[float] = None,
    is_integer: bool = False,
    fallback: float = 0.0,
    global_idx: Optional[int] = None,
    global_progress: Optional[float] = None,
    cycle_idx: Optional[int] = None,
    cycle_progress: Optional[float] = None,
    event_idx: Optional[int] = None,
    window_event_idx: Optional[int] = None,
) -> float:
    """Evaluates a numeric Field Operator expression across unbracketed global, `[]` cycle, and `<>` event scopes."""
    leaf = resolve_field_operator_leaf(
        expr,
        trigger_count=trigger_count,
        global_idx=global_idx,
        global_progress=global_progress,
        cycle_idx=cycle_idx,
        cycle_progress=cycle_progress,
        event_idx=event_idx,
        window_event_idx=window_event_idx,
    )
    if not leaf:
        return float(fallback)

    token = leaf["token"]
    range_spec = is_range_operator_token(token)
    if range_spec is not None:
        r_min, r_max = range_spec
        prng = mulberry32(
            compute_leaf_prng_seed(
                leaf,
                seed=seed,
                salt=salt,
                trigger_count=trigger_count,
                global_idx=global_idx,
                cycle_idx=cycle_idx,
            )
        )
        raw_val = r_min + prng() * (r_max - r_min)
    elif is_random_token(token):
        lo = float(min_val) if min_val is not None else -1.0
        hi = float(max_val) if max_val is not None else 1.0
        prng = mulberry32(
            compute_leaf_prng_seed(
                leaf,
                seed=seed,
                salt=salt,
                trigger_count=trigger_count,
                global_idx=global_idx,
                cycle_idx=cycle_idx,
            )
        )
        if is_integer:
            min_int = int(math.ceil(min(lo, hi)))
            max_int = int(math.floor(max(lo, hi)))
            span = max(1, max_int - min_int + 1)
            raw_val = float(min_int + int(math.floor(prng() * span)))
        else:
            raw_val = min(lo, hi) + prng() * abs(hi - lo)
    else:
        try:
            raw_val = float(token)
        except (ValueError, TypeError):
            raw_val = float(fallback)

    if is_integer:
        raw_val = float(round(raw_val))
    elif step is not None and step > 0:
        step_str = str(step)
        precision = len(step_str.split(".")[1]) if "." in step_str else 0
        raw_val = round(round(raw_val / step) * step, precision)
    else:
        raw_val = round(raw_val, 4)

    if min_val is not None:
        raw_val = max(float(min_val), raw_val)
    if max_val is not None:
        raw_val = min(float(max_val), raw_val)
    return raw_val


def resolve_pool_item_by_query(
    items: List[Any],
    query: Any,
    slot_index: int = 0,
    slot_seed: Any = 0,
    is_sequential: bool = False,
    trigger_count: Optional[int] = None,
    global_idx: Optional[int] = None,
    global_progress: Optional[float] = None,
    cycle_idx: Optional[int] = None,
    cycle_progress: Optional[float] = None,
    event_idx: Optional[int] = None,
    window_event_idx: Optional[int] = None,
    pool_seed: Optional[Any] = None,
    node_id: int = 0,
) -> Optional[Any]:
    """Resolves a single item from an asset pool using a selector query or bracketed Field Operator."""
    if not items:
        return None

    active_items = permute_pool_items(items, pool_seed, node_id) if pool_seed is not None else items
    raw = str(query if query is not None else "").strip()
    lower = raw.lower()
    numeric_seed = normalize_numeric_seed(slot_seed, 0)

    def _extract_names(item: Any) -> dict:
        if not isinstance(item, dict):
            return {"name": "", "name_stem": "", "base": "", "base_stem": "", "fp_lower": ""}
        name = str(item.get("name") or "").strip().lower()
        name_stem = re.sub(r"\.[^.]+$", "", name)
        fp = str(item.get("filepath") or item.get("absolute_path") or "").strip()
        base = re.split(r"[\\/]", fp)[-1].lower() if fp else ""
        base_stem = re.sub(r"\.[^.]+$", "", base)
        return {"name": name, "name_stem": name_stem, "base": base, "base_stem": base_stem, "fp_lower": fp.lower()}

    # 1. Check if raw is an exact match for a single item name (even if it contains spaces)
    if raw and not re.search(r"[,\[\]<>]", raw) and not is_random_token(raw) and is_range_operator_token(raw) is None:
        for item in active_items:
            n = _extract_names(item)
            if lower in (n["name"], n["name_stem"], n["base"], n["base_stem"]):
                return item

    # 2. Evaluate AST leaf for bracketed or multi-token expressions
    leaf = resolve_field_operator_leaf(
        raw,
        trigger_count=trigger_count,
        global_idx=global_idx,
        global_progress=global_progress,
        cycle_idx=cycle_idx,
        cycle_progress=cycle_progress,
        event_idx=event_idx,
        window_event_idx=window_event_idx,
    )
    active_token = leaf["token"] if leaf else raw
    active_lower = active_token.lower()

    range_spec = is_range_operator_token(active_token)
    if range_spec is not None and leaf is not None:
        lo_idx = int(math.floor(range_spec[0]))
        hi_idx = int(math.floor(range_spec[1]))
        span = max(1, hi_idx - lo_idx + 1)
        leaf_seed = compute_leaf_prng_seed(
            leaf,
            seed=numeric_seed,
            salt=0xA55E + int(slot_index or 0),
            trigger_count=trigger_count,
            global_idx=global_idx,
            cycle_idx=cycle_idx,
        )
        prng = mulberry32(leaf_seed)
        chosen_idx = lo_idx + int(math.floor(prng() * span))
        return active_items[wrap_slot_index(chosen_idx, len(active_items))]

    if not active_token or active_lower in ("rand", "random"):
        if is_sequential:
            trig_i = max(0, int(trigger_count or 0))
            idx = wrap_slot_index(numeric_seed + slot_index + trig_i, len(active_items))
            return active_items[idx]
        if leaf is not None:
            leaf_seed = compute_leaf_prng_seed(
                leaf,
                seed=numeric_seed,
                salt=0xA55E + int(slot_index or 0),
                trigger_count=trigger_count,
                global_idx=global_idx,
                cycle_idx=cycle_idx,
            )
            prng = mulberry32(leaf_seed)
        else:
            trig_i = max(0, int(trigger_count or 0))
            prng = mulberry32(hash_seed(numeric_seed, slot_index + trig_i, 0xA55E))
        idx = int(math.floor(prng() * len(active_items)))
        return active_items[idx]

    if re.match(r"^-?\d+$", active_token):
        parsed_idx = int(active_token, 10)
        return active_items[wrap_slot_index(parsed_idx, len(active_items))]

    for item in active_items:
        n = _extract_names(item)
        if active_lower in (n["name"], n["name_stem"], n["base"], n["base_stem"]):
            return item
    for item in active_items:
        n = _extract_names(item)
        if (n["name"] and n["name"].startswith(active_lower)) or (n["base"] and n["base"].startswith(active_lower)):
            return item
    for item in active_items:
        n = _extract_names(item)
        if (
            (n["name"] and active_lower in n["name"])
            or (n["base"] and active_lower in n["base"])
            or (n["fp_lower"] and active_lower in n["fp_lower"])
        ):
            return item
    return None


def tokenize_expression(expr: Any, default_token: str = "*") -> List[str]:
    """Tokenizes a whitespace-separated pseudo-language string (or number)."""
    tokens = tokenize_field_operator(expr)
    return tokens if tokens else [default_token]


def resolve_cycle_seeds(
    seed_expr: Any,
    num_cycles: int,
    runtime_salt: Any = 0,
) -> List[int]:
    """Resolves a seed expression across `num_cycles` repetitions of a pattern."""
    count = max(1, int(num_cycles or 1))
    tokens = tokenize_expression(seed_expr, "0")
    base_salt = normalize_numeric_seed(runtime_salt, 0)
    result: List[int] = []

    for c in range(count):
        token = tokens[c % len(tokens)]
        if is_random_token(token):
            result.append((hash_seed(base_salt, c, 0xCAFE) % 9999) + 1)
        else:
            result.append(normalize_numeric_seed(token, 0))
    return result


def resolve_modifier_slot_seeds(
    seed_expr: Any,
    slot_count: int,
    runtime_salt: Any = 0,
) -> List[int]:
    """Resolves per-slot seeds when a Modifier (Asset Pool or Random) populates `slot_count` slots."""
    count = max(1, int(slot_count or 1))
    tokens = tokenize_expression(seed_expr, "0")
    base_salt = normalize_numeric_seed(runtime_salt, 0)
    result: List[int] = []

    if len(tokens) == 1 and not is_random_token(tokens[0]):
        base_seed = normalize_numeric_seed(tokens[0], 0)
        for s in range(count):
            result.append(base_seed if s == 0 else ((hash_seed(base_seed, s, 0x7777) % 9999) + 1))
        return result

    for s in range(count):
        token = tokens[s % len(tokens)]
        if is_random_token(token):
            result.append((hash_seed(base_salt, s, 0xBEEF) % 9999) + 1)
        else:
            result.append(normalize_numeric_seed(token, 0))
    return result


def resolve_step_slots(
    slot_expr: Any,
    step_count: int,
    upstream_slot_count: int,
    cycle_seed: Any = 0,
    upstream_active_slot: Any = 0,
    global_idx: Optional[int] = None,
    cycle_idx: Optional[int] = None,
    num_cycles: Optional[int] = None,
    active_sequence: Optional[List[int]] = None,
    start_event_idx: Optional[int] = None,
) -> List[int]:
    """
    Resolves a `sample_slot` expression across `step_count` steps, wrapping modulo `upstream_slot_count`,
    supporting unbracketed Global scope, `[...]` Cycle scope, and `<...>` Sequential Event scope.
    """
    count = max(1, int(step_count or 16))
    safe_slot_count = max(1, int(upstream_slot_count or 1))
    safe_active_slot = wrap_slot_index(upstream_active_slot, safe_slot_count)
    raw = str(slot_expr if slot_expr is not None else "*").strip()
    if not raw or is_default_slot_token(raw):
        return [safe_active_slot] * count

    numeric_seed = normalize_numeric_seed(cycle_seed, 0)
    has_brackets = bool(re.search(r"[\[\]<>]", raw))
    has_hier_opts = any(
        x is not None for x in (global_idx, cycle_idx, num_cycles, active_sequence, start_event_idx)
    )

    if not has_hier_opts and not has_brackets:
        tokens = tokenize_expression(raw, "*")
        result: List[int] = []
        for i in range(count):
            token = tokens[i % len(tokens)]
            if is_random_token(token):
                prng = mulberry32(hash_seed(numeric_seed, i, 0x5107))
                raw_slot = int(math.floor(prng() * safe_slot_count))
            elif is_default_slot_token(token):
                raw_slot = safe_active_slot
            else:
                try:
                    raw_slot = int(token, 10)
                except (ValueError, TypeError):
                    raw_slot = safe_active_slot
            result.append(wrap_slot_index(raw_slot, safe_slot_count))
        return result

    ast = parse_field_operator_ast(raw)
    eff_g_idx = max(0, int(global_idx or 0))
    eff_c_idx = max(0, int(cycle_idx or 0))
    eff_num_cycles = max(1, int(num_cycles or 1))
    running_event_idx = max(0, int(start_event_idx or 0))
    running_window_event_idx = 0
    last_slice_key = ""
    result = []

    for i in range(count):
        is_step_active = bool(active_sequence[i]) if (active_sequence is not None and i < len(active_sequence)) else True
        c_prog = float(i) / float(count)
        g_prog = (float(eff_c_idx) + c_prog) / float(eff_num_cycles)

        leaf = resolve_field_operator_leaf(
            ast,
            global_idx=eff_g_idx,
            global_progress=g_prog,
            cycle_idx=eff_c_idx,
            cycle_progress=c_prog,
            event_idx=running_event_idx,
            window_event_idx=running_window_event_idx,
        )
        slice_key = f"{leaf['scope']}:{leaf['sliceIndex']}" if leaf else ""
        if slice_key != last_slice_key:
            last_slice_key = slice_key
            if running_window_event_idx != 0:
                running_window_event_idx = 0
                leaf = resolve_field_operator_leaf(
                    ast,
                    global_idx=eff_g_idx,
                    global_progress=g_prog,
                    cycle_idx=eff_c_idx,
                    cycle_progress=c_prog,
                    event_idx=running_event_idx,
                    window_event_idx=0,
                )
        raw_slot = safe_active_slot
        if leaf:
            tok = leaf["token"]
            range_spec = is_range_operator_token(tok)
            if is_default_slot_token(tok):
                raw_slot = safe_active_slot
            elif range_spec is not None:
                prng = mulberry32(
                    compute_leaf_prng_seed(
                        leaf,
                        seed=numeric_seed,
                        salt=0x5107,
                        global_idx=eff_g_idx,
                        cycle_idx=eff_c_idx,
                    )
                )
                lo = int(math.floor(range_spec[0]))
                hi = int(math.floor(range_spec[1]))
                raw_slot = lo + int(math.floor(prng() * max(1, hi - lo + 1)))
            elif is_random_token(tok):
                prng = mulberry32(
                    compute_leaf_prng_seed(
                        leaf,
                        seed=numeric_seed,
                        salt=0x5107,
                        global_idx=eff_g_idx,
                        cycle_idx=eff_c_idx,
                    )
                )
                raw_slot = int(math.floor(prng() * safe_slot_count))
            else:
                try:
                    raw_slot = int(tok, 10)
                except (ValueError, TypeError):
                    raw_slot = safe_active_slot

        result.append(wrap_slot_index(raw_slot, safe_slot_count))
        if is_step_active:
            running_event_idx += 1
            running_window_event_idx += 1

    return result


def resolve_section_slot(
    slot_value: Any,
    upstream_slot_count: Any,
    upstream_active_slot: Any = 0,
    section_seed: Any = 0,
    section_index: int = 0,
) -> int:
    """Resolves a single section slot value ('*', integer, 'rand', or bracketed expression)."""
    safe_slot_count = max(1, int(upstream_slot_count or 1))
    safe_active_slot = wrap_slot_index(upstream_active_slot, safe_slot_count)
    if slot_value is None or is_default_slot_token(slot_value):
        return safe_active_slot
    raw = str(slot_value).strip()
    if is_random_token(raw):
        numeric_seed = normalize_numeric_seed(section_seed, 0)
        prng = mulberry32(hash_seed(numeric_seed, section_index, 0x5107))
        return wrap_slot_index(int(math.floor(prng() * safe_slot_count)), safe_slot_count)
    if is_field_operator_expression(raw):
        val = evaluate_numeric_field_operator(
            raw,
            trigger_count=section_index,
            seed=section_seed,
            salt=0x5107 + section_index,
            min_val=0,
            max_val=max(0, safe_slot_count - 1),
            step=1,
            is_integer=True,
            fallback=float(safe_active_slot),
            global_idx=0,
            cycle_idx=section_index,
            event_idx=section_index,
        )
        return wrap_slot_index(int(round(val)), safe_slot_count)
    return wrap_slot_index(slot_value, safe_slot_count)


def roll_seed_expression(
    seed_expr: Any,
    random_fn: Optional[Callable[[], float]] = None,
) -> str:
    """Re-rolls all numeric tokens in a seed expression while preserving 'rand'/'random' tokens."""
    rng_fn = random_fn or _py_random.random
    tokens = tokenize_expression(seed_expr, "0")
    next_tokens: List[str] = []
    for token in tokens:
        if is_random_token(token):
            next_tokens.append("rand")
        else:
            next_int = int(math.floor(rng_fn() * 9999)) + 1
            next_tokens.append(str(next_int))
    return " ".join(next_tokens)

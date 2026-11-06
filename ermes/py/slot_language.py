"""
ERMES Deterministic Slot & Seed Pseudo-Language Engine (Python)

Provides cross-language bit-identical PRNG (SplitMix32 + Mulberry32)
matching `ermes/ts/slotLanguage.ts` and evaluates slot/seed pseudo-language expressions:
- Single integer: "0", "42"
- Whitespaced sequence: "0 1", "42 108" (cycles deterministically)
- Random keyword: "rand", "random", or mixed "0 0 1 rand"
"""

import math
import random as _py_random
import re
from typing import Any, Callable, List, Optional


def _imul32(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def hash_seed(base_seed: int, index: int = 0, salt: int = 0) -> int:
    """32-bit SplitMix32 avalanching hash (bit-identical to TypeScript `hashSeed`)."""
    h = (
        (int(base_seed) & 0xFFFFFFFF)
        ^ _imul32(int(index) & 0xFFFFFFFF, 0x9E3779B9)
        ^ _imul32(int(salt) & 0xFFFFFFFF, 0x85EBCA6B)
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


def normalize_numeric_seed(val: Any, fallback: int = 42) -> int:
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


def is_random_token(token: str) -> bool:
    t = str(token or "").strip().lower()
    return t in ("rand", "random")


def is_default_slot_token(token: Any) -> bool:
    t = str(token if token is not None else "").strip().lower()
    return t in ("*", "default", "active")


def is_range_operator_token(token: Any) -> Optional[tuple[float, float]]:
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


def tokenize_field_operator(expr: Any) -> List[str]:
    """Tokenizes a Field Operator expression supporting quotes, rand(a,b), and whitespace/comma lists."""
    raw = str(expr if expr is not None else "").strip()
    if not raw:
        return []
    pattern = re.compile(r'"([^"]+)"|\'([^\']+)\'|((?:rand|random)\s*\([^)]+\))|[^\s,]+', re.IGNORECASE)
    tokens: List[str] = []
    for match in pattern.finditer(raw):
        tok = (match.group(1) or match.group(2) or match.group(3) or match.group(0) or "").strip()
        if tok:
            tokens.append(tok)
    return tokens


def is_field_operator_expression(expr: Any) -> bool:
    """Returns True if `expr` is an active Field Operator (rand, range, or multi-token cycle list)."""
    raw = str(expr if expr is not None else "").strip()
    if not raw:
        return False
    tokens = tokenize_field_operator(raw)
    if not tokens:
        return False
    if len(tokens) > 1:
        return True
    single = tokens[0]
    return is_random_token(single) or (is_range_operator_token(single) is not None)


def evaluate_numeric_field_operator(
    expr: Any,
    trigger_count: int = 0,
    seed: Any = 42,
    salt: int = 0xF1E1,
    min_val: Optional[float] = None,
    max_val: Optional[float] = None,
    step: Optional[float] = None,
    is_integer: bool = False,
    fallback: float = 0.0,
) -> float:
    """Evaluates a numeric Field Operator expression using `trigger_count` for lists and `seed` for rand/range."""
    tokens = tokenize_field_operator(expr)
    if not tokens:
        return float(fallback)
    trigger_idx = max(0, int(trigger_count or 0))
    token = tokens[wrap_slot_index(trigger_idx, len(tokens))]
    numeric_seed = normalize_numeric_seed(seed, 42)

    range_spec = is_range_operator_token(token)
    if range_spec is not None:
        r_min, r_max = range_spec
        prng = mulberry32(hash_seed(numeric_seed, trigger_idx, salt))
        raw_val = r_min + prng() * (r_max - r_min)
    elif is_random_token(token):
        lo = float(min_val) if min_val is not None else -1.0
        hi = float(max_val) if max_val is not None else 1.0
        prng = mulberry32(hash_seed(numeric_seed, trigger_idx, salt))
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
    slot_seed: Any = 42,
    is_sequential: bool = False,
    trigger_count: int = 0,
) -> Optional[Any]:
    """Resolves a single item from an asset pool using a selector query or Field Operator."""
    if not items:
        return None
    raw = str(query if query is not None else "").strip()
    lower = raw.lower()
    numeric_seed = normalize_numeric_seed(slot_seed, 42)
    trigger_idx = max(0, int(trigger_count or 0))

    def _extract_names(item: Any) -> dict:
        if not isinstance(item, dict):
            return {"name": "", "name_stem": "", "base": "", "base_stem": "", "fp_lower": ""}
        name = str(item.get("name") or "").strip().lower()
        name_stem = re.sub(r"\.[^.]+$", "", name)
        fp = str(item.get("filepath") or item.get("absolute_path") or "").strip()
        base = re.split(r"[\\/]", fp)[-1].lower() if fp else ""
        base_stem = re.sub(r"\.[^.]+$", "", base)
        return {"name": name, "name_stem": name_stem, "base": base, "base_stem": base_stem, "fp_lower": fp.lower()}

    # Check if raw is an exact match for a single item name (even if it contains spaces)
    if raw and not is_random_token(raw) and is_range_operator_token(raw) is None:
        for item in items:
            n = _extract_names(item)
            if lower in (n["name"], n["name_stem"], n["base"], n["base_stem"]):
                return item

    tokens = tokenize_field_operator(raw)
    if len(tokens) > 1:
        active_token = tokens[wrap_slot_index(trigger_idx, len(tokens))]
        return resolve_pool_item_by_query(
            items,
            active_token,
            slot_index=slot_index,
            slot_seed=numeric_seed,
            is_sequential=is_sequential,
            trigger_count=trigger_idx,
        )

    range_spec = is_range_operator_token(raw)
    if range_spec is not None:
        lo_idx = int(math.floor(range_spec[0]))
        hi_idx = int(math.floor(range_spec[1]))
        span = max(1, hi_idx - lo_idx + 1)
        prng = mulberry32(hash_seed(numeric_seed, slot_index + trigger_idx, 0xA55E))
        chosen_idx = lo_idx + int(math.floor(prng() * span))
        return items[wrap_slot_index(chosen_idx, len(items))]

    if not raw or lower in ("rand", "random"):
        if is_sequential:
            idx = wrap_slot_index(numeric_seed + slot_index + trigger_idx, len(items))
            return items[idx]
        prng = mulberry32(hash_seed(numeric_seed, slot_index + trigger_idx, 0xA55E))
        idx = int(math.floor(prng() * len(items)))
        return items[idx]

    if re.match(r"^-?\d+$", raw):
        parsed_idx = int(raw, 10)
        return items[wrap_slot_index(parsed_idx, len(items))]

    for item in items:
        n = _extract_names(item)
        if lower in (n["name"], n["name_stem"], n["base"], n["base_stem"]):
            return item
    for item in items:
        n = _extract_names(item)
        if (n["name"] and n["name"].startswith(lower)) or (n["base"] and n["base"].startswith(lower)):
            return item
    for item in items:
        n = _extract_names(item)
        if (n["name"] and lower in n["name"]) or (n["base"] and lower in n["base"]) or (n["fp_lower"] and lower in n["fp_lower"]):
            return item
    return None


def tokenize_expression(expr: Any, default_token: str = "*") -> List[str]:
    """Tokenizes a whitespace-separated pseudo-language string (or number)."""
    tokens = tokenize_field_operator(expr)
    return tokens if tokens else [default_token]


def resolve_cycle_seeds(
    seed_expr: Any,
    num_cycles: int,
    runtime_salt: Any = 42,
) -> List[int]:
    """Resolves a seed expression across `num_cycles` repetitions of a pattern."""
    count = max(1, int(num_cycles or 1))
    tokens = tokenize_expression(seed_expr, "42")
    base_salt = normalize_numeric_seed(runtime_salt, 42)
    result: List[int] = []

    for c in range(count):
        token = tokens[c % len(tokens)]
        if is_random_token(token):
            result.append((hash_seed(base_salt, c, 0xCAFE) % 9999) + 1)
        else:
            result.append(normalize_numeric_seed(token, 42))
    return result


def resolve_modifier_slot_seeds(
    seed_expr: Any,
    slot_count: int,
    runtime_salt: Any = 42,
) -> List[int]:
    """Resolves per-slot seeds when a Modifier (Asset Pool or Random) populates `slot_count` slots."""
    count = max(1, int(slot_count or 1))
    tokens = tokenize_expression(seed_expr, "42")
    base_salt = normalize_numeric_seed(runtime_salt, 42)
    result: List[int] = []

    if len(tokens) == 1 and not is_random_token(tokens[0]):
        base_seed = normalize_numeric_seed(tokens[0], 42)
        for s in range(count):
            result.append(base_seed if s == 0 else ((hash_seed(base_seed, s, 0x7777) % 9999) + 1))
        return result

    for s in range(count):
        token = tokens[s % len(tokens)]
        if is_random_token(token):
            result.append((hash_seed(base_salt, s, 0xBEEF) % 9999) + 1)
        else:
            result.append(normalize_numeric_seed(token, 42))
    return result


def resolve_step_slots(
    slot_expr: Any,
    step_count: int,
    upstream_slot_count: int,
    cycle_seed: Any = 42,
    upstream_active_slot: Any = 0,
) -> List[int]:
    """Resolves a `sample_slot` expression across `step_count` steps, wrapping modulo `upstream_slot_count`."""
    count = max(1, int(step_count or 16))
    safe_slot_count = max(1, int(upstream_slot_count or 1))
    safe_active_slot = wrap_slot_index(upstream_active_slot, safe_slot_count)
    tokens = tokenize_expression(slot_expr, "*")
    numeric_seed = normalize_numeric_seed(cycle_seed, 42)
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
                raw_slot = 0
        result.append(wrap_slot_index(raw_slot, safe_slot_count))
    return result


def resolve_section_slot(
    slot_value: Any,
    upstream_slot_count: Any,
    upstream_active_slot: Any = 0,
    section_seed: Any = 42,
    section_index: int = 0,
) -> int:
    """Resolves a single section slot value ('*', integer, or 'rand') against upstream slot count and active slot."""
    safe_slot_count = max(1, int(upstream_slot_count or 1))
    safe_active_slot = wrap_slot_index(upstream_active_slot, safe_slot_count)
    if slot_value is None or is_default_slot_token(slot_value):
        return safe_active_slot
    if is_random_token(slot_value):
        numeric_seed = normalize_numeric_seed(section_seed, 42)
        prng = mulberry32(hash_seed(numeric_seed, section_index, 0x5EC7))
        return wrap_slot_index(int(math.floor(prng() * safe_slot_count)), safe_slot_count)
    return wrap_slot_index(slot_value, safe_slot_count)



def roll_seed_expression(
    seed_expr: Any,
    random_fn: Optional[Callable[[], float]] = None,
) -> str:
    """Re-rolls all numeric tokens in a seed expression while preserving 'rand'/'random' tokens."""
    rng_fn = random_fn or _py_random.random
    tokens = tokenize_expression(seed_expr, "42")
    next_tokens: List[str] = []
    for token in tokens:
        if is_random_token(token):
            next_tokens.append("rand")
        else:
            next_int = int(math.floor(rng_fn() * 9999)) + 1
            next_tokens.append(str(next_int))
    return " ".join(next_tokens)


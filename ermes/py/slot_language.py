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


def tokenize_expression(expr: Any, default_token: str = "0") -> List[str]:
    """Tokenizes a whitespace-separated pseudo-language string (or number)."""
    raw = str(expr if expr is not None else "").strip()
    if not raw:
        return [default_token]
    tokens = [tok for tok in re.split(r"[\s,]+", raw) if tok]
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
) -> List[int]:
    """Resolves a `sample_slot` expression across `step_count` steps, wrapping modulo `upstream_slot_count`."""
    count = max(1, int(step_count or 16))
    safe_slot_count = max(1, int(upstream_slot_count or 1))
    tokens = tokenize_expression(slot_expr, "0")
    numeric_seed = normalize_numeric_seed(cycle_seed, 42)
    result: List[int] = []

    for i in range(count):
        token = tokens[i % len(tokens)]
        if is_random_token(token):
            prng = mulberry32(hash_seed(numeric_seed, i, 0x5107))
            raw_slot = int(math.floor(prng() * safe_slot_count))
        else:
            try:
                raw_slot = int(token, 10)
            except (ValueError, TypeError):
                raw_slot = 0
        result.append(wrap_slot_index(raw_slot, safe_slot_count))
    return result


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


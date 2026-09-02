from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter
from typing import Any, Hashable, Iterator, Literal


RuntimeLevel = Literal["common", "warning", "debug", "error"]
_active_trace: ContextVar[tuple[float, list[dict], dict[Hashable, Any]] | None] = ContextVar(
    "sin_runtime_trace",
    default=None,
)


@contextmanager
def collect_runtime_trace() -> Iterator[list[dict]]:
    """Collect ordered render events for one request without sharing state across requests."""
    entries: list[dict] = []
    token = _active_trace.set((perf_counter(), entries, {}))
    try:
        yield entries
    finally:
        _active_trace.reset(token)


def trace_runtime(message: str, level: RuntimeLevel = "debug") -> None:
    active = _active_trace.get()
    if active is None:
        return
    started_at, entries, _ = active
    entries.append({
        "level": level,
        "message": message,
        "offset_ms": round((perf_counter() - started_at) * 1000.0, 2),
    })


def get_runtime_cache(key: Hashable) -> Any:
    active = _active_trace.get()
    return active[2].get(key) if active is not None else None


def set_runtime_cache(key: Hashable, value: Any) -> None:
    active = _active_trace.get()
    if active is not None:
        active[2][key] = value

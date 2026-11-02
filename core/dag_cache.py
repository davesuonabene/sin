from __future__ import annotations
import hashlib
import json
import threading
from typing import Optional, Any
import numpy as np


class DagNodeCache:
    """
    Volatile in-memory cache for rendered audio node buffers and DAG dependency tracking.
    Enables incremental re-rendering by preserving upstream cached buffers when downstream
    nodes are modified, and supports downstream invalidation.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._cache: dict[str, dict[str, Any]] = {}
        self._dependency_graph: dict[str, set[str]] = {}  # parent_id -> set of child_ids
        self._reverse_dependencies: dict[str, set[str]] = {}  # child_id -> set of downstream parent_ids

    def compute_fingerprint(self, data: dict[str, Any]) -> str:
        """
        Produces a stable 16-character hex hash from a node's parameter dictionary.
        """
        try:
            serialized = json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)
            return hashlib.sha1(serialized.encode("utf-8")).hexdigest()[:16]
        except Exception:
            return hashlib.sha1(str(data).encode("utf-8")).hexdigest()[:16]

    def store(
        self,
        node_id: int | str,
        fingerprint: str,
        audio: np.ndarray,
        extra: Optional[dict[str, Any]] = None,
        context: Optional[Any] = None,
    ) -> None:
        """
        Stores rendered audio array and metadata for a specific node and parameter fingerprint.
        """
        if node_id is None or audio is None:
            return
        with self._lock:
            self._cache[str(node_id)] = {
                "fingerprint": str(fingerprint),
                "context": context,
                "audio": audio,
                "extra": extra or {},
            }

    def get(
        self,
        node_id: int | str,
        fingerprint: str,
        context: Optional[Any] = None,
    ) -> Optional[np.ndarray]:
        """
        Retrieves cached audio if fingerprint (and optional execution context) matches.
        Returns None if stale or missing.
        """
        if node_id is None:
            return None
        with self._lock:
            entry = self._cache.get(str(node_id))
            if entry and entry.get("fingerprint") == str(fingerprint):
                if context is not None and entry.get("context") is not None and entry.get("context") != context:
                    return None
                return entry.get("audio")
            return None

    def get_extra(
        self,
        node_id: int | str,
        fingerprint: str,
        context: Optional[Any] = None,
    ) -> Optional[dict[str, Any]]:
        """
        Retrieves cached extra metadata (manifest entries, stems) if fingerprint matches.
        """
        if node_id is None:
            return None
        with self._lock:
            entry = self._cache.get(str(node_id))
            if entry and entry.get("fingerprint") == str(fingerprint):
                if context is not None and entry.get("context") is not None and entry.get("context") != context:
                    return None
                return entry.get("extra")
            return None

    def register_edge(self, parent_id: int | str, child_id: int | str) -> None:
        """
        Registers an audio signal edge: parent_id consumes child_id.
        """
        if parent_id is None or child_id is None:
            return
        p_str = str(parent_id)
        c_str = str(child_id)
        with self._lock:
            self._dependency_graph.setdefault(p_str, set()).add(c_str)
            self._reverse_dependencies.setdefault(c_str, set()).add(p_str)

    def invalidate_downstream(self, node_id: int | str) -> set[str]:
        """
        Recursively invalidates node_id and all downstream consumers.
        Returns the set of invalidated node IDs.
        """
        if node_id is None:
            return set()
        with self._lock:
            invalidated = set()
            to_visit = [str(node_id)]
            while to_visit:
                curr = to_visit.pop(0)
                if curr not in invalidated:
                    invalidated.add(curr)
                    self._cache.pop(curr, None)
                    downstream = list(self._reverse_dependencies.get(curr, set()))
                    to_visit.extend(downstream)
            return invalidated

    def clear(self) -> None:
        """
        Flushes all in-memory cache entries and dependency mappings.
        """
        with self._lock:
            self._cache.clear()
            self._dependency_graph.clear()
            self._reverse_dependencies.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._cache)


GLOBAL_DAG_CACHE = DagNodeCache()


def compute_waveform_peaks(audio_data: np.ndarray, columns: int = 128) -> list[float]:
    """
    Computes interleaved [min0, max0, min1, max1, ...] normalized peaks for fast UI drawing.
    """
    if audio_data is None or audio_data.size == 0 or columns <= 0:
        return []
    
    # If multi-channel, merge/max across channels
    if audio_data.ndim > 1:
        flat_audio = np.max(np.abs(audio_data), axis=tuple(range(audio_data.ndim - 1)))
    else:
        flat_audio = audio_data

    total_len = len(flat_audio)
    if total_len == 0:
        return []

    cols = min(columns, total_len)
    step = total_len / float(cols)
    peaks: list[float] = []
    for i in range(cols):
        s_idx = int(i * step)
        e_idx = max(s_idx + 1, int((i + 1) * step))
        slice_data = flat_audio[s_idx:e_idx]
        if len(slice_data) > 0:
            peaks.append(round(float(np.min(slice_data)), 4))
            peaks.append(round(float(np.max(slice_data)), 4))
        else:
            peaks.append(0.0)
            peaks.append(0.0)
    return peaks

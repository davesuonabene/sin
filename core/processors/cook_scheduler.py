"""Background async cook scheduler with per-node debouncing, generation cancellation,
and windowed preview-first execution for standalone `AudioProcessorObject` nodes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
import threading
import time
from typing import Any, Callable, Dict, Optional
import numpy as np

from core.env_config import get_env_config

logger = logging.getLogger("sin.processors.cook_scheduler")


@dataclass
class PendingCookJob:
    node_id: str
    node_type: str
    node_name: str
    cook_fingerprint: str
    audio_in: np.ndarray
    sample_rate: int
    playhead_sec: float
    cook_fn: Callable[[np.ndarray, int, Optional[threading.Event], Optional[Callable[[float], None]]], Any]
    store_partial_fn: Callable[[Any, int, int], None]
    store_full_fn: Callable[[Any], None]
    immediate: bool = False  # True for explicit manual 'Process' trigger (skips debounce)
    extra: Dict[str, Any] = field(default_factory=dict)


class ProcessorCookScheduler:
    """Debounced, cancellable background cook worker with windowed preview-first support."""

    def __init__(
        self,
        *,
        on_status: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        on_hot_swap: Optional[Callable[[str, str], None]] = None,
        debounce_ms: Optional[int] = None,
        preview_window_sec: Optional[float] = None,
    ) -> None:
        self._on_status = on_status
        self._on_hot_swap = on_hot_swap
        self._debounce_ms_override = debounce_ms
        self._preview_window_override = preview_window_sec
        self._lock = threading.RLock()
        self._generations: Dict[str, int] = {}
        self._cancel_events: Dict[str, threading.Event] = {}
        self._in_flight_fp: Dict[str, str] = {}
        self._statuses: Dict[str, Dict[str, Any]] = {}
        self._timers: Dict[str, threading.Timer] = {}

    @property
    def debounce_ms(self) -> int:
        return int(
            self._debounce_ms_override
            if self._debounce_ms_override is not None
            else get_env_config().cook_debounce_ms
        )

    @property
    def preview_window_sec(self) -> float:
        return float(
            self._preview_window_override
            if self._preview_window_override is not None
            else get_env_config().preview_window_sec
        )

    def _emit_status(self, node_id: str, payload: Dict[str, Any]) -> None:
        with self._lock:
            self._statuses[node_id] = dict(payload)
        if self._on_status is not None:
            try:
                self._on_status(node_id, dict(payload))
            except Exception as exc:
                logger.debug("Processor status callback error: %s", exc)

    def get_status(self, node_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            st = self._statuses.get(str(node_id))
            return dict(st) if st is not None else None

    def get_all_statuses(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {k: dict(v) for k, v in self._statuses.items()}

    def cancel_node(self, node_id: str) -> bool:
        nid = str(node_id)
        with self._lock:
            timer = self._timers.pop(nid, None)
            if timer is not None:
                timer.cancel()
            ev = self._cancel_events.get(nid)
            had = ev is not None
            if ev is not None:
                ev.set()
            self._generations[nid] = self._generations.get(nid, 0) + 1
            self._in_flight_fp.pop(nid, None)
        return had

    def cancel_all(self) -> None:
        with self._lock:
            nids = list(set(self._timers.keys()) | set(self._cancel_events.keys()))
        for nid in nids:
            self.cancel_node(nid)

    def schedule(self, job: PendingCookJob) -> int:
        """Schedule a background cook job for `job.node_id`, cancelling any older generation."""
        nid = str(job.node_id)
        with self._lock:
            # Deduplicate if an identical fingerprint is already cooking
            if self._in_flight_fp.get(nid) == job.cook_fingerprint and not job.immediate:
                return self._generations.get(nid, 0)

            old_timer = self._timers.pop(nid, None)
            if old_timer is not None:
                old_timer.cancel()
            old_ev = self._cancel_events.get(nid)
            if old_ev is not None:
                old_ev.set()

            gen = self._generations.get(nid, 0) + 1
            self._generations[nid] = gen
            cancel_ev = threading.Event()
            self._cancel_events[nid] = cancel_ev
            self._in_flight_fp[nid] = job.cook_fingerprint

        self._emit_status(nid, {
            "node_id": nid,
            "node_type": job.node_type,
            "node_name": job.node_name,
            "state": "cooking_bypassed",
            "progress": 0.0,
            "phase": "queued" if not job.immediate else "cooking",
            "cook_fingerprint": job.cook_fingerprint,
            "generation": gen,
        })

        delay_sec = 0.0 if job.immediate else (max(0, self.debounce_ms) / 1000.0)

        def _launch() -> None:
            with self._lock:
                self._timers.pop(nid, None)
                if self._generations.get(nid) != gen or cancel_ev.is_set():
                    return
            worker = threading.Thread(
                target=self._run_job,
                args=(job, gen, cancel_ev),
                name=f"sin-cook-{nid}-{gen}",
                daemon=True,
            )
            worker.start()

        if delay_sec <= 0.0:
            _launch()
        else:
            timer = threading.Timer(delay_sec, _launch)
            timer.daemon = True
            with self._lock:
                self._timers[nid] = timer
            timer.start()

        return gen

    def _run_job(self, job: PendingCookJob, gen: int, cancel_ev: threading.Event) -> None:
        nid = str(job.node_id)
        t0 = time.perf_counter()
        audio_in = job.audio_in
        sr = int(job.sample_rate or 48000)
        total_frames = int(audio_in.shape[-1])
        dur_sec = float(total_frames) / float(sr) if sr > 0 else 0.0
        win_sec = self.preview_window_sec

        def _is_stale() -> bool:
            with self._lock:
                return cancel_ev.is_set() or self._generations.get(nid) != gen

        try:
            # Pass 1: Windowed preview-first cook for long clips (> preview_window_sec)
            if dur_sec > win_sec * 1.15 and total_frames > 0:
                start_sec = max(0.0, float(job.playhead_sec) - 1.0)
                if start_sec + win_sec > dur_sec:
                    start_sec = max(0.0, dur_sec - win_sec)
                s_idx = int(round(start_sec * sr))
                e_idx = min(total_frames, s_idx + int(round(win_sec * sr)))
                if e_idx - s_idx >= sr:
                    self._emit_status(nid, {
                        "node_id": nid,
                        "node_type": job.node_type,
                        "node_name": job.node_name,
                        "state": "cooking_bypassed",
                        "progress": 0.1,
                        "phase": f"preview window ({start_sec:.1f}s..{e_idx / sr:.1f}s)",
                        "cook_fingerprint": job.cook_fingerprint,
                        "generation": gen,
                    })
                    partial_slice = audio_in[..., s_idx:e_idx]
                    partial_art = job.cook_fn(
                        partial_slice,
                        sr,
                        cancel_ev,
                        lambda frac: self._emit_status(nid, {
                            "node_id": nid,
                            "node_type": job.node_type,
                            "node_name": job.node_name,
                            "state": "cooking_bypassed",
                            "progress": round(0.1 + 0.35 * float(frac), 3),
                            "phase": "preview window",
                            "cook_fingerprint": job.cook_fingerprint,
                            "generation": gen,
                        }) if not _is_stale() else None,
                    )
                    if _is_stale():
                        return
                    job.store_partial_fn(partial_art, s_idx, e_idx)
                    self._emit_status(nid, {
                        "node_id": nid,
                        "node_type": job.node_type,
                        "node_name": job.node_name,
                        "state": "partial_ready",
                        "progress": 0.45,
                        "phase": "finishing full clip",
                        "window_sec": [round(s_idx / sr, 3), round(e_idx / sr, 3)],
                        "cook_fingerprint": job.cook_fingerprint,
                        "generation": gen,
                    })
                    if self._on_hot_swap is not None:
                        self._on_hot_swap(nid, "partial_ready")

            if _is_stale():
                return

            # Pass 2: Full-clip cook
            base_prog = 0.45 if dur_sec > win_sec * 1.15 else 0.05
            self._emit_status(nid, {
                "node_id": nid,
                "node_type": job.node_type,
                "node_name": job.node_name,
                "state": "partial_ready" if base_prog > 0.1 else "cooking_bypassed",
                "progress": base_prog,
                "phase": "processing full clip",
                "cook_fingerprint": job.cook_fingerprint,
                "generation": gen,
            })

            full_art = job.cook_fn(
                audio_in,
                sr,
                cancel_ev,
                lambda frac: self._emit_status(nid, {
                    "node_id": nid,
                    "node_type": job.node_type,
                    "node_name": job.node_name,
                    "state": "partial_ready" if base_prog > 0.1 else "cooking_bypassed",
                    "progress": round(base_prog + (1.0 - base_prog) * float(frac) * 0.95, 3),
                    "phase": "processing full clip",
                    "cook_fingerprint": job.cook_fingerprint,
                    "generation": gen,
                }) if not _is_stale() else None,
            )
            if _is_stale():
                return

            job.store_full_fn(full_art)
            elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
            with self._lock:
                if self._generations.get(nid) == gen:
                    self._in_flight_fp.pop(nid, None)

            self._emit_status(nid, {
                "node_id": nid,
                "node_type": job.node_type,
                "node_name": job.node_name,
                "state": "ready",
                "progress": 1.0,
                "phase": "ready",
                "cook_ms": elapsed_ms,
                "cook_fingerprint": job.cook_fingerprint,
                "generation": gen,
            })
            if self._on_hot_swap is not None:
                self._on_hot_swap(nid, "ready")

        except InterruptedError:
            logger.debug("Cook cancelled for node %s gen %d", nid, gen)
        except Exception as exc:
            logger.exception("Cook failed for node %s: %s", nid, exc)
            with self._lock:
                if self._generations.get(nid) == gen:
                    self._in_flight_fp.pop(nid, None)
            self._emit_status(nid, {
                "node_id": nid,
                "node_type": job.node_type,
                "node_name": job.node_name,
                "state": "error",
                "progress": 0.0,
                "phase": "error",
                "error": str(exc),
                "cook_fingerprint": job.cook_fingerprint,
                "generation": gen,
            })

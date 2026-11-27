"""Hybrid bounded RAM/disk tile cache and multi-resolution peak pyramid cache
for seamless 1h+ long-track audio processing and zoomable dual-color waveforms.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import logging
import math
import os
from pathlib import Path
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
import numpy as np
import soundfile as sf

from core.env_config import get_env_config

logger = logging.getLogger("sin.processors.tile_cache")

# Tile visual tier constants shared with frontend WaveformScrubCanvas
TIER_RAW = 0
TIER_FAST_DSP = 1
TIER_COMPLEX_ML = 2
TIER_STALE = 3


def compute_interleaved_peaks(audio: np.ndarray, columns: int) -> np.ndarray:
    """Vectorized [min0, max0, min1, max1, ...] float32 peaks."""
    if audio is None or audio.size == 0 or columns <= 0:
        return np.zeros(0, dtype=np.float32)
    mono = audio.mean(axis=0, dtype=np.float32) if audio.ndim > 1 else np.asarray(audio, dtype=np.float32)
    total = int(mono.shape[-1])
    if total <= 0:
        return np.zeros(0, dtype=np.float32)
    cols = min(int(columns), total)
    usable = (total // cols) * cols
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    reshaped = mono[:usable].reshape(cols, usable // cols)
    out = np.empty(cols * 2, dtype=np.float32)
    out[0::2] = reshaped.min(axis=1)
    out[1::2] = reshaped.max(axis=1)
    return out


def _estimate_object_bytes(obj: Any) -> int:
    if obj is None:
        return 0
    if isinstance(obj, np.ndarray):
        return int(obj.nbytes)
    if isinstance(obj, dict):
        return sum(_estimate_object_bytes(v) for v in obj.values())
    if isinstance(obj, (list, tuple)):
        return sum(_estimate_object_bytes(v) for v in obj)
    # Handle dataclass instances (PreampAnalysis, VoiceDecomposition, etc.)
    d = getattr(obj, "__dict__", None)
    if isinstance(d, dict):
        return sum(_estimate_object_bytes(v) for v in d.values())
    return 128


@dataclass
class CachedTileResult:
    pcm: np.ndarray  # (2, N) float32
    peaks: np.ndarray  # (2*P,) float32 interleaved min/max
    tier: int
    generation: int
    nbytes: int


class HybridTileCache:
    """Byte-budgeted Hot RAM LRU + LRU-capped disk spill cache for 8s processor tiles.

    - Hot RAM LRU keeps active tiles near the playhead + their Level-1 analysis/stems
      so live-drag fader tweaks re-synthesize in ~20-50ms without disk reads.
    - Disk spill (`.runtime/dsp_cache/tiles/`) persists cooked PCM tiles and float16
      ML stems so revisiting previously cooked sections of a 1h+ track is instant.
    """

    def __init__(
        self,
        *,
        cache_dir: Optional[Path] = None,
        ram_budget_mb: Optional[int] = None,
        disk_budget_gb: Optional[float] = None,
    ) -> None:
        self._dir_override = cache_dir
        self._ram_budget_mb_override = ram_budget_mb
        self._disk_budget_gb_override = disk_budget_gb
        self._lock = threading.RLock()

        # Key -> (payload, nbytes)
        self._analysis_ram: OrderedDict[Tuple[str, int], Tuple[Any, int]] = OrderedDict()
        self._pcm_ram: OrderedDict[Tuple[str, int], CachedTileResult] = OrderedDict()
        self._ram_bytes: int = 0
        self._eviction_callbacks: List[Callable[[str, int], None]] = []

    @property
    def cache_dir(self) -> Path:
        base = self._dir_override if self._dir_override is not None else get_env_config().dsp_cache_dir
        return Path(base) / "tiles"

    @property
    def ram_budget_bytes(self) -> int:
        mb = self._ram_budget_mb_override if self._ram_budget_mb_override is not None else get_env_config().tile_ram_mb
        return max(32, int(mb)) * 1024 * 1024

    @property
    def disk_budget_bytes(self) -> int:
        gb = self._disk_budget_gb_override if self._disk_budget_gb_override is not None else get_env_config().dsp_cache_max_gb
        return max(int(0.1 * (1024 ** 3)), int(float(gb) * (1024 ** 3)))

    def set_ram_budget_mb(self, mb: int) -> None:
        with self._lock:
            self._ram_budget_mb_override = max(32, min(4096, int(mb)))
            self._enforce_ram_budget_locked()

    def set_disk_budget_gb(self, gb: float) -> None:
        with self._lock:
            self._disk_budget_gb_override = max(0.1, min(64.0, float(gb)))
        self._evict_disk_if_needed()

    def _safe_seg(self, s: str) -> str:
        return "".join(c for c in str(s) if c.isalnum() or c in ("_", "-"))[:48] or "x"

    def _pcm_disk_path(self, synth_fp: str, tile_idx: int) -> Path:
        return self.cache_dir / "pcm" / self._safe_seg(synth_fp) / f"t{int(tile_idx):05d}.npz"

    def _stem_disk_path(self, cook_fp: str, tile_idx: int) -> Path:
        return self.cache_dir / "stems" / self._safe_seg(cook_fp) / f"t{int(tile_idx):05d}.npz"

    def _enforce_ram_budget_locked(self) -> None:
        budget = self.ram_budget_bytes
        # Evict oldest PCM tiles first, then oldest Level-1 analysis entries until under budget
        while self._ram_bytes > budget and (self._pcm_ram or self._analysis_ram):
            if self._analysis_ram and (len(self._analysis_ram) > len(self._pcm_ram) or not self._pcm_ram):
                _, (_, nb) = self._analysis_ram.popitem(last=False)
                self._ram_bytes = max(0, self._ram_bytes - nb)
            elif self._pcm_ram:
                _, item = self._pcm_ram.popitem(last=False)
                self._ram_bytes = max(0, self._ram_bytes - item.nbytes)

    # --- Level-1 Analysis / Stem Tile API ---

    def get_analysis(
        self,
        cook_fp: str,
        tile_idx: int,
        *,
        deserialize_fn: Optional[Callable[[Dict[str, np.ndarray]], Any]] = None,
    ) -> Optional[Any]:
        key = (str(cook_fp), int(tile_idx))
        with self._lock:
            hit = self._analysis_ram.get(key)
            if hit is not None:
                self._analysis_ram.move_to_end(key)
                return hit[0]

        if deserialize_fn is None:
            return None
        path = self._stem_disk_path(cook_fp, tile_idx)
        if not path.is_file():
            return None
        try:
            now = time.time()
            os.utime(path, (now, now))
            with np.load(path, allow_pickle=False) as data:
                arrays = {k: np.asarray(data[k], dtype=np.float32) for k in data.files}
            art = deserialize_fn(arrays)
            if art is not None:
                self.put_analysis(cook_fp, tile_idx, art, serialize_fn=None)
            return art
        except Exception as exc:
            logger.debug("Corrupt tile stem cache %s removed: %s", path, exc)
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            return None

    def put_analysis(
        self,
        cook_fp: str,
        tile_idx: int,
        analysis: Any,
        *,
        serialize_fn: Optional[Callable[[Any], Optional[Dict[str, np.ndarray]]]] = None,
    ) -> None:
        key = (str(cook_fp), int(tile_idx))
        nb = _estimate_object_bytes(analysis)
        with self._lock:
            prev = self._analysis_ram.pop(key, None)
            if prev is not None:
                self._ram_bytes = max(0, self._ram_bytes - prev[1])
            self._analysis_ram[key] = (analysis, nb)
            self._ram_bytes += nb
            self._enforce_ram_budget_locked()

        if serialize_fn is not None:
            arrays = serialize_fn(analysis)
            if arrays:
                self._write_npz_atomic(
                    self._stem_disk_path(cook_fp, tile_idx),
                    {k: np.asarray(v, dtype=np.float16) for k, v in arrays.items()},
                )

    # --- Level-2 Synthesized PCM Tile API ---

    def get_pcm_tile(self, synth_fp: str, tile_idx: int) -> Optional[CachedTileResult]:
        key = (str(synth_fp), int(tile_idx))
        with self._lock:
            hit = self._pcm_ram.get(key)
            if hit is not None:
                self._pcm_ram.move_to_end(key)
                return hit

        path = self._pcm_disk_path(synth_fp, tile_idx)
        if not path.is_file():
            return None
        try:
            now = time.time()
            os.utime(path, (now, now))
            with np.load(path, allow_pickle=False) as data:
                pcm = np.asarray(data["pcm"], dtype=np.float32)
                peaks = np.asarray(data["peaks"], dtype=np.float32)
                tier = int(data["meta"][0]) if "meta" in data.files else TIER_FAST_DSP
            res = CachedTileResult(
                pcm=pcm,
                peaks=peaks,
                tier=tier,
                generation=1,
                nbytes=int(pcm.nbytes + peaks.nbytes),
            )
            with self._lock:
                self._pcm_ram[key] = res
                self._ram_bytes += res.nbytes
                self._enforce_ram_budget_locked()
            return res
        except Exception as exc:
            logger.debug("Corrupt tile pcm cache %s removed: %s", path, exc)
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            return None

    def put_pcm_tile(
        self,
        synth_fp: str,
        tile_idx: int,
        pcm: np.ndarray,
        peaks: np.ndarray,
        *,
        tier: int,
        generation: int = 1,
        persist_disk: bool = True,
    ) -> CachedTileResult:
        pcm_f32 = np.ascontiguousarray(pcm, dtype=np.float32)
        peaks_f32 = np.ascontiguousarray(peaks, dtype=np.float32)
        res = CachedTileResult(
            pcm=pcm_f32,
            peaks=peaks_f32,
            tier=int(tier),
            generation=int(generation),
            nbytes=int(pcm_f32.nbytes + peaks_f32.nbytes),
        )
        key = (str(synth_fp), int(tile_idx))
        with self._lock:
            prev = self._pcm_ram.pop(key, None)
            if prev is not None:
                self._ram_bytes = max(0, self._ram_bytes - prev.nbytes)
            self._pcm_ram[key] = res
            self._ram_bytes += res.nbytes
            self._enforce_ram_budget_locked()

        if persist_disk:
            # Float32 PCM on disk keeps zero quantization noise for denoised playback
            self._write_npz_atomic(
                self._pcm_disk_path(synth_fp, tile_idx),
                {
                    "pcm": pcm_f32,
                    "peaks": peaks_f32,
                    "meta": np.array([int(tier)], dtype=np.int32),
                },
            )
        return res

    def _write_npz_atomic(self, path: Path, arrays: Dict[str, np.ndarray]) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp.npz")
            np.savez(tmp, **arrays)
            os.replace(tmp, path)
            self._evict_disk_if_needed()
        except Exception as exc:
            logger.debug("Tile disk spill skipped (%s): %s", path, exc)

    def _evict_disk_if_needed(self) -> None:
        root = self.cache_dir
        if not root.is_dir():
            return
        max_b = self.disk_budget_bytes
        entries: List[Tuple[float, int, Path]] = []
        total = 0
        for p in root.rglob("*.npz"):
            try:
                st = p.stat()
                total += st.st_size
                entries.append((st.st_mtime, st.st_size, p))
            except OSError:
                continue
        if total <= max_b:
            return
        entries.sort(key=lambda item: item[0])
        for _mtime, sz, p in entries:
            if total <= max_b:
                break
            try:
                p.unlink(missing_ok=True)
                total -= sz
            except OSError:
                pass

    def clear(self) -> None:
        with self._lock:
            self._analysis_ram.clear()
            self._pcm_ram.clear()
            self._ram_bytes = 0
        root = self.cache_dir
        if root.is_dir():
            for p in root.rglob("*.npz"):
                try:
                    p.unlink(missing_ok=True)
                except OSError:
                    pass

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            ram_mb = round(self._ram_bytes / (1024.0 * 1024.0), 2)
            ram_budget_mb = round(self.ram_budget_bytes / (1024.0 * 1024.0), 1)
            ram_entries = len(self._pcm_ram) + len(self._analysis_ram)
        disk_bytes = 0
        disk_entries = 0
        root = self.cache_dir
        if root.is_dir():
            for p in root.rglob("*.npz"):
                try:
                    disk_bytes += p.stat().st_size
                    disk_entries += 1
                except OSError:
                    continue
        return {
            "ram_used_mb": ram_mb,
            "ram_budget_mb": ram_budget_mb,
            "disk_used_mb": round(disk_bytes / (1024.0 * 1024.0), 2),
            "disk_budget_gb": round(self.disk_budget_bytes / (1024.0 ** 3), 2),
            "ram_entries": ram_entries,
            "disk_entries": disk_entries,
        }


@dataclass
class PeakPyramid:
    """Fine-grained (up to 100 cols/sec) interleaved min/max peak pyramid for instant zoom queries."""

    filepath: str
    duration_sec: float
    sample_rate: int
    total_frames: int
    peaks_per_sec: float
    mins: np.ndarray  # (K,) float32
    maxs: np.ndarray  # (K,) float32

    def query(self, start_sec: float, end_sec: float, columns: int) -> List[float]:
        cols = max(1, int(columns))
        k = int(self.mins.shape[0])
        if k == 0 or self.duration_sec <= 0.0:
            return []
        s_sec = max(0.0, min(self.duration_sec, float(start_sec)))
        e_sec = max(s_sec + 1e-4, min(self.duration_sec, float(end_sec)))
        s_idx = int(math.floor((s_sec / self.duration_sec) * k))
        e_idx = max(s_idx + 1, int(math.ceil((e_sec / self.duration_sec) * k)))
        s_idx = max(0, min(k - 1, s_idx))
        e_idx = max(s_idx + 1, min(k, e_idx))

        sub_min = self.mins[s_idx:e_idx]
        sub_max = self.maxs[s_idx:e_idx]
        n = int(sub_min.shape[0])
        if n <= 0:
            return []

        if n <= cols:
            # Upsample linearly/nearest when zoomed in tighter than pyramid grid
            idx = np.linspace(0, n - 1, cols).astype(np.int32)
            out = np.empty(cols * 2, dtype=np.float32)
            out[0::2] = np.round(sub_min[idx], 4)
            out[1::2] = np.round(sub_max[idx], 4)
            return out.tolist()

        # Fast vectorized bin reduction
        edges = np.linspace(0, n, cols + 1, dtype=np.int32)
        starts = edges[:-1]
        out_min = np.minimum.reduceat(sub_min, starts)
        out_max = np.maximum.reduceat(sub_max, starts)
        out = np.empty(cols * 2, dtype=np.float32)
        out[0::2] = np.round(out_min, 4)
        out[1::2] = np.round(out_max, 4)
        return out.tolist()


class PeakPyramidCache:
    """Fast streaming raw waveform peak scanner + disk cache for 1h+ files (<250ms scan, <2ms cached)."""

    def __init__(self, cache_dir: Optional[Path] = None, max_ram_entries: int = 24) -> None:
        self._dir_override = cache_dir
        self._max_ram = max(4, int(max_ram_entries))
        self._lock = threading.RLock()
        self._ram: OrderedDict[str, PeakPyramid] = OrderedDict()

    @property
    def cache_dir(self) -> Path:
        base = self._dir_override if self._dir_override is not None else get_env_config().dsp_cache_dir
        return Path(base) / "peaks"

    @staticmethod
    def _file_sig_key(filepath: str) -> str:
        p = Path(filepath).resolve()
        try:
            st = p.stat()
            raw = f"{p}|{st.st_mtime_ns}|{st.st_size}"
        except OSError:
            raw = str(p)
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]

    def get_or_build(self, filepath: str, *, target_peaks_per_sec: float = 50.0) -> Optional[PeakPyramid]:
        if not filepath or not os.path.isfile(filepath):
            return None
        key = self._file_sig_key(filepath)
        with self._lock:
            cached = self._ram.get(key)
            if cached is not None:
                self._ram.move_to_end(key)
                return cached

        disk_path = self.cache_dir / f"{key}.npz"
        if disk_path.is_file():
            try:
                with np.load(disk_path, allow_pickle=False) as d:
                    meta = d["meta"]
                    pyr = PeakPyramid(
                        filepath=str(filepath),
                        duration_sec=float(meta[0]),
                        sample_rate=int(meta[1]),
                        total_frames=int(meta[2]),
                        peaks_per_sec=float(meta[3]),
                        mins=np.asarray(d["mins"], dtype=np.float32),
                        maxs=np.asarray(d["maxs"], dtype=np.float32),
                    )
                self._store_ram(key, pyr)
                return pyr
            except Exception:
                try:
                    disk_path.unlink(missing_ok=True)
                except OSError:
                    pass

        pyr = self._scan_file_streaming(filepath, target_peaks_per_sec=target_peaks_per_sec)
        if pyr is None:
            return None
        self._store_ram(key, pyr)
        try:
            disk_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = disk_path.with_suffix(".tmp.npz")
            np.savez(
                tmp,
                mins=pyr.mins.astype(np.float16),
                maxs=pyr.maxs.astype(np.float16),
                meta=np.array([pyr.duration_sec, pyr.sample_rate, pyr.total_frames, pyr.peaks_per_sec], dtype=np.float64),
            )
            os.replace(tmp, disk_path)
        except Exception as exc:
            logger.debug("Peak pyramid disk write skipped: %s", exc)
        return pyr

    def _store_ram(self, key: str, pyr: PeakPyramid) -> None:
        with self._lock:
            self._ram[key] = pyr
            self._ram.move_to_end(key)
            while len(self._ram) > self._max_ram:
                self._ram.popitem(last=False)

    def scan_quick_overview(
        self,
        filepath: str,
        start_sec: float = 0.0,
        end_sec: float = 0.0,
        columns: int = 512,
    ) -> Optional[Tuple[List[float], float]]:
        """Ultra-fast (<90-350ms) raw peak overview for `[start_sec..end_sec]` even on 1h+ MP3/WAV files.

        - If span <= 90s: single seek + sequential streaming read (100% sample-accurate, <90ms).
        - If span > 90s: at most `min(columns, 512)` short probes (<= 350ms even on 40m MP3!).
        Returns `(interleaved_peaks, file_duration_sec)`.
        """
        if not filepath or not os.path.isfile(filepath):
            return None
        # Instant hit if full multi-res pyramid is already cached in RAM or disk!
        key = self._file_sig_key(filepath)
        with self._lock:
            cached = self._ram.get(key)
        if cached is not None:
            e = end_sec if end_sec > start_sec else cached.duration_sec
            return cached.query(start_sec, e, columns), cached.duration_sec

        try:
            with sf.SoundFile(filepath, mode="r") as f:
                sr = int(f.samplerate or 48000)
                total_frames = int(len(f))
                if total_frames <= 0 or sr <= 0:
                    return None
                file_dur = float(total_frames) / float(sr)
                s_sec = max(0.0, min(file_dur, float(start_sec)))
                e_sec = file_dur if end_sec <= s_sec else max(s_sec + 1e-3, min(file_dur, float(end_sec)))
                span_sec = e_sec - s_sec
                s_frame = max(0, min(total_frames - 1, int(round(s_sec * sr))))
                e_frame = max(s_frame + 1, min(total_frames, int(round(e_sec * sr))))
                span_frames = e_frame - s_frame
                cols = max(16, min(1024, int(columns or 512)))

                if span_sec <= 95.0:
                    # Single seek + fast sequential streaming read (~50-90ms for 64s MP3!)
                    f.seek(s_frame)
                    frames_per_col = max(1, span_frames // cols)
                    actual_cols = max(1, min(cols, span_frames // frames_per_col))
                    mins = np.zeros(actual_cols, dtype=np.float32)
                    maxs = np.zeros(actual_cols, dtype=np.float32)
                    cols_per_blk = max(1, 131072 // frames_per_col)
                    blk_frames = cols_per_blk * frames_per_col
                    ci = 0
                    rem = span_frames
                    while ci < actual_cols and rem > 0:
                        chunk = f.read(min(rem, blk_frames), dtype="float32", always_2d=True)
                        if chunk.size == 0:
                            break
                        rem -= len(chunk)
                        mono = chunk.mean(axis=1) if chunk.shape[1] > 1 else chunk[:, 0]
                        n_c = min(actual_cols - ci, len(mono) // frames_per_col)
                        if n_c > 0:
                            mat = mono[: n_c * frames_per_col].reshape(n_c, frames_per_col)
                            mins[ci : ci + n_c] = mat.min(axis=1)
                            maxs[ci : ci + n_c] = mat.max(axis=1)
                            ci += n_c
                        elif ci < actual_cols and len(mono) > 0:
                            mins[ci] = float(mono.min())
                            maxs[ci] = float(mono.max())
                            ci += 1
                            break
                    out = np.empty(actual_cols * 2, dtype=np.float32)
                    out[0::2] = np.round(mins, 4)
                    out[1::2] = np.round(maxs, 4)
                    return out.tolist(), file_dur

                # Long span (>95s): capped <= 512 short probes (~300ms even on 1h MP3!)
                n_probes = min(cols, 512)
                step = max(1, span_frames // n_probes)
                probe_len = min(step, 1024)
                out = np.empty(n_probes * 2, dtype=np.float32)
                for i in range(n_probes):
                    pos = min(total_frames - 1, s_frame + i * step)
                    f.seek(pos)
                    chunk = f.read(probe_len, dtype="float32", always_2d=True)
                    if chunk.size == 0:
                        out[i * 2] = 0.0
                        out[i * 2 + 1] = 0.0
                        continue
                    mono = chunk.mean(axis=1) if chunk.shape[1] > 1 else chunk[:, 0]
                    out[i * 2] = round(float(mono.min()), 4)
                    out[i * 2 + 1] = round(float(mono.max()), 4)
                return out.tolist(), file_dur
        except Exception as exc:
            logger.debug("Quick overview peak scan failed for %s: %s", filepath, exc)
            return None

    def _scan_file_streaming(self, filepath: str, *, target_peaks_per_sec: float = 20.0) -> Optional[PeakPyramid]:
        """Single sequential streaming pass (ZERO seeks!) into <= 32k bins (~2s for 40m MP3, ~0.3s for WAV)."""
        try:
            with sf.SoundFile(filepath, mode="r") as f:
                sr = int(f.samplerate or 48000)
                total_frames = int(len(f))
                if total_frames <= 0 or sr <= 0:
                    return None
                duration_sec = float(total_frames) / float(sr)
                max_bins = 32_768
                total_bins = max(512, min(max_bins, int(math.ceil(duration_sec * target_peaks_per_sec))))
                frames_per_bin = max(1, total_frames // total_bins)
                actual_bins = max(1, total_frames // frames_per_bin)
                mins = np.zeros(actual_bins, dtype=np.float32)
                maxs = np.zeros(actual_bins, dtype=np.float32)

                bins_per_block = max(1, 262144 // frames_per_bin)
                block_frames = bins_per_block * frames_per_bin
                bi = 0
                decoded_frames = 0
                while bi < actual_bins:
                    chunk = f.read(block_frames, dtype="float32", always_2d=True)
                    if chunk.size == 0:
                        break
                    decoded_frames += int(chunk.shape[0])
                    mono = chunk.mean(axis=1) if chunk.shape[1] > 1 else chunk[:, 0]
                    n_complete = min(actual_bins - bi, int(mono.shape[0]) // frames_per_bin)
                    if n_complete > 0:
                        mat = mono[: n_complete * frames_per_bin].reshape(n_complete, frames_per_bin)
                        mins[bi : bi + n_complete] = mat.min(axis=1)
                        maxs[bi : bi + n_complete] = mat.max(axis=1)
                        bi += n_complete
                    else:
                        if bi < actual_bins and mono.shape[0] > 0:
                            mins[bi] = float(mono.min())
                            maxs[bi] = float(mono.max())
                            bi += 1
                        break

                if bi < actual_bins and bi > 0:
                    mins = mins[:bi]
                    maxs = maxs[:bi]
                    actual_bins = bi
                eff_frames = decoded_frames if decoded_frames > 0 else total_frames
                eff_dur = float(eff_frames) / float(sr)
                return PeakPyramid(
                    filepath=str(filepath),
                    duration_sec=eff_dur,
                    sample_rate=sr,
                    total_frames=eff_frames,
                    peaks_per_sec=float(actual_bins) / max(1e-6, eff_dur),
                    mins=mins,
                    maxs=maxs,
                )
        except Exception as exc:
            logger.debug("Peak pyramid scan failed for %s: %s", filepath, exc)
            return None


class TiledWaveformOverlay:
    """Combines a base `PeakPyramid` (or quick raw overview) with live per-tile cooked post-FX peaks
    and tier states in TIMELINE coordinates (accounting for `crop_start_sec`, `playback_rate`, and
    `timeline_duration_sec`) for instant zoomed & dual-color transport bar queries.
    """

    def __init__(
        self,
        base_pyramid: Optional[PeakPyramid],
        duration_sec: float,
        tile_sec: float,
        num_tiles: int,
        *,
        crop_start_sec: float = 0.0,
        playback_rate: float = 1.0,
        file_duration_sec: Optional[float] = None,
        tile_time_scale: float = 1.0,
    ) -> None:
        self._lock = threading.RLock()
        self.base_pyramid = base_pyramid
        self.quick_raw_peaks: Optional[List[float]] = None
        self.duration_sec = max(0.0, float(duration_sec))  # active TIMELINE duration
        self.file_duration_sec = max(self.duration_sec, float(file_duration_sec or duration_sec))
        self.crop_start_sec = max(0.0, float(crop_start_sec))
        self.playback_rate = max(0.05, float(playback_rate or 1.0))
        self.tile_time_scale = max(1e-4, float(tile_time_scale or 1.0))
        self.tile_sec = max(0.5, float(tile_sec))
        self.num_tiles = max(1, int(num_tiles))
        # tile_idx -> (tier_int, is_stale_bool, interleaved_peaks_f32)
        self._tiles: Dict[int, Tuple[int, bool, Optional[np.ndarray]]] = {}

    def update_window(
        self,
        *,
        crop_start_sec: float,
        playback_rate: float,
        timeline_duration_sec: float,
        tile_time_scale: Optional[float] = None,
    ) -> None:
        with self._lock:
            self.crop_start_sec = max(0.0, float(crop_start_sec))
            self.playback_rate = max(0.05, float(playback_rate or 1.0))
            self.duration_sec = max(0.0, float(timeline_duration_sec))
            if tile_time_scale is not None:
                self.tile_time_scale = max(1e-4, float(tile_time_scale))
            self.quick_raw_peaks = None

    def set_quick_raw_peaks(self, peaks: List[float]) -> None:
        with self._lock:
            self.quick_raw_peaks = list(peaks) if peaks else None

    def tile_to_timeline_span(self, tile_idx: int) -> Optional[Tuple[float, float]]:
        """Map tile `tile_idx` into clamped timeline `[tl_start, tl_end]`, or None if outside active timeline."""
        with self._lock:
            dur = self.duration_sec
            if dur <= 0.0:
                return None
            scale = self.tile_time_scale
            tile_total_dur = self.file_duration_sec * scale
            tile_s0 = float(tile_idx) * self.tile_sec
            tile_s1 = min(tile_total_dur, float(tile_idx + 1) * self.tile_sec)
            crop_t = self.crop_start_sec * scale
            rate_t = max(1e-4, self.playback_rate * scale)
            tl_s0 = (tile_s0 - crop_t) / rate_t
            tl_s1 = (tile_s1 - crop_t) / rate_t
            clamped_s0 = max(0.0, tl_s0)
            clamped_s1 = min(dur, tl_s1)
            if clamped_s1 <= clamped_s0 + 1e-4:
                return None
            return clamped_s0, clamped_s1

    def set_tile(self, tile_idx: int, tier: int, peaks: Optional[np.ndarray], *, stale: bool = False) -> None:
        with self._lock:
            self._tiles[int(tile_idx)] = (int(tier), bool(stale), peaks)

    def mark_all_stale(self) -> None:
        with self._lock:
            for tidx, (tier, _st, peaks) in list(self._tiles.items()):
                if tier != TIER_RAW:
                    self._tiles[tidx] = (tier, True, peaks)

    def clear_tiles(self) -> None:
        with self._lock:
            self._tiles.clear()

    def coverage_summary(self) -> Dict[str, Any]:
        with self._lock:
            fast = 0
            ml = 0
            stale = 0
            # Count active timeline tiles in tile-space seconds
            scale = self.tile_time_scale
            crop_t = self.crop_start_sec * scale
            rate_t = max(1e-4, self.playback_rate * scale)
            min_t = max(0, min(self.num_tiles - 1, int(math.floor(crop_t / self.tile_sec))))
            max_tile_t = crop_t + self.duration_sec * rate_t
            max_t = max(min_t, min(self.num_tiles - 1, int(math.floor(max(0.0, max_tile_t - 1e-4) / self.tile_sec))))
            active_total = max(1, max_t - min_t + 1)
            for tidx, (tier, is_st, _) in self._tiles.items():
                if tidx < min_t or tidx > max_t:
                    continue
                if is_st:
                    stale += 1
                elif tier == TIER_COMPLEX_ML:
                    ml += 1
                elif tier == TIER_FAST_DSP:
                    fast += 1
            return {
                "num_tiles": active_total,
                "tile_sec": self.tile_sec,
                "fast_tiles": fast,
                "ml_tiles": ml,
                "stale_tiles": stale,
            }

    def query_viewport(self, start_sec: float, end_sec: float, columns: int) -> Tuple[List[float], List[int]]:
        """Query `[start_sec..end_sec]` in TIMELINE seconds, mapping cleanly through `crop_start_sec`, `playback_rate` & `tile_time_scale`."""
        cols = max(1, int(columns))
        with self._lock:
            dur = self.duration_sec
            crop_s = self.crop_start_sec
            rate = self.playback_rate
            scale = self.tile_time_scale
            pyr = self.base_pyramid
            quick_raw = self.quick_raw_peaks
            file_dur = self.file_duration_sec

        if dur <= 0.0:
            return [], []
        s_tl = max(0.0, min(dur, float(start_sec)))
        e_tl = max(s_tl + 1e-4, min(dur, float(end_sec)))

        src_s0 = crop_s + s_tl * rate
        src_s1 = crop_s + e_tl * rate

        if pyr is not None:
            raw_peaks = pyr.query(src_s0, src_s1, cols)
        elif quick_raw and len(quick_raw) >= 2:
            # Downsample/slice quick overview peaks to requested timeline viewport
            q_pairs = len(quick_raw) // 2
            q_arr = np.asarray(quick_raw, dtype=np.float32)
            raw_peaks = []
            for col in range(cols):
                u0 = (s_tl + (col / float(cols)) * (e_tl - s_tl)) / dur
                u1 = (s_tl + ((col + 1) / float(cols)) * (e_tl - s_tl)) / dur
                i0 = max(0, min(q_pairs - 1, int(math.floor(u0 * q_pairs))))
                i1 = max(i0 + 1, min(q_pairs, int(math.ceil(u1 * q_pairs))))
                raw_peaks.append(round(float(np.min(q_arr[i0 * 2 : i1 * 2 : 2])), 4))
                raw_peaks.append(round(float(np.max(q_arr[i0 * 2 + 1 : i1 * 2 : 2])), 4))
        else:
            raw_peaks = [0.0] * (cols * 2)

        if len(raw_peaks) < cols * 2:
            raw_peaks = raw_peaks + [0.0] * (cols * 2 - len(raw_peaks))

        tiers = [TIER_RAW] * cols
        tile_s0 = src_s0 * scale
        tile_s1 = src_s1 * scale
        tile_span = max(1e-4, tile_s1 - tile_s0)
        tile_total_dur = file_dur * scale
        with self._lock:
            if not self._tiles:
                return raw_peaks[: cols * 2], tiers
            for col in range(cols):
                c0 = tile_s0 + (col / float(cols)) * tile_span
                c1 = tile_s0 + ((col + 1) / float(cols)) * tile_span
                t0 = max(0, min(self.num_tiles - 1, int(math.floor(c0 / self.tile_sec))))
                t1 = max(t0, min(self.num_tiles - 1, int(math.floor(max(c0, c1 - 1e-6) / self.tile_sec))))

                best_tier = TIER_RAW
                any_stale = False
                override_min: Optional[float] = None
                override_max: Optional[float] = None

                for tidx in range(t0, t1 + 1):
                    entry = self._tiles.get(tidx)
                    if entry is None:
                        continue
                    t_tier, t_stale, t_peaks = entry
                    if t_stale:
                        any_stale = True
                    elif t_tier > best_tier:
                        best_tier = t_tier

                    if t_peaks is not None and t_peaks.size >= 2:
                        tile_start = tidx * self.tile_sec
                        tile_end = min(tile_total_dur, (tidx + 1) * self.tile_sec)
                        tile_dur = max(1e-4, tile_end - tile_start)
                        n_pairs = int(t_peaks.size // 2)
                        u0 = max(0.0, min(1.0, (c0 - tile_start) / tile_dur))
                        u1 = max(u0, min(1.0, (c1 - tile_start) / tile_dur))
                        p0 = max(0, min(n_pairs - 1, int(math.floor(u0 * n_pairs))))
                        p1 = max(p0 + 1, min(n_pairs, int(math.ceil(u1 * n_pairs))))
                        sl_min = float(np.min(t_peaks[p0 * 2 : p1 * 2 : 2]))
                        sl_max = float(np.max(t_peaks[p0 * 2 + 1 : p1 * 2 : 2]))
                        override_min = sl_min if override_min is None else min(override_min, sl_min)
                        override_max = sl_max if override_max is None else max(override_max, sl_max)

                if best_tier == TIER_RAW and any_stale:
                    tiers[col] = TIER_STALE
                elif any_stale and best_tier < TIER_COMPLEX_ML:
                    tiers[col] = TIER_STALE
                else:
                    tiers[col] = best_tier

                if override_min is not None and override_max is not None:
                    raw_peaks[col * 2] = round(override_min, 4)
                    raw_peaks[col * 2 + 1] = round(override_max, 4)

        return raw_peaks[: cols * 2], tiers


GLOBAL_TILE_CACHE = HybridTileCache()
GLOBAL_PEAK_PYRAMID_CACHE = PeakPyramidCache()

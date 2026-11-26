"""Preamp & ADC floor noise profiles (built-in analytical priors + GAIA custom calibration JSONs).

SIN reads profiles strictly read-only from `.gaia/profiles/preamp_profiles/`.
GAIA owns creating/writing custom hardware calibration profiles via `calibrate_preamp_from_wav()`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
from scipy import signal
import soundfile as sf

from core.env_config import get_env_config
from core.processors.chunked_inference import ensure_stereo_f32

logger = logging.getLogger("sin.processors.preamp_profiles")

PREAMP_PROFILE_SCHEMA = "gaia-preamp-profile-v1"
VALID_TOPOLOGIES = frozenset({"mono_or_dual_mono", "coincident_xy_stereo", "spaced_stereo"})
_SAFE_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")


@dataclass(frozen=True)
class SpurSpec:
    freq_hz: float
    q: float = 45.0
    max_cut_db: float = 16.0


@dataclass(frozen=True)
class PreampProfile:
    id: str
    label: str
    device_family: str
    default_topology: str  # mono_or_dual_mono | coincident_xy_stereo | spaced_stereo
    flicker_corner_hz: float
    flicker_slope: float
    description: str = ""
    builtin: bool = True
    sample_rate: int = 48000
    fft_size: int = 2048
    calibrated_gain_setting: Optional[float] = None
    psd_l_db: Optional[Tuple[float, ...]] = None
    psd_r_db: Optional[Tuple[float, ...]] = None
    spurs: Tuple[SpurSpec, ...] = field(default_factory=tuple)
    source_path: Optional[str] = None

    def to_public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "device_family": self.device_family,
            "default_topology": self.default_topology,
            "flicker_corner_hz": self.flicker_corner_hz,
            "flicker_slope": self.flicker_slope,
            "description": self.description,
            "builtin": self.builtin,
            "calibrated": bool(self.psd_l_db),
            "calibrated_gain_setting": self.calibrated_gain_setting,
            "spurs": [{"freq_hz": s.freq_hz, "q": s.q, "max_cut_db": s.max_cut_db} for s in self.spurs],
            "source_path": self.source_path,
        }


BUILTIN_PREAMP_PROFILES: Dict[str, PreampProfile] = {
    "generic_adc": PreampProfile(
        id="generic_adc",
        label="Generic Preamp / ADC Floor",
        device_family="generic",
        default_topology="mono_or_dual_mono",
        flicker_corner_hz=160.0,
        flicker_slope=1.05,
        description="Universal broadband thermal + 1/f preamp floor model for mics, DI, and line inputs.",
    ),
    "usb_interface": PreampProfile(
        id="usb_interface",
        label="USB Audio Interface / Soundcard",
        device_family="interface",
        default_topology="mono_or_dual_mono",
        flicker_corner_hz=140.0,
        flicker_slope=1.0,
        description="Tuned for USB/PCIe audio interfaces with 50/60 Hz mains hum and 1 kHz USB packet buzz watch.",
        spurs=(
            SpurSpec(50.0, 40.0, 14.0),
            SpurSpec(60.0, 40.0, 14.0),
            SpurSpec(100.0, 45.0, 12.0),
            SpurSpec(120.0, 45.0, 12.0),
            SpurSpec(1000.0, 50.0, 16.0),
            SpurSpec(2000.0, 50.0, 14.0),
            SpurSpec(3000.0, 50.0, 12.0),
        ),
    ),
    "zoom_h4": PreampProfile(
        id="zoom_h4",
        label="Zoom H4 (Original X/Y)",
        device_family="zoom_h4",
        default_topology="coincident_xy_stereo",
        flicker_corner_hz=300.0,
        flicker_slope=1.25,
        description="Original Zoom H4 handheld recorder: higher thermal/1f preamp floor + coincident X/Y coherence.",
        spurs=(
            SpurSpec(1000.0, 45.0, 18.0),
            SpurSpec(2000.0, 45.0, 14.0),
            SpurSpec(4000.0, 45.0, 12.0),
        ),
    ),
    "zoom_h4n": PreampProfile(
        id="zoom_h4n",
        label="Zoom H4n (X/Y Capsules)",
        device_family="zoom_h4",
        default_topology="coincident_xy_stereo",
        flicker_corner_hz=280.0,
        flicker_slope=1.20,
        description="Zoom H4n handheld recorder: pronounced high-gain hiss + LCD/SD spur watch + coincident X/Y.",
        spurs=(
            SpurSpec(1000.0, 45.0, 18.0),
            SpurSpec(2000.0, 45.0, 14.0),
            SpurSpec(4000.0, 45.0, 12.0),
        ),
    ),
    "zoom_h4n_pro": PreampProfile(
        id="zoom_h4n_pro",
        label="Zoom H4n Pro (X/Y Capsules)",
        device_family="zoom_h4",
        default_topology="coincident_xy_stereo",
        flicker_corner_hz=220.0,
        flicker_slope=1.12,
        description="Zoom H4n Pro (-120 dBu EIN preamps): balanced thermal + 1/f shelf with coincident X/Y coherence.",
        spurs=(
            SpurSpec(1000.0, 50.0, 14.0),
        ),
    ),
    "zoom_h4essential": PreampProfile(
        id="zoom_h4essential",
        label="Zoom H4essential (32-bit Float X/Y)",
        device_family="zoom_h4",
        default_topology="coincident_xy_stereo",
        flicker_corner_hz=150.0,
        flicker_slope=1.05,
        description="Zoom H4essential dual-ADC field recorder: low flicker corner + coincident X/Y coherence.",
    ),
}


def preamp_profiles_directory(override_dir: Optional[Path | str] = None) -> Path:
    if override_dir is not None:
        return Path(override_dir).resolve()
    return get_env_config().preamp_profiles_dir


def _load_custom_profile_file(path: Path) -> Optional[PreampProfile]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        if raw.get("schema") != PREAMP_PROFILE_SCHEMA:
            return None
        pid = str(raw.get("id") or path.stem).strip().lower()
        if not pid:
            return None
        topo = str(raw.get("default_topology") or (
            "coincident_xy_stereo" if raw.get("coincident_stereo") else "mono_or_dual_mono"
        )).strip().lower()
        if topo not in VALID_TOPOLOGIES:
            topo = "mono_or_dual_mono"
        spurs = tuple(
            SpurSpec(
                freq_hz=float(s["freq_hz"]),
                q=float(s.get("q", 45.0)),
                max_cut_db=float(s.get("max_cut_db", 16.0)),
            )
            for s in (raw.get("spurs") or [])
            if isinstance(s, dict) and s.get("freq_hz") is not None
        )
        psd_l = tuple(float(v) for v in raw["psd_l_db"]) if isinstance(raw.get("psd_l_db"), list) else None
        psd_r = tuple(float(v) for v in raw["psd_r_db"]) if isinstance(raw.get("psd_r_db"), list) else psd_l
        return PreampProfile(
            id=pid,
            label=str(raw.get("label") or pid),
            device_family=str(raw.get("device_family") or raw.get("recorder_profile_id") or "custom"),
            default_topology=topo,
            flicker_corner_hz=float(raw.get("flicker_corner_hz", 200.0)),
            flicker_slope=float(raw.get("flicker_slope", 1.1)),
            description=str(raw.get("description") or "User-calibrated hardware preamp noise profile."),
            builtin=False,
            sample_rate=int(raw.get("sample_rate", 48000)),
            fft_size=int(raw.get("fft_size", 2048)),
            calibrated_gain_setting=(
                float(raw["calibrated_gain_setting"])
                if raw.get("calibrated_gain_setting") is not None
                else None
            ),
            psd_l_db=psd_l,
            psd_r_db=psd_r,
            spurs=spurs,
            source_path=str(path.resolve()),
        )
    except Exception as exc:
        logger.warning("Skipping invalid preamp profile %s: %s", path, exc)
        return None


def list_preamp_profiles(profiles_dir: Optional[Path | str] = None) -> List[PreampProfile]:
    """Return built-in profiles merged with read-only user-calibrated profiles in `.gaia/profiles/preamp_profiles/`."""
    merged: Dict[str, PreampProfile] = dict(BUILTIN_PREAMP_PROFILES)
    pdir = preamp_profiles_directory(profiles_dir)
    if pdir.is_dir():
        for json_file in sorted(pdir.glob("*.json")):
            prof = _load_custom_profile_file(json_file)
            if prof is not None:
                merged[prof.id] = prof
    # Custom calibrated profiles first (if any), then built-ins in canonical order
    customs = [p for p in merged.values() if not p.builtin]
    builtins = [merged[k] for k in BUILTIN_PREAMP_PROFILES if k in merged and merged[k].builtin]
    return customs + builtins


def get_preamp_profile(
    profile_id: Optional[str],
    profiles_dir: Optional[Path | str] = None,
) -> PreampProfile:
    pid = str(profile_id or "generic_adc").strip().lower()
    for prof in list_preamp_profiles(profiles_dir):
        if prof.id == pid:
            return prof
    return BUILTIN_PREAMP_PROFILES["generic_adc"]


def evaluate_profile_psd(
    profile: PreampProfile,
    freqs_hz: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    """Return relative linear power spectral density shape `(psd_l, psd_r)` normalized to ~1.0 at 1 kHz."""
    f = np.asarray(freqs_hz, dtype=np.float64)
    if profile.psd_l_db and len(profile.psd_l_db) >= 16:
        src_freqs = np.linspace(0.0, float(profile.sample_rate) * 0.5, len(profile.psd_l_db), dtype=np.float64)
        l_db = np.interp(f, src_freqs, np.asarray(profile.psd_l_db, dtype=np.float64))
        r_src = profile.psd_r_db if profile.psd_r_db and len(profile.psd_r_db) == len(profile.psd_l_db) else profile.psd_l_db
        r_db = np.interp(f, src_freqs, np.asarray(r_src, dtype=np.float64))
        psd_l = np.power(10.0, np.clip(l_db, -60.0, 60.0) / 10.0)
        psd_r = np.power(10.0, np.clip(r_db, -60.0, 60.0) / 10.0)
    else:
        f_safe = np.maximum(f, 15.0)
        fc = max(20.0, float(profile.flicker_corner_hz))
        alpha = max(0.2, min(2.5, float(profile.flicker_slope)))
        shape = 1.0 + np.power(fc / f_safe, alpha)
        # Normalize so 1 kHz anchor == 1.0
        anchor = 1.0 + (fc / 1000.0) ** alpha
        psd_l = shape / max(anchor, 1e-6)
        psd_r = psd_l.copy()

    # Clamp sub-DC bin so it never explodes
    if psd_l.size > 1:
        psd_l[0] = psd_l[1]
        psd_r[0] = psd_r[1]
    return psd_l.astype(np.float32), psd_r.astype(np.float32)


def calibrate_preamp_from_audio(
    audio: np.ndarray,
    sample_rate: int,
    *,
    profile_id: str,
    label: Optional[str] = None,
    device_family: str = "custom",
    default_topology: str = "mono_or_dual_mono",
    calibrated_gain_setting: Optional[float] = None,
    description: str = "",
    output_dir: Optional[Path | str] = None,
    fft_size: int = 2048,
) -> Dict[str, Any]:
    """Analyze a quiet/dark preamp capture and write a `gaia-preamp-profile-v1` JSON file.

    Intended to be called from GAIA's calibration API or CLI (`sin calibrate-preamp`), never by SIN runtime playback.
    """
    clean_id = re.sub(r"[^a-z0-9_-]+", "_", str(profile_id or "").strip().lower()).strip("_-")
    if not clean_id or not _SAFE_ID_RE.match(clean_id):
        raise ValueError(
            "Profile ID must start with a letter and use 2-64 lowercase letters, digits, underscores, or hyphens."
        )
    topo = str(default_topology or "mono_or_dual_mono").strip().lower()
    if topo not in VALID_TOPOLOGIES:
        raise ValueError(f"Unsupported topology '{topo}'. Must be one of: {sorted(VALID_TOPOLOGIES)}")

    stereo = ensure_stereo_f32(audio)
    n_frames = int(stereo.shape[-1])
    sr = int(sample_rate or 48000)
    if n_frames < max(fft_size, int(0.5 * sr)):
        raise ValueError("Calibration audio must be at least 0.5 seconds long.")

    nperseg = min(int(fft_size), n_frames)
    freqs, p_l = signal.welch(stereo[0], fs=sr, nperseg=nperseg, noverlap=nperseg // 2, average="median")
    _, p_r = signal.welch(stereo[1], fs=sr, nperseg=nperseg, noverlap=nperseg // 2, average="median")
    p_l = np.maximum(p_l, 1e-18)
    p_r = np.maximum(p_r, 1e-18)

    # Anchor relative to thermal shelf around 1 kHz .. 4 kHz (median to ignore spurs)
    anchor_mask = (freqs >= 900.0) & (freqs <= 4000.0)
    anchor_l = float(np.median(p_l[anchor_mask])) if np.any(anchor_mask) else float(np.median(p_l))
    anchor_r = float(np.median(p_r[anchor_mask])) if np.any(anchor_mask) else float(np.median(p_r))
    psd_l_db = 10.0 * np.log10(p_l / max(anchor_l, 1e-18))
    psd_r_db = 10.0 * np.log10(p_r / max(anchor_r, 1e-18))

    # Detect narrowband stationary hardware spurs (> 6.5 dB prominence over local +-6-bin median)
    avg_db = 0.5 * (psd_l_db + psd_r_db)
    spurs: List[Dict[str, Any]] = []
    half_win = 6
    for k in range(2, len(freqs) - 2):
        lo = max(1, k - half_win)
        hi = min(len(freqs), k + half_win + 1)
        neigh = np.concatenate([avg_db[lo:k], avg_db[k + 1 : hi]])
        if neigh.size == 0:
            continue
        prom = float(avg_db[k] - np.median(neigh))
        if prom >= 6.5 and avg_db[k] >= avg_db[k - 1] and avg_db[k] >= avg_db[k + 1]:
            freq_val = float(freqs[k])
            if freq_val >= 35.0:
                spurs.append({
                    "freq_hz": round(freq_val, 2),
                    "q": 45.0,
                    "max_cut_db": round(min(24.0, prom + 4.0), 1),
                })
    spurs.sort(key=lambda s: -s["max_cut_db"])
    spurs = spurs[:16]

    # Estimate 1/f corner & slope from low-frequency excess over thermal shelf (2..10 kHz)
    shelf_mask = (freqs >= 2000.0) & (freqs <= min(10000.0, sr * 0.4))
    shelf_lin = float(np.median(0.5 * (p_l[shelf_mask] / anchor_l + p_r[shelf_mask] / anchor_r))) if np.any(shelf_mask) else 1.0
    low_mask = (freqs >= 30.0) & (freqs <= 600.0)
    flicker_corner_hz = 180.0
    flicker_slope = 1.05
    if np.count_nonzero(low_mask) >= 4:
        low_f = freqs[low_mask]
        low_p = 0.5 * (p_l[low_mask] / anchor_l + p_r[low_mask] / anchor_r)
        excess = low_p - shelf_lin
        pos = excess > 0.25 * shelf_lin
        if np.count_nonzero(pos) >= 3:
            lx = np.log10(low_f[pos])
            ly = np.log10(excess[pos] / max(shelf_lin, 1e-12))
            slope, intercept = np.polyfit(lx, ly, 1)
            alpha = float(np.clip(-slope, 0.4, 2.2))
            fc = float(np.clip(10.0 ** (intercept / max(alpha, 0.2)), 35.0, 900.0))
            flicker_slope = round(alpha, 3)
            flicker_corner_hz = round(fc, 1)

    # Resample PSD curve to standard 1025 bins (fft_size=2048) if needed
    if len(psd_l_db) != 1025:
        target_freqs = np.linspace(0.0, float(sr) * 0.5, 1025, dtype=np.float64)
        psd_l_out = np.interp(target_freqs, freqs, psd_l_db)
        psd_r_out = np.interp(target_freqs, freqs, psd_r_db)
    else:
        psd_l_out = psd_l_db
        psd_r_out = psd_r_db

    doc: Dict[str, Any] = {
        "schema": PREAMP_PROFILE_SCHEMA,
        "id": clean_id,
        "label": (label or clean_id.replace("_", " ").title()).strip(),
        "device_family": str(device_family or "custom"),
        "default_topology": topo,
        "coincident_stereo": topo == "coincident_xy_stereo",
        "description": description or f"Calibrated from {n_frames / sr:.1f}s dark noise capture at {sr} Hz.",
        "sample_rate": sr,
        "fft_size": 2048,
        "calibrated_gain_setting": calibrated_gain_setting,
        "flicker_corner_hz": flicker_corner_hz,
        "flicker_slope": flicker_slope,
        "spurs": spurs,
        "psd_l_db": [round(float(v), 3) for v in psd_l_out],
        "psd_r_db": [round(float(v), 3) for v in psd_r_out],
        "calibrated_at": datetime.now(timezone.utc).isoformat(),
    }

    dest_dir = preamp_profiles_directory(output_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / f"{clean_id}.json"
    tmp_path = dest_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    os.replace(tmp_path, dest_path)

    return {
        "ok": True,
        "id": clean_id,
        "path": str(dest_path.resolve()),
        "flicker_corner_hz": flicker_corner_hz,
        "flicker_slope": flicker_slope,
        "spurs_detected": len(spurs),
        "spurs": spurs,
        "default_topology": topo,
    }


def calibrate_preamp_from_wav(
    wav_path: Path | str,
    *,
    profile_id: str,
    label: Optional[str] = None,
    device_family: str = "custom",
    default_topology: str = "mono_or_dual_mono",
    calibrated_gain_setting: Optional[float] = None,
    description: str = "",
    output_dir: Optional[Path | str] = None,
) -> Dict[str, Any]:
    path = Path(wav_path).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Calibration audio file not found: {path}")
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    stereo = data.T  # (channels, frames)
    return calibrate_preamp_from_audio(
        stereo,
        int(sr),
        profile_id=profile_id,
        label=label,
        device_family=device_family,
        default_topology=default_topology,
        calibrated_gain_setting=calibrated_gain_setting,
        description=description,
        output_dir=output_dir,
    )

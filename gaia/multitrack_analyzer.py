import os
import soundfile as sf
from pathlib import Path
from typing import List, Dict, Any, Optional
from . import text_analyzer

SUPPORTED_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff"}

INSTRUMENT_KEYWORDS = {
    "drums": ("drum", "kick", "snare", "hat", "clap", "perc", "cymbal"),
    "bass": ("bass", "sub", "808"),
    "vocals": ("vocal", "vox", "voice", "choir", "acapella"),
    "keys": ("piano", "keys", "organ"),
    "guitar": ("guitar",),
    "synth": ("synth", "pad", "lead"),
    "fx": ("fx", "effect", "riser", "impact"),
}


def _direct_audio_files(folder_path: str) -> List[str]:
    """Return supported audio files immediately inside a folder, in a stable order."""
    try:
        entries = sorted(os.listdir(folder_path))
    except OSError:
        return []

    return [
        os.path.join(folder_path, entry)
        for entry in entries
        if os.path.isfile(os.path.join(folder_path, entry))
        and os.path.splitext(entry)[1].lower() in SUPPORTED_EXTENSIONS
    ]


def is_multitrack_folder(folder_path: str) -> bool:
    """
    Return whether a folder itself is a multitrack stem group.

    A scan visits every directory top-down. Detection therefore only considers
    files directly inside ``folder_path``: otherwise a container with one
    nested song/stem folder would be incorrectly imported as the multitrack
    instead of allowing the scanner to reach that nested folder.
    """
    abs_folder = os.path.abspath(folder_path.strip().strip("\"'"))
    if not os.path.isdir(abs_folder):
        return False

    direct_audio = _direct_audio_files(abs_folder)
    if len(direct_audio) < 2:
        return False

    analysis = analyze_multitrack_folder(abs_folder, recursive=False)
    if not analysis.get("is_valid_length"):
        return False

    labels = {_instrument_label(Path(path).stem) for path in direct_audio}
    labels.discard("other")
    return len(labels) >= 2


def _instrument_label(filename: str) -> str:
    lowered = filename.lower()
    for label, keywords in INSTRUMENT_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            return label
    return "other"

def analyze_multitrack_folder(folder_path: str, tolerance_seconds: float = 0.05, recursive: bool = True) -> Dict[str, Any]:
    """
    Analyzes a directory containing multitrack audio stems.
    
    Inspects each audio stem for duration, sample rate, channels, and stem type.
    Performs length analysis to verify that all stems share equal playback durations.
    """
    abs_folder = os.path.abspath(folder_path.strip().strip("\"'"))
    if not os.path.isdir(abs_folder):
        raise ValueError(f"Folder path '{abs_folder}' is not a valid directory.")

    stems: List[Dict[str, Any]] = []

    if recursive:
        file_entries = []
        for root, dirs, files in os.walk(abs_folder):
            dirs.sort()
            file_entries.extend((root, filename) for filename in sorted(files))
    else:
        file_entries = [(abs_folder, os.path.basename(path)) for path in _direct_audio_files(abs_folder)]

    # Find audio files
    for root, file in file_entries:
        ext = os.path.splitext(file)[1].lower()
        if ext in SUPPORTED_EXTENSIONS:
            stem_abs_path = os.path.join(root, file)
            rel_path = os.path.relpath(stem_abs_path, abs_folder)
            
            duration = 0.0
            sample_rate = 44100
            channels = 2
            frames = 0
            
            try:
                info = sf.info(stem_abs_path)
                duration = float(info.duration)
                sample_rate = int(info.samplerate)
                channels = int(info.channels)
                frames = int(info.frames)
            except Exception:
                pass

            analysis = text_analyzer.analyze_path(stem_abs_path)
            stem_category = _instrument_label(Path(file).stem)
            if stem_category == "other":
                stem_category = analysis.get("category", "Other")

            stems.append({
                "filename": file,
                "relative_path": rel_path.replace("\\", "/"),
                "absolute_path": stem_abs_path.replace("\\", "/"),
                "duration_seconds": round(duration, 4),
                "sample_rate": sample_rate,
                "channels": channels,
                "frames": frames,
                "stem_type": stem_category
            })

    if not stems:
        return {
            "folder_path": abs_folder.replace("\\", "/"),
            "stems": [],
            "is_valid_length": False,
            "length_variance": 0.0,
            "bpm": None,
            "key": None,
            "warning": "No audio stem files found in directory."
        }

    # Length Analysis
    durations = [s["duration_seconds"] for s in stems]
    min_dur = min(durations)
    max_dur = max(durations)
    length_variance = round(max_dur - min_dur, 4)
    is_valid_length = (length_variance <= tolerance_seconds)

    # Context analysis for folder name & stems
    folder_analysis = text_analyzer.analyze_path(abs_folder)
    overall_bpm = folder_analysis.get("bpm")
    overall_key = folder_analysis.get("key")

    if overall_bpm is None:
        for stem in stems:
            stem_analysis = text_analyzer.analyze_path(stem["filename"])
            if stem_analysis.get("bpm"):
                overall_bpm = stem_analysis.get("bpm")
                break

    if overall_key is None:
        for stem in stems:
            stem_analysis = text_analyzer.analyze_path(stem["filename"])
            if stem_analysis.get("key"):
                overall_key = stem_analysis.get("key")
                break

    bpm_int = None
    if overall_bpm:
        try:
            bpm_int = int(float(overall_bpm))
        except (ValueError, TypeError):
            bpm_int = None

    return {
        "folder_path": abs_folder.replace("\\", "/"),
        "stems": stems,
        "is_valid_length": is_valid_length,
        "length_variance": length_variance,
        "bpm": bpm_int,
        "key": overall_key
    }

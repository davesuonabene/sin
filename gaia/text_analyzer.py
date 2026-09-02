"""Conservative metadata inference from sample names and folder structure."""

from __future__ import annotations

import re
from pathlib import Path

from core.analyzers import BPMAnalyzer


_AUDIO_TAGS = (
    ("Open hat", ("open hat", "open hats", "openhat")),
    ("Hi-hat", ("hi hat", "hi hats", "hihat", "hihats", "hi-hat", "hi-hats", " hats ")),
    ("Kick", ("kick", "kicks", " bass drum ", " bd ")),
    ("Snare", ("snare", "snares")),
    ("Clap", ("clap", "claps")),
    ("Snap", ("snap", "snaps")),
    ("Rim", ("rimshot", "rimshots", " rim ", " rims ")),
    ("Cymbal", ("cymbal", "cymbals", "crash", "ride")),
    ("Tom", (" tom ", " toms ")),
    ("Percussion", ("perc", "conga", "bongo", "shaker", "tambourine", "agogo", "woodblock", "triangle", "cowbell")),
    ("808", (" 808 ", "808s")),
    ("Bass", (" bass ", " sub ", "reese")),
    ("Synth", (" synth ", " synthesizer ")),
    ("Lead", (" lead ",)),
    ("Pad", (" pad ", " pads ")),
    ("Pluck", (" pluck ", " plucks ")),
    ("Keys", (" piano ", " keys ", " organ ")),
    ("Guitar", (" guitar ", " guitars ")),
    ("Vocal", ("vocal", "vocals", " vox ", "acapella", "choir", "voice")),
    ("FX", (" fx ", "sfx", "effect", "effects", "riser", "impact", "transition")),
    ("Melody", ("melody", "melodic", "melodies")),
    ("Chord", ("chord", "chords")),
    ("Fill", (" fill ", " fills ")),
    ("Drums", (" drum ", " drums ", "drumkit", "drum kit", "breakbeat")),
)

_DRUM_TAGS = {
    "Drums", "Kick", "Snare", "Clap", "Snap", "Hi-hat", "Open hat",
    "Percussion", "Cymbal", "Tom", "Rim",
}
_TONAL_INSTRUMENT_TAGS = {"Bass", "808", "Synth", "Lead", "Pad", "Pluck", "Keys", "Guitar"}
_CAMELOT_TO_KEY = {
    "1A": "G#min", "2A": "D#min", "3A": "A#min", "4A": "Fmin",
    "5A": "Cmin", "6A": "Gmin", "7A": "Dmin", "8A": "Amin",
    "9A": "Emin", "10A": "Bmin", "11A": "F#min", "12A": "C#min",
    "1B": "Bmaj", "2B": "F#maj", "3B": "C#maj", "4B": "G#maj",
    "5B": "D#maj", "6B": "A#maj", "7B": "Fmaj", "8B": "Cmaj",
    "9B": "Gmaj", "10B": "Dmaj", "11B": "Amaj", "12B": "Emaj",
}
_AUDIO_FILE_EXTENSIONS = {
    ".wav", ".wave", ".flac", ".mp3", ".ogg", ".oga", ".aif", ".aiff", ".aifc",
    ".m4a", ".m4b", ".m4p", ".mp4", ".aac", ".adts", ".opus", ".spx",
    ".webm", ".mka", ".ape", ".wv", ".mpc", ".mp+", ".tta", ".wma", ".asf",
    ".caf", ".amr", ".au", ".snd", ".voc", ".shn", ".ac3", ".eac3",
}


def _searchable(text: str) -> str:
    value = re.sub(r"[_./\\-]+", " ", str(text))
    value = re.sub(r"\s+", " ", value).strip().lower()
    return f" {value} "


def clean_title(text: str) -> str:
    """Turn a filename or pack folder into a useful display title."""
    stem = Path(str(text)).stem
    stem = re.sub(r"[_]+", " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" ._-")
    return stem or Path(str(text)).name or "Untitled asset"


def extract_bpm_range(text: str) -> tuple[int, int] | None:
    match = re.search(r"(?<!\d)(\d{2,3})\s*(?:-|–|—|to)\s*(\d{2,3})\s*(?:bpm)?\b", text, re.IGNORECASE)
    if not match:
        return None
    low, high = sorted((int(match.group(1)), int(match.group(2))))
    return (low, high) if 85 <= low <= high <= 169 else None


def extract_bpm(text: str) -> int | None:
    """Extract one explicit BPM while refusing ambiguous ranges."""
    without_ranges = re.sub(
        r"(?<!\d)\d{2,3}\s*(?:-|–|—|to)\s*\d{2,3}\s*(?:bpm)?\b",
        " ",
        text,
        flags=re.IGNORECASE,
    )
    match = re.search(r"(?<!\d)(\d{2,3}(?:\.\d+)?)\s*[_ -]?\s*bpm\b", without_ranges, re.IGNORECASE)
    if not match:
        match = re.search(r"\bbpm\s*[_ -]?\s*(\d{2,3}(?:\.\d+)?)(?!\d)", without_ranges, re.IGNORECASE)
    if not match:
        return None
    value = round(float(match.group(1)))
    return value if 85 <= value <= 169 else None


def extract_key(text: str, allow_bare_note: bool = False) -> str | None:
    """Extract and normalize standard or Camelot musical keys."""
    camelot = re.search(r"\b(1[0-2]|[1-9])\s*([ab])\b", text, re.IGNORECASE)
    if camelot:
        return f"{camelot.group(1)}{camelot.group(2).upper()}"

    standard = re.search(
        r"\b([a-g])\s*([#b]?)\s*(min(?:or)?|maj(?:or)?|m(?![a-z]))\b",
        text,
        re.IGNORECASE,
    )
    if standard:
        note = standard.group(1).upper() + standard.group(2)
        quality = "min" if standard.group(3).lower().startswith("min") or standard.group(3).lower() == "m" else "maj"
        return f"{note}{quality}"
    if allow_bare_note:
        bare = re.search(r"(?:^|[\s_\-(])([a-g])([#b]?)(?=$|[\s_)\-.])", text, re.IGNORECASE)
        if bare:
            return bare.group(1).upper() + bare.group(2)
    return None


def key_role(text: str, is_loop: bool, tags: list[str]) -> str:
    """Return whether an asset is unpitched, a single pitch, or harmonic."""
    tag_set = set(tags)
    # 808s and bass sounds are tonal even when they live inside a generic
    # drum folder. Give their explicit instrument tag precedence over the
    # folder-level ``Drums`` classification.
    if "Bass" in tag_set or "808" in tag_set:
        return "single_note"
    if tag_set.intersection(_DRUM_TAGS):
        return "none"
    searchable = _searchable(text)
    explicitly_single = bool(re.search(r"\b(single[ -]?note|one[ -]?note|note|tone)\b", searchable))
    if explicitly_single:
        return "single_note"
    if not is_loop and tag_set.intersection(_TONAL_INSTRUMENT_TAGS):
        return "single_note"
    return "harmonic"


def normalize_key_for_role(key: str | None, role: str) -> str | None:
    """Normalize a detected key to GAIA's representation for the asset role."""
    if role == "none":
        return "none"
    if not key:
        return None
    normalized = str(key).strip().replace("♯", "#").replace("♭", "b")
    normalized = _CAMELOT_TO_KEY.get(normalized.upper(), normalized)
    match = re.match(r"^([A-Ga-g])([#b]?)", normalized)
    if not match:
        return None
    note = match.group(1).upper() + match.group(2)
    if role == "single_note":
        return note
    suffix = normalized[match.end():].strip().lower()
    if suffix in {"m", "min", "minor"}:
        return f"{note}min"
    if suffix in {"maj", "major"}:
        return f"{note}maj"
    return note


def detect_is_loop(text: str, has_bpm: bool, extension: str = "") -> bool:
    """Infer loop metadata without promoting it to a library item type."""
    searchable = _searchable(text)
    if re.search(r"\b(loop|loops|break|breaks)\b", searchable):
        return True
    if re.search(r"\b(one[ -]?shots?|oneshots?)\b", searchable):
        return False
    hit_words = r"kick|snare|clap|snap|rimshot|rim|hihat|hi hat|hat|cymbal|crash|ride|tom|perc|conga|bongo|shaker|cowbell|808"
    if re.search(rf"\b({hit_words})s?\b", searchable):
        return False
    if has_bpm:
        return True
    return False


def extract_tags(text: str, is_loop: bool = False, bpm_range: tuple[int, int] | None = None, is_midi: bool = False) -> list[str]:
    searchable = _searchable(text)
    tags: list[str] = []
    for label, needles in _AUDIO_TAGS:
        if any(needle in searchable for needle in needles):
            tags.append(label)
    type_tag = "MIDI" if is_midi else "Loop" if is_loop else None
    if type_tag:
        tags.append(type_tag)
    if bpm_range:
        tags.append(f"BPM {bpm_range[0]}-{bpm_range[1]}")
    return list(dict.fromkeys(tags))


def detect_category(text: str) -> str:
    tags = extract_tags(text)
    if any(tag in tags for tag in {"Drums", "Kick", "Snare", "Clap", "Snap", "Hi-hat", "Open hat", "Percussion", "Cymbal", "Tom", "Rim"}):
        return "Drums"
    if "Bass" in tags or "808" in tags:
        return "Bass"
    if "Vocal" in tags:
        return "Vocals"
    return "Other"


def analyze_path(absolute_path: str, duration_seconds: float | None = None) -> dict:
    """Infer metadata from a filename, nearby folders, audio signal, and loop duration."""
    path = Path(absolute_path)
    context_parts = path.parts[-6:]
    search_text = " ".join(context_parts)
    metadata_text = search_text.replace("_", " ")
    bpm_range = extract_bpm_range(metadata_text)
    bpm = extract_bpm(metadata_text)
    is_midi = path.suffix.lower() in {".mid", ".midi"}
    is_loop = detect_is_loop(search_text, bool(bpm), path.suffix)
    tags = extract_tags(search_text, is_loop, bpm_range, is_midi)
    role = key_role(search_text, is_loop, tags)
    if role == "single_note" and "Single note" not in tags:
        tags.append("Single note")

    if duration_seconds is None and path.is_file() and path.suffix.lower() in _AUDIO_FILE_EXTENSIONS:
        try:
            import soundfile as sf
            info = sf.info(str(path))
            duration_seconds = float(info.duration)
        except Exception:
            duration_seconds = None

    # A duration is useful only after the name/folder has established that the
    # asset is a loop. This avoids assigning tempos to arbitrary one-shots.
    if bpm is None and is_loop and duration_seconds:
        inferred = BPMAnalyzer.from_loop_duration(duration_seconds)
        bpm = round(inferred) if inferred is not None else None

    key = extract_key(metadata_text, allow_bare_note=role == "single_note")
    if key is None and role != "none" and path.is_file() and path.suffix.lower() in _AUDIO_FILE_EXTENSIONS:
        from core.analyzers import KeyAnalyzer
        key = KeyAnalyzer.from_audio_file(str(path), pitch_only=role == "single_note")
    key = normalize_key_for_role(key, role)

    return {
        "title": clean_title(path.name),
        "bpm": bpm,
        "key": key,
        "type": "midi" if is_midi else "audio",
        "is_loop": is_loop,
        "category": detect_category(search_text),
        "tags": tags,
    }

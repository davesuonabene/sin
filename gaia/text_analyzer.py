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
    ("Vocal", ("vocal", "vocals", " vox ", "acapella", "choir", "voice")),
    ("FX", (" fx ", "sfx", "effect", "effects", "riser", "impact", "transition")),
    ("Melody", ("melody", "melodic", "melodies")),
    ("Chord", ("chord", "chords")),
    ("Fill", (" fill ", " fills ")),
    ("Drums", (" drum ", " drums ", "drumkit", "drum kit", "breakbeat")),
)


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
    return (low, high) if 30 <= low <= high <= 400 else None


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
    return value if 30 <= value <= 400 else None


def extract_key(text: str) -> str | None:
    """Extract and normalize standard or Camelot musical keys."""
    camelot = re.search(r"\b(1[0-2]|[1-9])\s*([ab])\b", text, re.IGNORECASE)
    if camelot:
        return f"{camelot.group(1)}{camelot.group(2).upper()}"

    standard = re.search(
        r"\b([a-g])\s*([#b]?)\s*(min(?:or)?|maj(?:or)?|m(?![a-z]))\b",
        text,
        re.IGNORECASE,
    )
    if not standard:
        return None
    note = standard.group(1).upper() + standard.group(2)
    quality = "min" if standard.group(3).lower().startswith("min") or standard.group(3).lower() == "m" else "maj"
    return f"{note}{quality}"


def detect_type(text: str, has_bpm: bool, extension: str = "") -> str:
    """Classify an asset using explicit folder/name evidence."""
    searchable = _searchable(text)
    if extension.lower() in {".mid", ".midi"}:
        return "midi"
    if re.search(r"\b(loop|loops|break|breaks)\b", searchable):
        return "loop"
    if re.search(r"\b(one[ -]?shot|oneshot)\b", searchable):
        return "one_shot"
    hit_words = r"kick|snare|clap|snap|rimshot|rim|hihat|hi hat|hat|cymbal|crash|ride|tom|perc|conga|bongo|shaker|cowbell|808"
    if re.search(rf"\b({hit_words})s?\b", searchable):
        return "one_shot"
    if has_bpm:
        return "loop"
    return "sample"


def extract_tags(text: str, sample_type: str, bpm_range: tuple[int, int] | None = None) -> list[str]:
    searchable = _searchable(text)
    tags: list[str] = []
    for label, needles in _AUDIO_TAGS:
        if any(needle in searchable for needle in needles):
            tags.append(label)
    type_tag = {"loop": "Loop", "one_shot": "One shot", "midi": "MIDI"}.get(sample_type)
    if type_tag:
        tags.append(type_tag)
    if bpm_range:
        tags.append(f"BPM {bpm_range[0]}-{bpm_range[1]}")
    return list(dict.fromkeys(tags))


def detect_category(text: str) -> str:
    tags = extract_tags(text, "sample")
    if any(tag in tags for tag in {"Drums", "Kick", "Snare", "Clap", "Snap", "Hi-hat", "Open hat", "Percussion", "Cymbal", "Tom", "Rim"}):
        return "Drums"
    if "Bass" in tags or "808" in tags:
        return "Bass"
    if "Vocal" in tags:
        return "Vocals"
    return "Other"


def analyze_path(absolute_path: str, duration_seconds: float | None = None) -> dict:
    """Infer metadata from a filename, nearby folders, and loop duration."""
    path = Path(absolute_path)
    context_parts = path.parts[-6:]
    search_text = " ".join(context_parts)
    metadata_text = search_text.replace("_", " ")
    bpm_range = extract_bpm_range(metadata_text)
    bpm = extract_bpm(metadata_text)
    sample_type = detect_type(search_text, bool(bpm), path.suffix)

    # A duration is useful only after the name/folder has established that the
    # asset is a loop. This avoids assigning tempos to arbitrary one-shots.
    if bpm is None and sample_type == "loop" and duration_seconds:
        inferred = BPMAnalyzer.from_loop_duration(duration_seconds)
        bpm = round(inferred) if inferred is not None else None

    return {
        "title": clean_title(path.name),
        "bpm": bpm,
        "key": extract_key(metadata_text),
        "type": sample_type,
        "category": detect_category(search_text),
        "tags": extract_tags(search_text, sample_type, bpm_range),
    }

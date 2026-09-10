"""Read-only source inspection helpers used by GAIA import previews and jobs."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import zipfile
from typing import Any

import soundfile as sf
from mutagen import File as MutagenFile

from . import midi_parser, text_analyzer


AUDIO_EXTENSIONS = {
    ".wav", ".wave", ".flac", ".mp3", ".ogg", ".oga", ".aif", ".aiff", ".aifc",
    ".m4a", ".m4b", ".m4p", ".mp4", ".aac", ".adts", ".opus", ".spx",
    ".webm", ".mka", ".ape", ".wv", ".mpc", ".mp+", ".tta", ".wma", ".asf",
    ".caf", ".amr", ".au", ".snd", ".voc", ".shn", ".ac3", ".eac3",
}
MIDI_EXTENSIONS = {".mid", ".midi"}
AUDIO_METADATA_FIELDS = (
    "title",
    "author",
    "album",
    "album_artist",
    "release_year",
    "genre",
    "track_number",
    "disc_number",
    "comment",
)
TRACK_SAMPLE_MARKERS = re.compile(
    r"(?:^|[\s_.-])(loop|oneshot|one-shot|sample|kick|snare|hihat|hi-hat|hat|clap|808|drum|perc|fx|bpm)(?:$|[\s_.-])",
    re.IGNORECASE,
)
ASSET_STORE = Path(
    os.environ.get("GAIA_ASSET_STORE", str(Path(__file__).resolve().parents[1] / "assets"))
)
MAX_ARCHIVE_FILES = int(os.environ.get("GAIA_MAX_ARCHIVE_FILES", "100000"))
MAX_ARCHIVE_UNCOMPRESSED_BYTES = int(
    os.environ.get("GAIA_MAX_ARCHIVE_UNCOMPRESSED_BYTES", str(500 * 1024**3))
)


def canonical_source_path(source_path: str) -> str:
    cleaned = (source_path or "").strip().strip("\"'").strip()
    if not cleaned:
        raise ValueError("Source path cannot be empty")
    return os.path.abspath(cleaned)


def _ensure_within(root: Path, candidate: Path) -> Path:
    root_resolved = root.resolve()
    candidate_resolved = candidate.resolve()
    if os.path.commonpath([str(root_resolved), str(candidate_resolved)]) != str(root_resolved):
        raise ValueError("Archive contains an unsafe path")
    return candidate_resolved


def _extract_zip(source: Path, destination: Path) -> None:
    """Extract a bounded archive while rejecting traversal and symlink entries."""
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        file_members = [info for info in members if not info.is_dir()]
        if len(file_members) > MAX_ARCHIVE_FILES:
            raise ValueError(f"Archive contains more than {MAX_ARCHIVE_FILES} files")
        total_size = sum(max(0, info.file_size) for info in file_members)
        if total_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ValueError("Archive is larger than GAIA's configured extraction limit")
        for info in members:
            member = PurePosixPath(info.filename)
            if member.is_absolute() or ".." in member.parts:
                raise ValueError("Archive contains an unsafe path")
            if stat.S_ISLNK(info.external_attr >> 16):
                continue
            target = _ensure_within(destination, destination.joinpath(*member.parts))
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info, "r") as source_file, open(target, "wb") as target_file:
                shutil.copyfileobj(source_file, target_file)


def _tag_text(value: Any) -> str | None:
    """Normalize easy tags, ID3 frames, and RIFF values to one text value."""
    if value is None:
        return None
    frame_text = getattr(value, "text", None)
    if frame_text is not None:
        value = frame_text
    if isinstance(value, tuple) and value and all(isinstance(candidate, int) for candidate in value):
        # MP4 ``trkn``/``disk`` atoms can be returned as a bare numeric tuple
        # by some Mutagen versions (others wrap it in a one-item list).
        value = "/".join(str(candidate) for candidate in value if candidate)
    elif isinstance(value, (list, tuple)):
        value = next((candidate for candidate in value if str(candidate).strip()), None)
    if isinstance(value, bytes):
        value = _decode_riff_text(value)
    value = str(value).strip() if value is not None else ""
    return value or None


def _tag_value(tags: Any, *names: str) -> str | None:
    """Return the first useful value across Mutagen's format-specific tags."""
    if tags is None:
        return None
    for name in names:
        try:
            raw_value = tags.get(name)
        except (KeyError, TypeError, ValueError):
            # Vorbis comments, MP4 atoms, and ID3 mappings each reject some
            # keys belonging to the other formats. Unsupported aliases must
            # not cancel extraction of the valid fields already present.
            raw_value = None
        value = _tag_text(raw_value)
        if value:
            return value
        # ID3 comments and user text frames may have qualified keys such as
        # ``COMM::eng``. ``getall`` also avoids depending on the exact suffix.
        getall = getattr(tags, "getall", None)
        if callable(getall):
            try:
                candidates = getall(name)
            except (KeyError, TypeError, ValueError):
                candidates = []
            for candidate in candidates or []:
                value = _tag_text(candidate)
                if value:
                    return value
    # APE and a few vendor-specific containers preserve title-cased keys and
    # do not provide Mutagen's Easy* mapping.  Match those keys case-insensitively
    # as a final fallback while retaining the format-specific aliases above.
    try:
        items = tags.items()
    except (AttributeError, TypeError, ValueError):
        items = ()
    wanted = {name.casefold() for name in names}
    for key, raw_value in items:
        key_text = str(key).casefold()
        if key_text in wanted or any(key_text.startswith(f"{name}::") for name in wanted):
            value = _tag_text(raw_value)
            if value:
                return value
    return None


def _tag_number(value: str | None) -> int | None:
    if not value:
        return None
    match = re.match(r"\s*(\d+)", value)
    return int(match.group(1)) if match else None


def _tag_year(value: str | None) -> int | None:
    if not value:
        return None
    match = re.search(r"(?:^|[^0-9])(\d{4})(?:[^0-9]|$)", value)
    return int(match.group(1)) if match else None


def _decode_riff_text(value: bytes) -> str:
    value = value.rstrip(b"\x00 \t\r\n")
    if not value:
        return ""
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return value.decode(encoding).strip()
        except (UnicodeDecodeError, UnicodeError):
            continue
    return value.decode("latin-1", errors="replace").strip()


def _read_wav_info_tags(file_path: Path) -> dict[str, str]:
    """Read standard RIFF INFO text chunks without loading the audio payload."""
    try:
        with file_path.open("rb") as wav:
            header = wav.read(12)
            if len(header) != 12 or header[:4] not in {b"RIFF", b"RF64"} or header[8:12] != b"WAVE":
                return {}
            while True:
                chunk_header = wav.read(8)
                if len(chunk_header) != 8:
                    return {}
                chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
                if chunk_id != b"LIST":
                    wav.seek(chunk_size + (chunk_size & 1), os.SEEK_CUR)
                    continue
                list_type = wav.read(4)
                remaining = max(0, chunk_size - 4)
                if list_type != b"INFO" or remaining > 4 * 1024 * 1024:
                    wav.seek(remaining + (chunk_size & 1), os.SEEK_CUR)
                    continue
                payload = wav.read(remaining)
                tags: dict[str, str] = {}
                offset = 0
                while offset + 8 <= len(payload):
                    field_id, field_size = struct.unpack_from("<4sI", payload, offset)
                    offset += 8
                    end = min(len(payload), offset + field_size)
                    value = _decode_riff_text(payload[offset:end])
                    if value:
                        tags[field_id.decode("ascii", errors="ignore")] = value
                    offset += field_size + (field_size & 1)
                return tags
    except (OSError, EOFError, struct.error):
        return {}


def _read_audio_tags(file_path: Path) -> dict[str, Any]:
    tags: Any = None
    if MutagenFile is not None:
        try:
            media = MutagenFile(str(file_path), easy=True)
            tags = getattr(media, "tags", None) if media else None
            # A few less common containers do not expose an Easy* wrapper but
            # still provide useful raw tags through their native Mutagen class.
            if not tags:
                media = MutagenFile(str(file_path), easy=False)
                raw_tags = getattr(media, "tags", None) if media else None
                if raw_tags:
                    tags = raw_tags
        except Exception:
            tags = None
    riff_tags = _read_wav_info_tags(file_path) if file_path.suffix.casefold() in {".wav", ".wave"} else {}
    if not tags and not riff_tags:
        return {}

    metadata: dict[str, Any] = {}
    text_fields = {
        "title": ("title", "TITLE", "TIT2", "\xa9nam", "INAM"),
        "author": ("artist", "ARTIST", "author", "AUTHOR", "TPE1", "\xa9ART", "IART"),
        "album": ("album", "ALBUM", "TALB", "\xa9alb", "IPRD"),
        "album_artist": ("albumartist", "ALBUMARTIST", "album artist", "ALBUM ARTIST", "album_artist", "ALBUM_ARTIST", "TPE2", "aART"),
        "genre": ("genre", "GENRE", "TCON", "\xa9gen", "IGNR"),
        "comment": ("comment", "COMMENT", "description", "DESCRIPTION", "COMM", "\xa9cmt", "ICMT"),
    }
    for field, names in text_fields.items():
        value = _tag_value(tags, *names) or _tag_value(riff_tags, *names)
        if value:
            metadata[field] = value

    year_value = _tag_value(
        tags,
        "date", "DATE", "year", "YEAR", "originaldate", "ORIGINALDATE", "release_date", "releasedate", "tdrc", "TDRC", "TYER", "\xa9day", "ICRD",
    ) or _tag_value(riff_tags, "ICRD")
    year = _tag_year(year_value)
    if year is not None:
        metadata["release_year"] = year
    track_number = _tag_number(
        _tag_value(tags, "tracknumber", "TRACKNUMBER", "track_number", "TRACK_NUMBER", "track", "TRACK", "TRCK", "trkn", "ITRK")
        or _tag_value(riff_tags, "ITRK")
    )
    if track_number is not None:
        metadata["track_number"] = track_number
    disc_number = _tag_number(_tag_value(tags, "discnumber", "DISCNUMBER", "disc_number", "DISC_NUMBER", "disc", "DISC", "TPOS", "disk"))
    if disc_number is not None:
        metadata["disc_number"] = disc_number
    return metadata


def _audio_metadata(file_path: Path) -> dict[str, Any]:
    """Read duration and optional embedded audio tags without modifying the source."""
    metadata: dict[str, Any] = {}
    try:
        info = sf.info(str(file_path))
        metadata["duration_seconds"] = round(float(info.duration), 4)
    except Exception:
        metadata["duration_seconds"] = None
    if metadata["duration_seconds"] is None and MutagenFile is not None:
        try:
            media = MutagenFile(str(file_path), easy=False)
            length = getattr(getattr(media, "info", None), "length", None)
            if length is not None:
                metadata["duration_seconds"] = round(float(length), 4)
        except Exception:
            pass
    audio_tags = _read_audio_tags(file_path)
    if audio_tags:
        metadata["audio_metadata"] = audio_tags
        metadata.update(audio_tags)
    return metadata


def infer_audio_item_type(
    filename: str,
    duration_seconds: float | None,
    audio_metadata: dict[str, Any] | None = None,
) -> str:
    """Classify an analysed audio file as a full track when evidence supports it.

    Short, filename-labelled samples should remain generic audio. A real title
    plus artist/album tags is strong evidence even for a short recording, while
    a longer non-sample-labelled recording is treated as a track when tags are
    absent (common for archive downloads).
    """
    metadata = audio_metadata or {}
    name = Path(filename).stem
    has_title = bool(str(metadata.get("title") or "").strip()) or bool(name.strip())
    structured_tag_count = sum(
        bool(metadata.get(field))
        for field in ("author", "album", "album_artist", "release_year", "track_number")
    )
    has_strong_tags = bool(metadata.get("title")) and structured_tag_count >= 1
    sample_label = bool(TRACK_SAMPLE_MARKERS.search(name))
    duration = float(duration_seconds) if duration_seconds is not None else 0.0

    if has_strong_tags and not sample_label:
        return "track"
    if has_title and duration >= 60.0 and not sample_label:
        return "track"
    if metadata.get("title") and duration >= 30.0 and not sample_label:
        return "track"
    return "audio"


def analyze_audio_file(file_path: Path, duration_seconds: float | None = None) -> dict[str, Any]:
    """Analyze audio content, including embedded tags and track classification."""
    audio_info = _audio_metadata(file_path)
    duration = duration_seconds if duration_seconds is not None else audio_info.get("duration_seconds")
    analysis = text_analyzer.analyze_path(str(file_path), duration_seconds=duration)
    embedded_metadata = dict(audio_info.get("audio_metadata") or {})
    analysis.update(
        duration_seconds=duration,
        audio_metadata=embedded_metadata,
        title=embedded_metadata.get("title") or analysis["title"],
        type=infer_audio_item_type(file_path.name, duration, embedded_metadata),
    )
    return analysis


def analyze_manifest_entry(root: Path, entry: dict[str, Any]) -> dict[str, Any]:
    """Infer metadata without changing the source or managed asset store."""
    file_path = root / Path(entry["relative_path"])
    extension = file_path.suffix.lower()
    duration = entry.get("duration_seconds")
    if extension in AUDIO_EXTENSIONS:
        analysis = analyze_audio_file(file_path, duration_seconds=duration)
        duration = analysis.get("duration_seconds")
    else:
        analysis = text_analyzer.analyze_path(str(file_path), duration_seconds=duration)
    item_type = analysis["type"] if extension in AUDIO_EXTENSIONS else "midi" if extension in MIDI_EXTENSIONS else "file"
    bpm = analysis.get("bpm")
    key = analysis.get("key")
    if extension in MIDI_EXTENSIONS:
        try:
            midi_values = midi_parser.parse_midi_file(str(file_path))
        except Exception:
            midi_values = {}
        bpm = midi_values.get("bpm") or bpm
        role = text_analyzer.key_role(str(file_path), False, analysis.get("tags", []))
        key = text_analyzer.normalize_key_for_role(midi_values.get("key") or key, role)
    existing_metadata = dict(entry.get("audio_metadata") or {})
    for field in AUDIO_METADATA_FIELDS:
        if field == "title":
            continue
        val = entry.get(field)
        if val is not None and (not isinstance(val, str) or val.strip() != "") and field not in existing_metadata:
            existing_metadata[field] = val
    embedded_metadata = dict(analysis.get("audio_metadata") or {})
    merged_metadata = dict(embedded_metadata)
    for field, val in existing_metadata.items():
        if val is not None and (not isinstance(val, str) or val.strip() != ""):
            merged_metadata[field] = val

    filename = entry.get("filename", "")
    filename_stem = Path(filename).stem
    raw_title = (entry.get("title") or "").strip()
    if raw_title and raw_title != filename and raw_title != filename_stem:
        title = raw_title
    elif merged_metadata.get("title"):
        title = merged_metadata["title"]
    else:
        title = raw_title or analysis.get("title") or filename_stem

    final_bpm = entry.get("bpm")
    if final_bpm is None and bpm is not None:
        try:
            final_bpm = round(float(bpm))
        except (ValueError, TypeError):
            final_bpm = None

    existing_key = (entry.get("key") or "").strip() if isinstance(entry.get("key"), str) else entry.get("key")
    final_key = existing_key or key

    final_is_loop = bool(entry.get("is_loop") or analysis.get("is_loop"))

    current_type = entry.get("type")
    if current_type and current_type not in {"audio", "file"}:
        final_type = current_type
    else:
        final_type = item_type

    existing_tags = [t.strip() for t in (entry.get("tags") or []) if isinstance(t, str) and t.strip()]
    seen_tags = {t.casefold() for t in existing_tags}
    merged_tags = list(existing_tags)
    for t in analysis.get("tags", []):
        cleaned = t.strip() if isinstance(t, str) else ""
        if cleaned and cleaned.casefold() not in seen_tags:
            seen_tags.add(cleaned.casefold())
            merged_tags.append(cleaned)
    final_tags = merged_tags[:24]

    result = {
        **entry,
        "title": title,
        "type": final_type,
        "duration_seconds": duration,
        "bpm": final_bpm,
        "key": final_key,
        "is_loop": final_is_loop,
        "tags": final_tags,
        "streamable": final_type in {"audio", "track", "sample"},
        "audio_metadata": merged_metadata,
    }
    for field in AUDIO_METADATA_FIELDS:
        result[field] = merged_metadata.get(field)
    return result


def build_manifest(root: Path) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for current_root, dirs, files in os.walk(root, topdown=True, followlinks=False):
        dirs[:] = sorted(directory for directory in dirs if not (Path(current_root) / directory).is_symlink())
        for filename in sorted(files):
            file_path = Path(current_root) / filename
            if file_path.is_symlink():
                continue
            relative_path = file_path.relative_to(root).as_posix()
            extension = file_path.suffix.lower()
            entry = {
                "index": len(contents),
                "filename": filename,
                "relative_path": relative_path,
                "type": "midi" if extension in MIDI_EXTENSIONS else "audio" if extension in AUDIO_EXTENSIONS else "file",
                "mime_type": mimetypes.guess_type(str(file_path))[0],
                "size_bytes": file_path.stat().st_size,
                "duration_seconds": None,
                "bpm": None,
                "key": None,
                "is_loop": False,
                "tags": [],
                "streamable": False,
            }
            contents.append(analyze_manifest_entry(root, entry))
    return contents

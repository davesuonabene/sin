"""Central registry of GAIA project kinds and dedicated editor engines."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .. import models


@dataclass(frozen=True)
class EngineSpec:
    id: str
    label: str
    description: str
    supported_kinds: tuple[str, ...]
    supports_ephemeral: bool = False

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "supported_kinds": list(self.supported_kinds),
            "supports_ephemeral": self.supports_ephemeral,
        }


@dataclass(frozen=True)
class ProjectKindSpec:
    id: str
    label: str
    default_engine: str
    allowed_engines: tuple[str, ...]
    media_types: frozenset[str]
    description: str = ""

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "default_engine": self.default_engine,
            "allowed_engines": list(self.allowed_engines),
            "media_types": sorted(self.media_types),
            "description": self.description,
        }


ENGINES: dict[str, EngineSpec] = {
    "sin": EngineSpec(
        id="sin",
        label="SIN Node Editor",
        description="Node-graph audio synthesis, routing, snapshots, and multi-track arrangement.",
        supported_kinds=("audio",),
        supports_ephemeral=False,
    ),
    "simple_media": EngineSpec(
        id="simple_media",
        label="Simple Media Editor",
        description="Single-channel FFmpeg-backed trimmer, multi-cut slicer, and exporter for audio & video.",
        supported_kinds=("audio", "video"),
        supports_ephemeral=True,
    ),
}

PROJECT_KINDS: dict[str, ProjectKindSpec] = {
    "audio": ProjectKindSpec(
        id="audio",
        label="Audio",
        default_engine="sin",
        allowed_engines=("sin", "simple_media"),
        media_types=frozenset({"audio", "track", "sample", "multitrack", "zoom_h4"}),
        description="Audio project defaulting to the SIN Node Editor.",
    ),
    "video": ProjectKindSpec(
        id="video",
        label="Video",
        default_engine="simple_media",
        allowed_engines=("simple_media",),
        media_types=frozenset({"video"}),
        description="Video project using the Simple Media Editor.",
    ),
}

EPHEMERAL_DEFAULT_ENGINE = "simple_media"


def infer_project_kind(items: Iterable[models.Item] | None) -> str:
    """Infer 'video' if any selected item (or direct folder child) is a video, else 'audio'."""
    for item in items or ():
        if item is None:
            continue
        if getattr(item, "type", None) == "video":
            return "video"
        if isinstance(item, models.ProjectItem) and getattr(item, "project_kind", None) == "video":
            return "video"
        for child in getattr(item, "children", None) or ():
            if getattr(child, "type", None) == "video":
                return "video"
    return "audio"


def resolve_project_engine(
    project_kind: str | None,
    requested_engine: str | None = None,
    items: Iterable[models.Item] | None = None,
) -> tuple[str, str]:
    """Validate and resolve (project_kind, editor_engine) with defaults."""
    resolved_kind = (project_kind or "").strip().lower()
    if not resolved_kind:
        resolved_kind = infer_project_kind(items)
    kind_spec = PROJECT_KINDS.get(resolved_kind)
    if not kind_spec:
        raise ValueError(f"Unsupported project kind: {resolved_kind}")

    resolved_engine = (requested_engine or "").strip().lower() or kind_spec.default_engine
    if resolved_engine not in ENGINES:
        raise ValueError(f"Unsupported editor engine: {resolved_engine}")
    if resolved_engine not in kind_spec.allowed_engines:
        raise ValueError(
            f"Editor engine '{resolved_engine}' is not supported for '{resolved_kind}' projects"
        )
    return resolved_kind, resolved_engine


def registry_payload() -> dict:
    return {
        "ephemeral_default_engine": EPHEMERAL_DEFAULT_ENGINE,
        "engines": [spec.as_dict() for spec in ENGINES.values()],
        "project_kinds": [spec.as_dict() for spec in PROJECT_KINDS.values()],
    }

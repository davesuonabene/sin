"""Central asset taxonomy shared by GAIA import, storage, and UI clients."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AssetTypeDefinition:
    id: str
    label: str
    parent: str | None
    abstract: bool = False
    container: bool = False
    importable: bool = False
    project_type: bool = False
    description: str = ""
    analysis_default: bool = False
    exclusive: bool = False

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "parent": self.parent,
            "abstract": self.abstract,
            "container": self.container,
            "importable": self.importable,
            "project_type": self.project_type,
            "description": self.description,
            "analysis_default": self.analysis_default,
            "exclusive": self.exclusive,
        }


# ``collection`` and ``multitrack`` remain the persisted/public identifiers for
# backwards compatibility. Their position in this registry gives them the new
# Folder semantics without invalidating saved SIN assets or existing GAIA rows.
ASSET_TYPES = (
    AssetTypeDefinition("asset", "Asset", None, abstract=True),
    AssetTypeDefinition("file", "File", "asset", abstract=True),
    AssetTypeDefinition("item", "File", "file"),
    AssetTypeDefinition("audio", "Audio", "file", abstract=True),
    AssetTypeDefinition("track", "Track", "audio"),
    AssetTypeDefinition("sample", "Sample", "audio", abstract=True),
    AssetTypeDefinition("one_shot", "One shot", "sample"),
    AssetTypeDefinition("loop", "Loop", "sample"),
    AssetTypeDefinition("midi", "MIDI", "file"),
    AssetTypeDefinition("sequence", "Sequence", "file"),
    AssetTypeDefinition("folder", "Folder", "asset", abstract=True, container=True),
    AssetTypeDefinition(
        "collection",
        "Generic folder",
        "folder",
        container=True,
        importable=True,
        description="Fallback for folders that do not match a more specific enabled type.",
        analysis_default=True,
    ),
    AssetTypeDefinition(
        "sample_pack",
        "Sample pack",
        "folder",
        container=True,
        importable=True,
        description="Folders primarily containing samples or MIDI, including nested subfolders.",
        analysis_default=True,
    ),
    AssetTypeDefinition(
        "multitrack",
        "Stem collection",
        "folder",
        container=True,
        importable=True,
        description="Direct audio stems with matching lengths and distinct musical roles.",
        analysis_default=True,
    ),
    AssetTypeDefinition("project", "Project", "folder", abstract=True, container=True),
    AssetTypeDefinition(
        "live_recording_project",
        "Live recording",
        "project",
        container=True,
        importable=True,
        project_type=True,
        description="Explicitly import an existing live-recording workflow as a Project.",
        exclusive=True,
    ),
)

TYPE_BY_ID = {definition.id: definition for definition in ASSET_TYPES}
FOLDER_TYPES = {
    definition.id
    for definition in ASSET_TYPES
    if definition.container and not definition.abstract
}
PROJECT_TYPES = {
    definition.id
    for definition in ASSET_TYPES
    if definition.project_type
}

IMPORT_EXPECTATIONS = {
    "auto",
    "files",
    "collection",
    "sample_pack",
    "multitrack",
    *PROJECT_TYPES,
}
DEFAULT_ANALYSIS_TYPES = tuple(
    definition.id for definition in ASSET_TYPES if definition.analysis_default
)


def type_definitions() -> list[dict]:
    return [definition.as_dict() for definition in ASSET_TYPES]


def is_folder_type(type_id: str | None) -> bool:
    return bool(type_id in FOLDER_TYPES)


def is_project_type(type_id: str | None) -> bool:
    return bool(type_id in PROJECT_TYPES)


def validate_import_expectation(value: str | None) -> str:
    normalized = (value or "auto").strip().lower()
    if normalized not in IMPORT_EXPECTATIONS:
        allowed = ", ".join(sorted(IMPORT_EXPECTATIONS))
        raise ValueError(f"Unknown import expectation '{normalized}'. Expected one of: {allowed}")
    return normalized


def resolve_analysis_types(
    values: list[str] | tuple[str, ...] | None,
    expected_type: str | None = "auto",
) -> tuple[str, ...]:
    """Resolve the new allowed-type filter while preserving legacy requests."""
    expectation = validate_import_expectation(expected_type)
    if values is None:
        if expectation == "auto":
            return DEFAULT_ANALYSIS_TYPES
        if expectation == "files":
            return ()
        return (expectation,)

    normalized = tuple(dict.fromkeys(str(value).strip().lower() for value in values if str(value).strip()))
    if not normalized:
        # An intentionally empty filter means that folder contents are imported
        # as independent items instead of creating a parent collection.
        return ()
    invalid = [value for value in normalized if value not in FOLDER_TYPES]
    if invalid:
        raise ValueError(f"Unknown folder analysis type: {', '.join(invalid)}")
    exclusive = [value for value in normalized if TYPE_BY_ID[value].exclusive]
    if exclusive and len(normalized) != 1:
        raise ValueError("Project imports are explicit and must be selected on their own")
    return normalized

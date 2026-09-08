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


ASSET_TYPES = (
    AssetTypeDefinition("asset", "Asset", None, abstract=True),
    AssetTypeDefinition("file", "File", "asset", abstract=True),
    AssetTypeDefinition("item", "File", "file"),
    AssetTypeDefinition("audio", "Audio", "file", importable=True, description="Raw or unclassified audio."),
    AssetTypeDefinition("track", "Track", "audio"),
    AssetTypeDefinition("sample", "Sample", "audio", description="Audio prepared for sampling; loop state is metadata."),
    AssetTypeDefinition("midi", "MIDI", "file"),
    AssetTypeDefinition("sequence", "Sequence", "file"),
    AssetTypeDefinition("folder", "Folder", "asset", abstract=True, container=True),
    AssetTypeDefinition(
        "collection",
        "Folder",
        "folder",
        container=True,
        description="Folder collection.",
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
    AssetTypeDefinition(
        "project",
        "Project",
        "folder",
        container=True,
        project_type=True,
        description="Managed project workspace created from linked sources.",
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

def type_definitions() -> list[dict]:
    return [definition.as_dict() for definition in ASSET_TYPES]


def is_folder_type(type_id: str | None) -> bool:
    return bool(type_id in FOLDER_TYPES)


def is_project_type(type_id: str | None) -> bool:
    return bool(type_id in PROJECT_TYPES)

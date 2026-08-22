"""Discovery and validation for shareable GAIA profile bundles.

Profiles are intentionally data-only. They describe how a known folder layout
may be interpreted; GAIA's project/reference service materializes that
interpretation only in the project that uses the folder.
"""

from __future__ import annotations

from dataclasses import dataclass
import fnmatch
import json
from pathlib import Path
import re
import shutil
from typing import Any, Iterable, Mapping

from . import paths


BUNDLE_SCHEMA = "gaia-profile-bundle-v1"
TEMPLATE_DIRECTORY = Path(__file__).with_name("profile_templates")
_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_-]*$")
_RELATION_KINDS = frozenset({"source", "component", "use", "derived", "supersedes"})


class ProfileValidationError(ValueError):
    """Raised when a profile bundle is not safe to use."""


@dataclass(frozen=True)
class ProfileComponent:
    """A reusable rule for interpreting one file in a profile container."""

    pattern: str
    label: str
    relation_kind: str
    stage_name: str | None = None
    suggested_master: bool = False


@dataclass(frozen=True)
class Profile:
    """A validated, data-only profile from a profile bundle."""

    bundle_id: str
    id: str
    label: str
    container_type: str
    filename_patterns: tuple[str, ...]
    components: tuple[ProfileComponent, ...]
    description: str | None = None


@dataclass(frozen=True)
class ProfileBundle:
    """A validated JSON file that may provide several profiles."""

    path: Path
    bundle_id: str
    profiles: tuple[Profile, ...]
    label: str | None = None


@dataclass(frozen=True)
class ComponentSuggestion:
    """A non-persistent component interpretation suggested by a profile."""

    profile_id: str
    bundle_id: str
    relative_path: str
    label: str
    relation_kind: str
    stage_name: str | None
    suggested_master: bool


def profiles_directory() -> Path:
    """Return the live, non-asset directory for shareable profile bundles."""
    return paths.profiles_directory()


def ensure_builtin_profile_bundles() -> tuple[Path, ...]:
    """Install bundled examples once without replacing a user's shared files."""
    destination = profiles_directory()
    destination.mkdir(parents=True, exist_ok=True)
    installed: list[Path] = []
    if not TEMPLATE_DIRECTORY.is_dir():
        return ()
    for template in sorted(TEMPLATE_DIRECTORY.glob("*.json")):
        target = destination / template.name
        if not target.exists():
            shutil.copy2(template, target)
            installed.append(target)
    return tuple(installed)


def _error(path: Path, message: str) -> ProfileValidationError:
    return ProfileValidationError(f"Invalid profile bundle {path}: {message}")


def _require_identifier(value: Any, field: str, path: Path) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise _error(path, f"{field} must match {_IDENTIFIER.pattern!r}")
    return value


def _require_text(value: Any, field: str, path: Path) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _error(path, f"{field} must be a non-empty string")
    return value.strip()


def _reject_unknown_fields(
    value: Mapping[str, Any], allowed: set[str], field: str, path: Path
) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise _error(path, f"{field} has unsupported field(s): {', '.join(unknown)}")


def _validate_patterns(value: Any, field: str, path: Path) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise _error(path, f"{field} must be a non-empty array of filename patterns")
    patterns = tuple(_require_text(pattern, f"{field} entry", path) for pattern in value)
    if len(set(patterns)) != len(patterns):
        raise _error(path, f"{field} cannot contain duplicate patterns")
    return patterns


def _validate_component(value: Any, index: int, path: Path) -> ProfileComponent:
    field = f"profiles[].components[{index}]"
    if not isinstance(value, Mapping):
        raise _error(path, f"{field} must be an object")
    _reject_unknown_fields(
        value,
        {"pattern", "label", "relation_kind", "stage_name", "suggested_master"},
        field,
        path,
    )
    pattern = _require_text(value.get("pattern"), f"{field}.pattern", path)
    label = _require_text(value.get("label"), f"{field}.label", path)
    relation_kind = _require_text(value.get("relation_kind"), f"{field}.relation_kind", path)
    if relation_kind not in _RELATION_KINDS:
        supported = ", ".join(sorted(_RELATION_KINDS))
        raise _error(path, f"{field}.relation_kind must be one of: {supported}")

    stage_name = value.get("stage_name")
    if stage_name is not None:
        stage_name = _require_text(stage_name, f"{field}.stage_name", path)
    suggested_master = value.get("suggested_master", False)
    if not isinstance(suggested_master, bool):
        raise _error(path, f"{field}.suggested_master must be a boolean")
    return ProfileComponent(
        pattern=pattern,
        label=label,
        relation_kind=relation_kind,
        stage_name=stage_name,
        suggested_master=suggested_master,
    )


def _validate_profile(value: Any, bundle_id: str, index: int, path: Path) -> Profile:
    field = f"profiles[{index}]"
    if not isinstance(value, Mapping):
        raise _error(path, f"{field} must be an object")
    _reject_unknown_fields(
        value,
        {"id", "label", "description", "container_type", "match", "components"},
        field,
        path,
    )
    profile_id = _require_identifier(value.get("id"), f"{field}.id", path)
    label = _require_text(value.get("label"), f"{field}.label", path)
    description = value.get("description")
    if description is not None:
        description = _require_text(description, f"{field}.description", path)
    container_type = _require_identifier(value.get("container_type"), f"{field}.container_type", path)

    match = value.get("match")
    if not isinstance(match, Mapping):
        raise _error(path, f"{field}.match must be an object")
    _reject_unknown_fields(match, {"filename_patterns"}, f"{field}.match", path)
    filename_patterns = _validate_patterns(
        match.get("filename_patterns"), f"{field}.match.filename_patterns", path
    )

    raw_components = value.get("components")
    if not isinstance(raw_components, list) or not raw_components:
        raise _error(path, f"{field}.components must be a non-empty array")
    components = tuple(
        _validate_component(component, component_index, path)
        for component_index, component in enumerate(raw_components)
    )
    return Profile(
        bundle_id=bundle_id,
        id=profile_id,
        label=label,
        description=description,
        container_type=container_type,
        filename_patterns=filename_patterns,
        components=components,
    )


def load_profile_bundle(path: str | Path) -> ProfileBundle:
    """Load and strictly validate a single JSON profile bundle."""

    bundle_path = Path(path)
    try:
        raw = json.loads(bundle_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except (OSError, json.JSONDecodeError) as exc:
        raise _error(bundle_path, f"cannot read JSON ({exc})") from exc

    if not isinstance(raw, Mapping):
        raise _error(bundle_path, "root must be an object")
    _reject_unknown_fields(raw, {"schema", "bundle_id", "label", "profiles"}, "root", bundle_path)
    if raw.get("schema") != BUNDLE_SCHEMA:
        raise _error(bundle_path, f"schema must be {BUNDLE_SCHEMA!r}")
    bundle_id = _require_identifier(raw.get("bundle_id"), "bundle_id", bundle_path)
    label = raw.get("label")
    if label is not None:
        label = _require_text(label, "label", bundle_path)

    raw_profiles = raw.get("profiles")
    if not isinstance(raw_profiles, list) or not raw_profiles:
        raise _error(bundle_path, "profiles must be a non-empty array")
    profiles = tuple(
        _validate_profile(profile, bundle_id, index, bundle_path)
        for index, profile in enumerate(raw_profiles)
    )
    profile_ids = [profile.id for profile in profiles]
    if len(profile_ids) != len(set(profile_ids)):
        raise _error(bundle_path, "profiles cannot contain duplicate ids")
    return ProfileBundle(path=bundle_path, bundle_id=bundle_id, label=label, profiles=profiles)


def discover_profile_bundles(profiles_dir: str | Path | None = None) -> tuple[ProfileBundle, ...]:
    """Return every validated bundle in the managed profile directory.

    A malformed bundle is reported rather than ignored so a profile cannot be
    silently applied with partial or unexpected rules.
    """

    directory = Path(profiles_dir) if profiles_dir is not None else profiles_directory()
    if not directory.exists():
        return ()
    if not directory.is_dir():
        raise ProfileValidationError(f"Profile directory is not a directory: {directory}")
    bundles = tuple(load_profile_bundle(path) for path in sorted(directory.glob("*.json")))
    bundle_ids = [bundle.bundle_id for bundle in bundles]
    if len(bundle_ids) != len(set(bundle_ids)):
        raise ProfileValidationError(f"Profile directory has duplicate bundle ids: {directory}")
    profile_ids = [profile.id for bundle in bundles for profile in bundle.profiles]
    if len(profile_ids) != len(set(profile_ids)):
        raise ProfileValidationError(f"Profile directory has duplicate profile ids: {directory}")
    return bundles


def discover_profiles(profiles_dir: str | Path | None = None) -> tuple[Profile, ...]:
    """Return validated profiles from all discovered bundles, ordered by file."""

    return tuple(
        profile
        for bundle in discover_profile_bundles(profiles_dir)
        for profile in bundle.profiles
    )


def get_profile(
    profile_id: str,
    *,
    bundle_id: str | None = None,
    profiles_dir: str | Path | None = None,
) -> Profile | None:
    """Return a profile by globally unique ID, or ``None`` when absent."""

    for profile in discover_profiles(profiles_dir):
        if profile.id == profile_id and (bundle_id is None or profile.bundle_id == bundle_id):
            return profile
    return None


def _normalise_filenames(filenames: Iterable[str | Path]) -> tuple[str, ...]:
    return tuple(Path(filename).name for filename in filenames)


def _matches_pattern(filename: str, pattern: str) -> bool:
    normalized = filename.casefold()
    candidates = (normalized, normalized.rsplit("_", 1)[-1])
    return any(fnmatch.fnmatchcase(candidate, pattern.casefold()) for candidate in candidates)


def match_profiles(
    container_type: str,
    filenames: Iterable[str | Path],
    *,
    profiles_dir: str | Path | None = None,
) -> tuple[Profile, ...]:
    """Find profiles whose type and required filename patterns all match.

    Matching is case-insensitive and based on basenames, so callers can pass
    relative paths from an imported folder without exposing filesystem details.
    """

    names = _normalise_filenames(filenames)
    return tuple(
        profile
        for profile in discover_profiles(profiles_dir)
        if profile.container_type == container_type
        and all(any(_matches_pattern(name, pattern) for name in names) for pattern in profile.filename_patterns)
    )


def suggest_components(
    profile: Profile,
    filenames: Iterable[str | Path],
) -> tuple[ComponentSuggestion, ...]:
    """Suggest one component interpretation per matching file.

    Component rules are evaluated in profile order.  This makes an explicit
    mixdown rule able to take precedence over a broad source-channel wildcard.
    The result is deliberately non-persistent and contains no item IDs.
    """

    suggestions: list[ComponentSuggestion] = []
    for relative_path in filenames:
        relative_text = str(relative_path)
        filename = Path(relative_path).name
        component = next(
            (
                rule
                for rule in profile.components
                if _matches_pattern(filename, rule.pattern)
            ),
            None,
        )
        if component is None:
            continue
        suggestions.append(
            ComponentSuggestion(
                profile_id=profile.id,
                bundle_id=profile.bundle_id,
                relative_path=relative_text,
                label=component.label,
                relation_kind=component.relation_kind,
                stage_name=component.stage_name,
                suggested_master=component.suggested_master,
            )
        )
    return tuple(suggestions)

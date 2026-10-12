from __future__ import annotations

import glob
import json
import os

from link.config import KeelPaths, Refused, canonical_json, expand_placeholders
from measurekit.ledger import active_stack_names

OWNED_KEYS = ("hooks", "permissions", "env")
LIST_PERMISSION_KEYS = ("allow", "deny", "ask")


def load_merged_fragments(paths: KeelPaths) -> tuple[dict, list[str]]:
    """Merged owned keys from every fragment, plus conflict notes."""
    fragments = [(path, _load_fragment(path, paths)) for path in fragment_paths(paths)]
    merged: dict = {}
    conflicts: list[str] = []
    for source, fragment in fragments:
        for event, entries in fragment.get("hooks", {}).items():
            merged.setdefault("hooks", {}).setdefault(event, []).extend(entries)
        for key, value in fragment.get("permissions", {}).items():
            permissions = merged.setdefault("permissions", {})
            if key in LIST_PERMISSION_KEYS:
                _extend_keeping_first(permissions.setdefault(key, []), value)
            else:
                _set_later_wins(permissions, key, value, f"permissions.{key}", source, conflicts)
        for key, value in fragment.get("env", {}).items():
            _set_later_wins(merged.setdefault("env", {}), key, value, f"env.{key}", source, conflicts)
    return merged, conflicts


def fragment_paths(paths: KeelPaths) -> list[str]:
    core = os.path.join(paths.keel_home, "settings", "core.json")
    if not os.path.isfile(core):
        raise Refused(f"{core} is missing; without it the merged settings would hold no core hooks")
    found = [core]
    for name in sorted(active_stacks(paths)):
        stack_settings = os.path.join(paths.keel_home, "stacks", name, "settings.json")
        if not os.path.isfile(stack_settings):
            raise Refused(f"active stack {name!r} has no {stack_settings}")
        found.append(stack_settings)
    found.extend(sorted(glob.glob(os.path.join(paths.overlay_dir, "settings", "*.json"))))
    return found


def active_stacks(paths: KeelPaths) -> list[str]:
    try:
        return active_stack_names(paths.overlay_dir)
    except ValueError as error:
        raise Refused(str(error)) from error


def _load_fragment(path: str, paths: KeelPaths) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            fragment = json.load(f)
    except json.JSONDecodeError as error:
        raise Refused(f"{path}: invalid JSON ({error})") from error
    _validate_fragment_shape(path, fragment)
    return _expand_strings(fragment, paths, path)


def _validate_fragment_shape(path: str, fragment: object) -> None:
    if not isinstance(fragment, dict):
        raise Refused(f"{path}: a settings fragment must be a JSON object")
    foreign = sorted(set(fragment) - set(OWNED_KEYS))
    if foreign:
        raise Refused(f"{path}: fragments may hold only {', '.join(OWNED_KEYS)}; found {', '.join(foreign)}")
    for key in OWNED_KEYS:
        if key in fragment and not isinstance(fragment[key], dict):
            raise Refused(f"{path}: {key} must be an object")
    for event, entries in fragment.get("hooks", {}).items():
        if not isinstance(entries, list):
            raise Refused(f"{path}: hooks.{event} must be an array")
    for key in LIST_PERMISSION_KEYS:
        if not isinstance(fragment.get("permissions", {}).get(key, []), list):
            raise Refused(f"{path}: permissions.{key} must be an array")
    for key, value in fragment.get("env", {}).items():
        if not isinstance(value, str):
            raise Refused(f"{path}: env.{key} must be a string")


def _expand_strings(value: object, paths: KeelPaths, where: str) -> object:
    if isinstance(value, str):
        return expand_placeholders(value, paths, where)
    if isinstance(value, list):
        return [_expand_strings(item, paths, where) for item in value]
    if isinstance(value, dict):
        return {key: _expand_strings(item, paths, where) for key, item in value.items()}
    return value


def _extend_keeping_first(target: list, additions: list) -> None:
    seen = {canonical_json(item) for item in target}
    for item in additions:
        if canonical_json(item) not in seen:
            seen.add(canonical_json(item))
            target.append(item)


def _set_later_wins(target: dict, key: str, value: object, label: str, source: str, conflicts: list[str]) -> None:
    if key in target and canonical_json(target[key]) != canonical_json(value):
        conflicts.append(f"{label} is overridden by {source}")
    target[key] = value

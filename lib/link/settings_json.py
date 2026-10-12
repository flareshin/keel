from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass

from link.atomic import write_text_atomic
from link.config import KeelPaths, Refused, canonical_json, read_text
from link.fragments import OWNED_KEYS
from measurekit.hook_settings import Registration, is_command_hook, iter_hook_entries

FILE_NAME = "settings.json"
PRIVATE_FILE_MODE = 0o600
PRIVATE_DIR_MODE = 0o700
PRE_KEEL_BACKUP = "pre_keel_settings_backup"
PRE_KEEL_CLAUDE_MD = "pre_keel_claude_md_backup"
NO_PRE_KEEL_FILE = "none"
RESTORE_OP = "restore-settings"
_WHITESPACE = re.compile(r"[ \t\n\r]*")


@dataclass(frozen=True)
class LiveSettings:
    path: str
    text: str
    values: dict


@dataclass(frozen=True)
class _Member:
    key: str
    key_start: int
    value_start: int
    value_end: int
    indent: str


def settings_path(paths: KeelPaths) -> str:
    return os.path.join(paths.data_dir, FILE_NAME)


def read_live_settings(path: str) -> LiveSettings:
    """The live settings.json; a missing file reads as an empty object."""
    if not os.path.exists(path):
        return LiveSettings(path=path, text="{}\n", values={})
    text = read_text(path)
    try:
        values = json.loads(text)
    except json.JSONDecodeError as error:
        raise Refused(f"{path}: invalid JSON ({error}); fix it by hand first") from error
    if not isinstance(values, dict):
        raise Refused(f"{path}: top level must be a JSON object")
    return LiveSettings(path=path, text=text, values=values)


def drifted_owned_keys(live: LiveSettings, merged: dict) -> list[str]:
    """Structure-only drift lines; never values, since env and rules may hold secrets."""
    report = []
    for key in OWNED_KEYS:
        current, wanted = live.values.get(key), merged.get(key)
        if key not in merged and key in live.values:
            report.append(f"{key}: declared by no fragment; --write removes it")
        if key not in merged or canonical_json(current) == canonical_json(wanted):
            continue
        if not (isinstance(current, dict) and isinstance(wanted, dict)):
            report.append(f"{key}: differs")
            continue
        for sub in sorted(set(current) | set(wanted)):
            if canonical_json(current.get(sub)) != canonical_json(wanted.get(sub)):
                report.append(_describe_sub_drift(f"{key}.{sub}", current.get(sub), wanted.get(sub)))
    return report


def list_dropped_items(live: dict, merged: dict) -> list[str]:
    """Each live owned item the merge would remove or replace, as `<section> <item>`; env values never appear."""
    unreadable = [f"{key} (not an object)" for key in OWNED_KEYS if key in live and not isinstance(live[key], dict)]
    return sorted(unreadable + _dropped_permissions(live, merged) + _dropped_env(live, merged) + _dropped_hooks(live, merged))


def splice_owned_keys(text: str, merged: dict) -> str:
    """Make the owned top-level keys of `text` equal `merged` (absent there = removed); other members keep their bytes."""
    members, closing_brace = _scan_top_level(text)
    if members:
        spliced = _rebuild_members(text, members, closing_brace, merged)
    else:
        spliced = _fill_empty_object(text, closing_brace, merged)
    _verify_splice(text, spliced, merged)
    return spliced


def write_settings(live: LiveSettings, merged: dict, backup_path: str) -> None:
    if os.path.exists(live.path):
        _write_private(backup_path, live.text)
    write_text_atomic(live.path, splice_owned_keys(live.text, merged), _existing_mode(live.path))


def restore_pre_keel_settings(paths: KeelPaths) -> dict | None:
    """Put the owned keys back as they were before keel's first settings write; other keys stay as they are now.
    A live file that is not a JSON object gets the whole pre-keel file back instead.

    None when link-state records nothing, settings.json is gone, or keel created it and it is no longer a JSON object.
    """
    recorded = read_link_state(paths).get(PRE_KEEL_BACKUP)
    path = settings_path(paths)
    pre_keel_owned = _resolve_pre_keel_owned_keys(recorded)
    if pre_keel_owned is None or not os.path.exists(path):
        return None
    live_text = read_text(path)
    restored = _resolve_restored_settings_text(live_text, pre_keel_owned, recorded)
    if restored is None:
        return None
    live_saved_to = os.path.join(new_backup_dir(paths), "settings.before-unlink.json")
    _write_private(live_saved_to, live_text)
    write_text_atomic(path, restored, _existing_mode(path))
    if recorded == NO_PRE_KEEL_FILE:
        return {"op": "remove-owned-settings", "path": path, "from": None, "live_saved_to": live_saved_to}
    return {"op": RESTORE_OP, "path": path, "from": recorded, "live_saved_to": live_saved_to}


def changed_since_last_write(paths: KeelPaths, live: LiveSettings) -> list[str]:
    recorded = read_link_state(paths).get("settings_owned_sha256", {})
    return sorted(key for key, digest in recorded.items() if _digest(live.values.get(key)) != digest)


def record_last_write(paths: KeelPaths, merged: dict, backup_path: str | None, claude_md_backup: str | None) -> None:
    """Digests of what this write left, what settings.json was before keel's first settings write, and where the first
    non-keel CLAUDE.md was moved aside."""
    previous = read_link_state(paths)
    state = {
        "schema": 1,
        "settings_owned_sha256": {key: _digest(merged.get(key)) for key in OWNED_KEYS},
        PRE_KEEL_BACKUP: previous.get(PRE_KEEL_BACKUP) or _pre_keel_record(backup_path),
        PRE_KEEL_CLAUDE_MD: previous.get(PRE_KEEL_CLAUDE_MD) or claude_md_backup,
    }
    _write_private(link_state_path(paths), json.dumps(state, indent=2) + "\n")


def new_backup_dir(paths: KeelPaths) -> str:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    return os.path.join(paths.data_dir, "state", "keel", "link-backup", f"{stamp}-{os.getpid()}")


def link_state_path(paths: KeelPaths) -> str:
    return os.path.join(paths.data_dir, "state", "keel", "link-state.json")


def read_link_state(paths: KeelPaths) -> dict:
    path = link_state_path(paths)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as error:
        raise Refused(f"{path}: invalid JSON ({error}); delete it to forget the last write") from error


def _pre_keel_record(backup_path: str | None) -> str | None:
    """This write's backup; NO_PRE_KEEL_FILE when it created settings.json; None when it left settings.json alone."""
    if backup_path is None:
        return None
    return backup_path if os.path.isfile(backup_path) else NO_PRE_KEEL_FILE


def _resolve_pre_keel_owned_keys(recorded: str | None) -> dict | None:
    """The owned keys settings.json held before keel: those of the recorded backup, none when keel created the file."""
    if recorded == NO_PRE_KEEL_FILE:
        return {}
    if not (recorded and os.path.isfile(recorded)):
        return None
    pre_keel = json.loads(read_text(recorded))
    return {key: pre_keel[key] for key in OWNED_KEYS if key in pre_keel}


def _resolve_restored_settings_text(live_text: str, pre_keel_owned: dict, recorded: str) -> str | None:
    """The live text with the pre-keel owned keys spliced in. A live file that is not a JSON object has no other keys
    to keep, so the whole pre-keel backup comes back; None when there is none because keel created the file."""
    try:
        live = json.loads(live_text)
    except json.JSONDecodeError:
        live = None
    if isinstance(live, dict):
        return splice_owned_keys(live_text, pre_keel_owned)
    if recorded == NO_PRE_KEEL_FILE:
        return None
    return read_text(recorded)


def _write_private(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), mode=PRIVATE_DIR_MODE, exist_ok=True)
    write_text_atomic(path, text, PRIVATE_FILE_MODE)


def _existing_mode(path: str) -> int:
    try:
        return os.stat(path).st_mode & 0o7777
    except FileNotFoundError:
        return PRIVATE_FILE_MODE


def _describe_sub_drift(label: str, current: object, wanted: object) -> str:
    if not (isinstance(current, list) or isinstance(wanted, list)):
        return f"{label}: differs"
    current_list, wanted_list = current or [], wanted or []
    current_set = {canonical_json(item) for item in current_list}
    wanted_set = {canonical_json(item) for item in wanted_list}
    return (
        f"{label}: live={len(current_list)} merged={len(wanted_list)} "
        f"only_live={len(current_set - wanted_set)} only_merged={len(wanted_set - current_set)}"
    )


def _dropped_permissions(live: dict, merged: dict) -> list[str]:
    live_permissions, wanted = _object(live, "permissions"), _object(merged, "permissions")
    dropped = []
    for key, value in live_permissions.items():
        label = f"permissions.{key}"
        if isinstance(value, list):
            kept = {canonical_json(item) for item in wanted.get(key) or []}
            dropped += [f"{label} {_render(item)}" for item in value if canonical_json(item) not in kept]
        elif canonical_json(value) != canonical_json(wanted.get(key)):
            dropped.append(f"{label} {_render(value)}")
    return dropped


def _dropped_env(live: dict, merged: dict) -> list[str]:
    live_env, wanted = _object(live, "env"), _object(merged, "env")
    removed = [f"env {name} (removed)" for name in live_env if name not in wanted]
    changed = [f"env {name} (value changed)" for name, value in live_env.items() if name in wanted and wanted[name] != value]
    return removed + changed


def _dropped_hooks(live: dict, merged: dict) -> list[str]:
    """Live hooks of any type absent from the merge, compared by event, matcher and the whole hook object."""
    kept = {_hook_identity(entry) for entry in iter_hook_entries(merged.get("hooks"))}
    dropped = {_hook_label(entry) for entry in iter_hook_entries(live.get("hooks")) if _hook_identity(entry) not in kept}
    return list(dropped)


def _hook_identity(entry: Registration) -> tuple[str, str, str]:
    return entry.event, entry.matcher, canonical_json(entry.hook)


def _hook_label(entry: Registration) -> str:
    """`hooks.<event> <command>` for command hooks, which accept-drops files already name; the whole object otherwise."""
    shown = entry.command if is_command_hook(entry.hook) else canonical_json(entry.hook)
    return f"hooks.{entry.event} {shown}"


def _object(settings: dict, key: str) -> dict:
    value = settings.get(key)
    return value if isinstance(value, dict) else {}


def _render(value: object) -> str:
    return value if isinstance(value, str) else json.dumps(value, sort_keys=True)


def _scan_top_level(text: str) -> tuple[list[_Member], int]:
    """Top-level members of a JSON object with their value spans, and the closing brace index."""
    decoder = json.JSONDecoder()
    index = _skip_whitespace(text, 0)
    if text[index:index + 1] != "{":
        raise Refused("settings.json top level must be a JSON object")
    index = _skip_whitespace(text, index + 1)
    members: list[_Member] = []
    while text[index] != "}":
        key_start = index
        key, index = decoder.raw_decode(text, index)
        index = _skip_whitespace(text, index)
        value_start = _skip_whitespace(text, index + 1)
        _, value_end = decoder.raw_decode(text, value_start)
        members.append(_Member(key, key_start, value_start, value_end, _line_indent(text, key_start)))
        index = _skip_whitespace(text, value_end)
        if text[index] == ",":
            index = _skip_whitespace(text, index + 1)
    return members, index


def _rebuild_members(text: str, members: list[_Member], closing_brace: int, merged: dict) -> str:
    """Each kept member keeps the separator that preceded it; new owned keys go last."""
    indent = members[0].indent
    kept: list[tuple[str, str]] = []
    for position, member in enumerate(members):
        if member.key in OWNED_KEYS and member.key not in merged:
            continue
        separator = text[members[position - 1].value_end:member.key_start] if position else ""
        if member.key in merged:
            value = _render_value(merged[member.key], member.indent)
        else:
            value = text[member.value_start:member.value_end]
        kept.append((separator, text[member.key_start:member.value_start] + value))
    present = {member.key for member in members}
    for key in OWNED_KEYS:
        if key in merged and key not in present:
            kept.append((",\n" + indent, f"{json.dumps(key)}: {_render_value(merged[key], indent)}"))
    if not kept:
        opening_brace = text.index("{")
        return text[:opening_brace + 1] + text[closing_brace:]
    head, tail = text[:members[0].key_start], text[members[-1].value_end:]
    body = kept[0][1] + "".join(separator + member_text for separator, member_text in kept[1:])
    return head + body + tail


def _fill_empty_object(text: str, closing_brace: int, merged: dict) -> str:
    indent = "  "
    rendered = [f"{indent}{json.dumps(key)}: {_render_value(merged[key], indent)}" for key in OWNED_KEYS if key in merged]
    if not rendered:
        return text
    return text[:closing_brace] + "\n" + ",\n".join(rendered) + "\n" + text[closing_brace:]


def _verify_splice(original: str, spliced: str, merged: dict) -> None:
    expected = {key: value for key, value in json.loads(original).items() if key not in OWNED_KEYS}
    expected.update(merged)
    if canonical_json(json.loads(spliced)) != canonical_json(expected):
        raise RuntimeError("settings splice produced different values than the merge")
    if _raw_spans_of_unowned(spliced) != _raw_spans_of_unowned(original):
        raise RuntimeError("settings splice changed bytes of a key keel does not own")


def _raw_spans_of_unowned(text: str) -> list[tuple[str, str]]:
    members, _ = _scan_top_level(text)
    return [(m.key, text[m.value_start:m.value_end]) for m in members if m.key not in OWNED_KEYS]


def _render_value(value: object, indent: str) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False).replace("\n", "\n" + indent)


def _line_indent(text: str, position: int) -> str:
    line_start = text.rfind("\n", 0, position) + 1
    prefix = text[line_start:position]
    return prefix if prefix.strip() == "" else ""


def _skip_whitespace(text: str, index: int) -> int:
    return _WHITESPACE.match(text, index).end()


def _digest(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()

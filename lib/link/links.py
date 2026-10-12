from __future__ import annotations

import os
from dataclasses import dataclass

from link.config import KeelPaths, Refused, expand_placeholders

MANIFEST_HEADER = ["source", "target"]


@dataclass(frozen=True)
class LinkEntry:
    source: str
    target: str


def read_link_manifest(paths: KeelPaths) -> list[LinkEntry]:
    entries: list[LinkEntry] = []
    declared_in: dict[str, str] = {}
    for manifest in (os.path.join(paths.keel_home, "settings", "links.tsv"), os.path.join(paths.overlay_dir, "links.tsv")):
        for source, target in _read_tsv(manifest):
            entry = _build_entry(source, target, manifest, paths)
            if entry.target in declared_in:
                raise Refused(f"{manifest}: target {entry.target} is already declared in {declared_in[entry.target]}")
            declared_in[entry.target] = manifest
            entries.append(entry)
    return entries


def is_keel_link(path: str, paths: KeelPaths) -> bool:
    """True for a symlink into KEEL_HOME or the overlay, under either their raw or resolved spelling."""
    if not os.path.islink(path):
        return False
    pointee = os.path.normpath(os.path.join(os.path.dirname(path), os.readlink(path)))
    roots = {paths.keel_home, paths.overlay_dir}
    roots |= {os.path.realpath(root) for root in roots}
    return any(pointee == root or pointee.startswith(root + os.sep) for root in roots)


def _read_tsv(path: str) -> list[list[str]]:
    """A missing file, or one with no header, has no rows."""
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as f:
        lines = [line.rstrip("\n") for line in f if line.strip() and not line.startswith("#")]
    if lines and lines[0].split("\t") != MANIFEST_HEADER:
        raise Refused(f"{path}: header must be exactly {' / '.join(MANIFEST_HEADER)}")
    rows = [line.split("\t") for line in lines[1:]]
    for line, cells in zip(lines[1:], rows):
        if len(cells) != len(MANIFEST_HEADER):
            raise Refused(f"{path}: expected {len(MANIFEST_HEADER)} tab-separated columns: {line!r}")
    return rows


def _build_entry(source: str, target: str, manifest: str, paths: KeelPaths) -> LinkEntry:
    expanded = expand_placeholders(source, paths, manifest)
    if not os.path.isabs(expanded):
        raise Refused(f"{manifest}: source must be absolute after expansion: {source}")
    if os.path.isabs(target) or ".." in target.split("/") or target in ("", "-", "."):
        raise Refused(f"{manifest}: target must be a relative path inside KEEL_DATA_DIR without '..': {target}")
    return LinkEntry(source=os.path.normpath(expanded), target=os.path.normpath(target))

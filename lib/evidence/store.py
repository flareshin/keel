"""The evidence files: where they live, how they are written, how they are read back."""
from __future__ import annotations

import json
import os
import tempfile
from typing import List, Optional

from evidence import env

REPO_SCOPED_KINDS = ("review", "tests", "smoke")
GLOBAL_KINDS = ("approval", "ack")
SCHEMA = 1


class EvidenceError(Exception):
    """A stored evidence file cannot be trusted (unreadable or not an object)."""


def evidence_root() -> str:
    return os.path.join(env.state_dir(), "evidence")


def kind_dir(kind: str, repo_key: Optional[str] = None) -> str:
    if kind not in REPO_SCOPED_KINDS:
        return os.path.join(evidence_root(), kind)
    if not repo_key:
        raise ValueError("%s evidence is scoped to a repo" % kind)
    return os.path.join(evidence_root(), kind, repo_key.replace("/", "__"))


def write(kind: str, body: dict, repo_key: Optional[str] = None) -> dict:
    """Write one evidence file atomically (0600 in 0700 dirs) and return the full object."""
    now = env.utc_now()
    evidence = {
        "schema": SCHEMA,
        "kind": kind,
        "evidence_id": env.new_id(kind, now, env.EVIDENCE_ID_RANDOM_BYTES),
        "created_at": env.iso(now),
        "expires_at": env.iso(now + env.EVIDENCE_TTL),
    }
    evidence.update(body)
    directory = kind_dir(kind, repo_key)
    _ensure_private_dirs(directory)
    final = os.path.join(directory, evidence["evidence_id"] + ".json")
    handle, temp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(evidence, stream, sort_keys=True)
            stream.write("\n")
        os.replace(temp, final)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise
    return evidence


def load(kind: str, repo_key: Optional[str] = None) -> List[dict]:
    """Unexpired evidence of one kind, oldest first; a corrupt file raises (the gate fails closed)."""
    now = env.iso(env.utc_now())
    live = [evidence for evidence in map(read_file, list_files(kind, repo_key)) if evidence["expires_at"] >= now]
    return sorted(live, key=lambda evidence: (evidence["created_at"], evidence["evidence_id"]))


def list_files(kind: str, repo_key: Optional[str] = None) -> List[str]:
    directory = kind_dir(kind, repo_key)
    if not os.path.isdir(directory):
        return []
    return [os.path.join(directory, name) for name in sorted(os.listdir(directory))
            if name.endswith(".json") and not name.startswith(".")]


def repo_keys(kind: str) -> List[str]:
    directory = os.path.join(evidence_root(), kind)
    if not os.path.isdir(directory):
        return []
    return sorted(name.replace("__", "/", 1) for name in os.listdir(directory)
                  if os.path.isdir(os.path.join(directory, name)))


def read_file(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as stream:
            evidence = json.load(stream)
    except (OSError, ValueError) as error:
        raise EvidenceError("unreadable evidence %s: %s" % (path, error)) from error
    if not isinstance(evidence, dict) or not isinstance(evidence.get("expires_at"), str):
        raise EvidenceError("not an evidence object: " + path)
    return evidence


def _ensure_private_dirs(directory: str) -> None:
    root = evidence_root()
    os.makedirs(directory, mode=0o700, exist_ok=True)
    current = directory
    while True:
        os.chmod(current, 0o700)
        if current == root or len(current) <= len(root):
            break
        current = os.path.dirname(current)

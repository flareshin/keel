"""The hook payload contract (DESIGN Interfaces (g)). A missing field means Claude Code changed its payload
shape: the hook logs `contract-miss` naming the fields, the keys it got and the Claude Code version."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from hookkit.env import data_dir

OUTCOME = "contract-miss"
VERSION_TIMEOUT_SECONDS = 5
UNKNOWN_VERSION = "unknown"
VERSION_RE = re.compile(r"\d+\.\d+\.\d+")


def missing_fields(payload: dict, *names: str) -> list:
    """The dotted names (`tool_input.message`) whose value is absent, None or an empty string."""
    missing = []
    for name in names:
        value = payload
        for part in name.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if value is None or value == "":
            missing.append(name)
    return missing


def miss_detail(payload: dict, missing: list) -> str:
    return "contract-miss: missing %s; keys=%s; cc_version=%s" % (
        ",".join(missing), ",".join(sorted(str(key) for key in payload)), cc_version(payload.get("session_id")))


def cc_version(session) -> str:
    """`claude --version`, asked once per session and cached under the data dir."""
    cache = Path(data_dir(), "state", "keel", "sessions", "%s.cc-version" % re.sub(r"[^\w.-]", "_", str(session or "-")))
    try:
        return cache.read_text(encoding="utf-8").strip() or UNKNOWN_VERSION
    except OSError:
        version = _ask_claude()
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(version, encoding="utf-8")
    except OSError:
        pass  # without the cache the next miss asks claude again; the version is still logged
    return version


def _ask_claude() -> str:
    try:
        completed = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=VERSION_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return UNKNOWN_VERSION
    match = VERSION_RE.search(completed.stdout)
    return match.group(0) if match else UNKNOWN_VERSION

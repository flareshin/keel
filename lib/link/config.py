from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass

from measurekit import env

EXIT_OK = 0
EXIT_NEGATIVE = 1
EXIT_REFUSED = 3
EXIT_INTERNAL = 70

_PLACEHOLDER = re.compile(r"\{\{([^{}]*)\}\}")


class Refused(Exception):
    """Invalid input or an unsafe target; bin/link exits 3 and writes nothing."""


@dataclass(frozen=True)
class KeelPaths:
    keel_home: str
    overlay_dir: str
    data_dir: str


def resolve_paths() -> KeelPaths:
    return KeelPaths(os.path.realpath(env.keel_home()), os.path.realpath(env.overlay_dir()), os.path.abspath(env.data_dir()))


def expand_placeholders(text: str, paths: KeelPaths, where: str) -> str:
    values = {"KEEL": paths.keel_home, "OVERLAY": paths.overlay_dir, "DATA": paths.data_dir}

    def substitute(match: re.Match) -> str:
        name = match.group(1)
        if name not in values:
            raise Refused(f"{where}: unknown placeholder {{{{{name}}}}}")
        return values[name]

    return _PLACEHOLDER.sub(substitute, text)


def run_git(cwd: str, *args: str) -> str | None:
    """stdout of a git command, or None when git reports failure (not a repo, missing object, unset key)."""
    if not os.path.isdir(cwd):
        return None
    result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def read_text(path: str) -> str:
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)

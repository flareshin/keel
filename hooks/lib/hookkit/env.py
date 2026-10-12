"""Locations every keel hook resolves the same way (DESIGN Interfaces (a) and (i))."""
from __future__ import annotations

import os


def data_dir() -> str:
    return os.path.expanduser(os.environ.get("KEEL_DATA_DIR") or "~/.claude")


def overlay_dir() -> str:
    return os.path.expanduser(os.environ.get("KEEL_OVERLAY_DIR") or "~/git/keel-overlay")


def overlay_path(*parts: str) -> str:
    return os.path.join(overlay_dir(), *parts)


def keel_home() -> str:
    configured = os.environ.get("KEEL_HOME")
    if configured:
        return os.path.expanduser(configured)
    hookkit_dir = os.path.dirname(os.path.realpath(__file__))
    return os.path.dirname(os.path.dirname(os.path.dirname(hookkit_dir)))


def keel_cli() -> str:
    return os.environ.get("KEEL_CLI") or os.path.join(keel_home(), "bin", "keel")


def boundary_scanner() -> str:
    return os.environ.get("KEEL_BOUNDARY") or os.path.join(keel_home(), "measure", "boundary")

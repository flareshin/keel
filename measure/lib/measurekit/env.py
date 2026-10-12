"""Locations shared by every measure command (Interfaces (i))."""
from __future__ import annotations

import os

CHECKOUT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))))


def keel_home() -> str:
    return os.environ.get("KEEL_HOME") or CHECKOUT_ROOT


def overlay_dir() -> str:
    return os.path.expanduser(os.environ.get("KEEL_OVERLAY_DIR") or "~/git/keel-overlay")


def data_dir() -> str:
    return os.path.expanduser(os.environ.get("KEEL_DATA_DIR") or "~/.claude")


def logs_dir() -> str:
    return os.path.join(data_dir(), "logs")

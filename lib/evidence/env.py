"""Data-dir resolution, identifiers and timestamps shared by every evidence module."""
from __future__ import annotations

import datetime
import json
import os
import re
import secrets

RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
EVIDENCE_TTL = datetime.timedelta(days=14)
GITLINK_MODE = "160000"
DELETED_MODE = "000000"
EVIDENCE_ID_RANDOM_BYTES = 4
RUN_ID_RANDOM_BYTES = 3


def data_dir() -> str:
    return os.path.expanduser(os.environ.get("KEEL_DATA_DIR") or "~/.claude")


def overlay_dir() -> str:
    return os.path.expanduser(os.environ.get("KEEL_OVERLAY_DIR") or "~/git/keel-overlay")


def state_dir() -> str:
    return os.path.join(data_dir(), "state", "keel")


def logs_dir() -> str:
    return os.path.join(data_dir(), "logs")


def append_log_line(name: str, line: dict) -> None:
    os.makedirs(logs_dir(), exist_ok=True)
    with open(os.path.join(logs_dir(), name), "a", encoding="utf-8") as stream:
        stream.write(json.dumps(line, sort_keys=True) + "\n")


def utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(moment: datetime.datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str, moment: datetime.datetime, random_bytes: int) -> str:
    return "%s-%s-%s" % (prefix, moment.strftime("%Y%m%dT%H%M%SZ"), secrets.token_hex(random_bytes))

"""Evidence garbage collection (Interfaces (c)): expired files."""
from __future__ import annotations

import os
import sys
from typing import Optional

from evidence import env, store
from evidence.store import EvidenceError


def collect() -> int:
    """Delete expired evidence, which no gate reads again; an unreadable file is reported and left alone."""
    now = env.iso(env.utc_now())
    targets = [(kind, key) for kind in store.REPO_SCOPED_KINDS for key in store.repo_keys(kind)]
    targets += [(kind, None) for kind in store.GLOBAL_KINDS]
    return sum(_sweep(kind, repo_key, now) for kind, repo_key in targets)


def _sweep(kind: str, repo_key: Optional[str], now: str) -> int:
    deleted = 0
    for path in store.list_files(kind, repo_key):
        try:
            evidence = store.read_file(path)
        except EvidenceError as error:
            print("keel evidence gc: skipped %s" % error, file=sys.stderr)
            continue
        if evidence["expires_at"] < now:
            os.unlink(path)
            deleted += 1
    return deleted

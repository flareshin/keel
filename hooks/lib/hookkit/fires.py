"""Append-only decision log `keel-fires.jsonl` (DESIGN Interfaces (f))."""
from __future__ import annotations

import json
import os
import sys
import time

from hookkit.env import data_dir

DETAIL_LIMIT = 200


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class FireLog:
    """One hook's view of the fires log, bound to the hook name and the payload's session."""

    def __init__(self, hook: str, session: str | None):
        self.hook = hook
        self.session = session or "-"

    def append(self, rule_id: str, outcome: str, **optional) -> None:
        record = {"ts": utc_now(), "rule_id": rule_id, "hook": self.hook, "outcome": outcome, "session": self.session}
        record.update((key, str(value)[:DETAIL_LIMIT] if key == "detail" else value)
                      for key, value in optional.items() if value is not None)
        path = os.path.join(data_dir(), "logs", "keel-fires.jsonl")
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError as error:
            # Not raised: a full disk must not turn a deny into a pass or a pass into a crash.
            sys.stderr.write("%s: could not append keel-fires.jsonl (%r)\n" % (self.hook, error))

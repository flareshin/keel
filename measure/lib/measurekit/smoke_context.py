"""What every smoke check reads, gathered once per run."""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, timedelta

from measurekit import env
from measurekit.ledger import Ledger, LedgerRow, all_rows, counted_rows, load_ledgers_from
from measurekit.metrics import DEFAULT_WINDOW_DAYS


@dataclass
class SmokeContext:
    keel_home: str
    overlay_dir: str
    data_dir: str
    today: date
    ledgers: list[Ledger]
    candidate: bool = False

    @classmethod
    def from_environment(cls, candidate: bool = False) -> SmokeContext:
        keel_home, overlay_dir = env.keel_home(), env.overlay_dir()
        return cls(keel_home, overlay_dir, env.data_dir(), date.today(), load_ledgers_from(keel_home, overlay_dir), candidate)

    @property
    def rows(self) -> list[LedgerRow]:
        return all_rows(self.ledgers)

    @property
    def counted_rows(self) -> list[LedgerRow]:
        return counted_rows(self.ledgers)

    @property
    def metric_window_start(self) -> date:
        return self.today - timedelta(days=DEFAULT_WINDOW_DAYS)

    def memory_indexes(self) -> list[str]:
        projects = os.path.join(self.data_dir, "projects")
        if not os.path.isdir(projects):
            return []
        candidates = [os.path.join(projects, name, "memory", "MEMORY.md") for name in sorted(os.listdir(projects))]
        return [path for path in candidates if os.path.isfile(path)]


def assertion(check: str, scope: str, status: str, detail: str) -> dict:
    return {"check": check, "scope": scope, "status": status, "detail": detail}


def first_items(items: list[str], limit: int = 5) -> str:
    shown = "; ".join(items[:limit])
    return shown if len(items) <= limit else "%s; ... (%d more)" % (shown, len(items) - limit)

"""The two ledgers (keel and overlay): loading and the per-row format rules of Interfaces (b)."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, fields
from datetime import date, datetime

from measurekit.datafiles import TsvError, data_lines, read_tsv_lines

KEEL_SOURCE = "keel"
OVERLAY_SOURCE = "overlay"
EMPTY = "-"

LAYERS = ("repo", "hook", "skill", "prose")
TYPES = ("knowledge", "incentive", "floor")
STATUSES = ("active", "proposed-demote", "retired")
RETIRED = "retired"
CHARTER_SCOPE = "charter"
STACK_SCOPE_PREFIX = "stack:"
FLOOR_TYPE = "floor"

ID_PATTERN = re.compile(r"^(K[1-7]|risk|[CSOF]-[a-z0-9-]+)$")
SCOPE_PATTERN = re.compile(r"^(charter|core|overlay|stack:[a-z0-9-]+)$")
ENFORCED_AT_PATTERN = re.compile(r"^(hook|skill):[a-z0-9-]+$|^prose:\S+$|^repo:[^:\s/]+/[^:\s/]+:\S+$")
METRIC_PATTERN = re.compile(r"^(fires|evals):\S+$|^run:[A-Za-z0-9._-]+$|^exists:[^:]+:[^:]+:.+$")
INCIDENT_PATTERN = re.compile(r"^docs/incidents/[A-Za-z0-9._-]+\.md$|^private:[A-Za-z0-9._-]+$")
STACK_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")


@dataclass
class LedgerRow:
    source: str
    line: int
    id: str
    scope: str
    type: str
    statement: str
    layer: str
    enforced_at: str
    why_not_stronger: str
    justification: str
    incidents: str
    metric: str
    review_by: str
    grace_until: str
    status: str

    @property
    def is_charter_or_floor(self) -> bool:
        return self.scope == CHARTER_SCOPE or self.type == FLOOR_TYPE

    @property
    def hook_name(self) -> str | None:
        """`git-guard` for a hook-layer row enforced at `hook:git-guard`; None for other layers."""
        if self.layer != "hook":
            return None
        return self.enforced_at.partition(":")[2]

    @property
    def incident_refs(self) -> list[str]:
        if self.incidents == EMPTY:
            return []
        return [ref.strip() for ref in self.incidents.split(",") if ref.strip()]

    def is_in_grace(self, today: date) -> bool:
        grace_until = parse_date(self.grace_until)
        return grace_until is not None and today <= grace_until


COLUMNS = tuple(column.name for column in fields(LedgerRow))[2:]


@dataclass
class Ledger:
    source: str
    path: str
    present: bool
    rows: list[LedgerRow] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def load_ledgers_from(keel_home: str, overlay_dir: str) -> list[Ledger]:
    return [
        load_ledger(os.path.join(keel_home, "ledger.tsv"), KEEL_SOURCE),
        load_ledger(os.path.join(overlay_dir, "ledger.tsv"), OVERLAY_SOURCE),
    ]


def load_ledger(path: str, source: str) -> Ledger:
    """Parses what it can; header and column-count problems are recorded, not raised."""
    ledger = Ledger(source=source, path=path, present=os.path.exists(path))
    if not ledger.present:
        return ledger
    try:
        lines = read_tsv_lines(path, COLUMNS)
    except TsvError as error:
        ledger.problems.append(str(error))
        return ledger
    for number, cells in lines:
        if len(cells) != len(COLUMNS):
            ledger.problems.append("line %d: expected %d columns, found %d" % (number, len(COLUMNS), len(cells)))
            continue
        ledger.rows.append(LedgerRow(source, number, *cells))
    return ledger


def all_rows(ledgers: list[Ledger]) -> list[LedgerRow]:
    return [row for ledger in ledgers for row in ledger.rows]


def counted_rows(ledgers: list[Ledger]) -> list[LedgerRow]:
    """Rows that count toward caps: everything except retired rows."""
    return [row for row in all_rows(ledgers) if row.status != RETIRED]


def hook_rows_in_force(ledgers: list[Ledger], active_stacks: list[str]) -> list[LedgerRow]:
    """Counted hook-layer rows, minus rows of stacks the overlay has not activated."""
    return [
        row for row in counted_rows(ledgers)
        if row.hook_name and (not row.scope.startswith(STACK_SCOPE_PREFIX) or row.scope[len(STACK_SCOPE_PREFIX):] in active_stacks)
    ]


def active_stack_names(overlay_dir: str) -> list[str]:
    """Stack names listed in the overlay's stacks.txt; raises ValueError on a name that is not plain."""
    stacks_file = os.path.join(overlay_dir, "stacks.txt")
    if not os.path.isfile(stacks_file):
        return []
    names = [line.strip() for _, line in data_lines(stacks_file)]
    for name in names:
        if not STACK_NAME_PATTERN.match(name):
            raise ValueError("%s: invalid stack name %r" % (stacks_file, name))
    return names


def parse_date(value: str) -> date | None:
    """None for '-' and for anything that is not YYYY-MM-DD."""
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def validate_row(row: LedgerRow) -> list[str]:
    """Format problems of one row, each prefixed with its id."""
    scope_known = SCOPE_PATTERN.match(row.scope) is not None
    enforced_at_known = ENFORCED_AT_PATTERN.match(row.enforced_at) is not None
    bad_refs = [ref for ref in row.incident_refs if not INCIDENT_PATTERN.match(ref)]
    checks = (  # (violated, message), in report order
        (not ID_PATTERN.match(row.id), "id does not match %s" % ID_PATTERN.pattern),
        (not scope_known, "unknown scope %r" % row.scope),
        (scope_known and row.scope != _expected_scope(row), "id prefix needs scope %s" % _expected_scope(row)),
        ((row.scope == "overlay") != (row.source == OVERLAY_SOURCE),
         "overlay rows live only in the overlay ledger, and it holds only overlay rows"),
        (row.type not in TYPES, "unknown type %r" % row.type),
        (row.id.startswith("F-") != (row.type == FLOOR_TYPE), "F- ids and type=floor go together"),
        (row.statement == EMPTY or not row.statement.strip(), "statement is empty"),
        (row.layer not in LAYERS, "unknown layer %r" % row.layer),
        (not enforced_at_known, "enforced_at %r is not hook:/skill:/prose:/repo:<owner/repo>:<path>" % row.enforced_at),
        (enforced_at_known and row.enforced_at.split(":", 1)[0] != row.layer, "enforced_at kind differs from layer %r" % row.layer),
        (row.layer in ("skill", "prose") and row.why_not_stronger == EMPTY, "layer %s needs why_not_stronger" % row.layer),
        (row.is_charter_or_floor and row.justification == EMPTY, "charter and floor rows need a justification"),
        (bool(bad_refs), "bad incident refs: %s" % ",".join(bad_refs)),
        (row.metric != EMPTY and not METRIC_PATTERN.match(row.metric), "metric %r is not fires:/evals:/run:/exists:" % row.metric),
        (row.review_by != EMPTY and parse_date(row.review_by) is None, "review_by %r is not YYYY-MM-DD" % row.review_by),
        (row.grace_until != EMPTY and parse_date(row.grace_until) is None, "grace_until %r is not YYYY-MM-DD" % row.grace_until),
        (row.is_charter_or_floor and row.review_by != EMPTY, "charter and floor rows use review_by '-'"),
        (not row.is_charter_or_floor and row.review_by == EMPTY, "review_by is required"),
        (row.status not in STATUSES, "unknown status %r" % row.status),
    )
    return ["%s (line %d): %s" % (row.id, row.line, message) for violated, message in checks if violated]


def _expected_scope(row: LedgerRow) -> str:
    if row.id.startswith("K"):
        return CHARTER_SCOPE
    if row.id.startswith("S-"):
        return row.scope if row.scope.startswith("stack:") else "stack:<name>"
    if row.id.startswith("O-"):
        return "overlay"
    return "core"

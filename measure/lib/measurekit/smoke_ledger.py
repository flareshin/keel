"""Smoke checks over the ledger rows themselves: format, ids, row caps, rule of two, metrics, expiry."""
from __future__ import annotations

import glob
import os
from collections import Counter

from measurekit.ledger import KEEL_SOURCE, OVERLAY_SOURCE, LedgerRow, validate_row
from measurekit.metrics import FAIL, GRACE, PASS, WARN, evaluate_metric
from measurekit.propose import is_past_review
from measurekit.smoke_context import SmokeContext, assertion, first_items

CHARTER_CAP = 7
CORE_CAP = 10
STACK_CAP = 10
STACKS_CAP = 5
OVERLAY_CAP = 15
MIN_INCIDENTS = 2
PRIVATE_REF_PREFIX = "private:"


def check_ledger_format(ctx: SmokeContext) -> list[dict]:
    results = []
    for ledger in ctx.ledgers:
        if not ledger.present:
            status = FAIL if ledger.source == KEEL_SOURCE else PASS
            results.append(assertion("ledger-format", ledger.source, status, "no ledger at %s" % ledger.path))
            continue
        problems = ledger.problems + [problem for row in ledger.rows for problem in validate_row(row)]
        status = FAIL if problems else PASS
        detail = first_items(problems) if problems else "%d rows" % len(ledger.rows)
        results.append(assertion("ledger-format", ledger.source, status, detail))
    return results


def check_id_unique(ctx: SmokeContext) -> list[dict]:
    duplicates = sorted(row_id for row_id, count in Counter(row.id for row in ctx.rows).items() if count > 1)
    if duplicates:
        return [assertion("id-unique", "all", FAIL, "duplicate ids: " + ", ".join(duplicates))]
    return [assertion("id-unique", "all", PASS, "%d ids" % len(ctx.rows))]


def check_row_caps(ctx: SmokeContext) -> list[dict]:
    rows = ctx.counted_rows
    stack_scopes = sorted({row.scope for row in rows if row.scope.startswith("stack:")})
    results = [
        _cap("charter", sum(1 for row in rows if row.scope == "charter"), CHARTER_CAP),
        _cap("core", sum(1 for row in rows if row.scope == "core" and row.type != "floor"), CORE_CAP),
    ]
    results += [_cap(scope, sum(1 for row in rows if row.scope == scope), STACK_CAP) for scope in stack_scopes]
    results.append(_cap("stacks", len(stack_scopes), STACKS_CAP))
    results.append(_cap("overlay", sum(1 for row in rows if row.scope == "overlay"), OVERLAY_CAP))
    return results


def _cap(scope: str, count: int, cap: int) -> dict:
    return assertion("caps", scope, PASS if count <= cap else FAIL, "%d/%d" % (count, cap))


def check_rule_of_two(ctx: SmokeContext) -> list[dict]:
    results = []
    for source in (KEEL_SOURCE, OVERLAY_SOURCE):
        rows = [row for row in ctx.counted_rows if row.source == source and not row.is_charter_or_floor]
        failing, in_grace = [], []
        for row in rows:
            problem = _rule_of_two_problem(row, ctx.keel_home)
            if problem:
                (in_grace if row.is_in_grace(ctx.today) else failing).append("%s: %s" % (row.id, problem))
        needs_incidents = source == KEEL_SOURCE and (failing or in_grace)
        note = _incident_candidates_note(ctx.data_dir) if needs_incidents else ""
        results.append(_rows_assertion("rule-of-two", source, failing, in_grace, len(rows), note))
    return results


def _rule_of_two_problem(row: LedgerRow, keel_home: str) -> str:
    refs = sorted(set(row.incident_refs))
    private_refs = [ref for ref in refs if ref.startswith(PRIVATE_REF_PREFIX)]
    if row.source == KEEL_SOURCE and private_refs:
        return "private refs belong only in the overlay ledger"
    missing = [ref for ref in refs if ref not in private_refs and not os.path.isfile(os.path.join(keel_home, ref))]
    if missing:
        return "missing incident files: " + ",".join(missing)
    if len(refs) < MIN_INCIDENTS:
        return "%d of %d incident refs" % (len(refs), MIN_INCIDENTS)
    return ""


def _incident_candidates_note(data_dir: str) -> str:
    candidates = sorted(glob.glob(os.path.join(data_dir, "projects", "*", "memory", "feedback_*")))
    if not candidates:
        return ""
    names = [os.path.basename(path) for path in candidates]
    return ", incident candidates (feedback memories): " + first_items(names)


def check_metrics(ctx: SmokeContext) -> list[dict]:
    results = []
    for source in (KEEL_SOURCE, OVERLAY_SOURCE):
        rows = [row for row in ctx.counted_rows if row.source == source]
        failing, in_grace = [], []
        for row in rows:
            outcome = evaluate_metric(row, ctx.metric_window_start, ctx.today)
            note = "%s: %s" % (row.id, outcome.get("error", "0 items for %s" % row.metric))
            if outcome["status"] == FAIL:
                failing.append(note)
            elif outcome["status"] == GRACE:
                in_grace.append(note)
        results.append(_rows_assertion("metrics", source, failing, in_grace, len(rows)))
    return results


def _rows_assertion(check: str, source: str, failing: list[str], in_grace: list[str], checked: int, note: str = "") -> dict:
    parts = ["%d rows checked" % checked]
    if failing:
        parts.append("failing: " + "; ".join(failing))
    if in_grace:
        parts.append("in grace: " + "; ".join(in_grace))
    return assertion(check, source, FAIL if failing else GRACE if in_grace else PASS, ", ".join(parts) + note)


def check_expiry(ctx: SmokeContext) -> list[dict]:
    expired = [row.id for row in ctx.counted_rows if is_past_review(row, ctx.today)]
    if not expired:
        return [assertion("expiry", "all", PASS, "no row past review_by")]
    detail = "past review_by: %s (run measure/propose for demotion or extension proposals)" % ", ".join(expired)
    return [assertion("expiry", "all", WARN, detail)]

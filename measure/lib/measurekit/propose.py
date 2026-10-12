"""Expiry review (DESIGN §4): proposals only; nothing here edits a ledger."""
from __future__ import annotations

from datetime import date, timedelta

from measurekit.ledger import LedgerRow, parse_date
from measurekit.metrics import evaluate_metric

NEXT_LOWER_LAYER = {"hook": "skill", "skill": "prose", "prose": "retired"}
REVIEW_EXTENSION_DAYS = 60
REPO_LAYER = "repo"
ACTIVE = "active"


def build_expiry_proposals(rows: list[LedgerRow], since: date, today: date) -> list[dict]:
    return [_propose_from_metric(row, since, today) for row in rows if row.status == ACTIVE and is_past_review(row, today)]


def _propose_from_metric(row: LedgerRow, since: date, today: date) -> dict:
    """A metric that could not run counted nothing, so it is never a reason to demote."""
    result = evaluate_metric(row, since, today)
    if "error" in result:
        return _proposal(row, "recheck", row.layer, row.layer, "metric errored, nothing counted: %s" % result["error"])
    return propose_for_expired_row(row, result["count"], today)


def is_past_review(row: LedgerRow, today: date) -> bool:
    review_by = parse_date(row.review_by)
    return review_by is not None and today > review_by


def propose_for_expired_row(row: LedgerRow, count: int, today: date) -> dict:
    """Repo rows never demote on zero violations; other rows demote one layer when nothing was counted."""
    if row.layer == REPO_LAYER and count == 0:
        return _proposal(row, "recheck", REPO_LAYER, REPO_LAYER, "repo rule's existence check failed; re-check where it lives")
    if row.layer == REPO_LAYER or count > 0:
        new_review_by = (today + timedelta(days=REVIEW_EXTENSION_DAYS)).isoformat()
        return _proposal(row, "extend", row.review_by, new_review_by, "metric counted %d item(s) in the window" % count)
    lower = NEXT_LOWER_LAYER.get(row.layer, row.layer)
    action = "retire" if lower == "retired" else "demote"
    return _proposal(row, action, row.layer, lower, "metric counted 0 items in the window past review_by")


def build_rereview_proposals(rows: list[LedgerRow], model: str) -> list[dict]:
    reason = "model upgrade to %s: re-run this row's evals before keeping it" % model
    return [_proposal(row, "rereview", row.layer, row.layer, reason) for row in rows if row.status == ACTIVE]


def _proposal(row: LedgerRow, action: str, from_value: str, to_value: str, reason: str) -> dict:
    return {"id": row.id, "action": action, "from": from_value, "to": to_value, "reason": reason}

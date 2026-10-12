"""Evaluates one ledger row's metric (Interfaces (e) `measure/run`)."""
from __future__ import annotations

import json
import os
import subprocess
from datetime import date
from typing import List, Tuple

from measurekit import env
from measurekit.datafiles import read_jsonl
from measurekit.gitutil import git_succeeds
from measurekit.ledger import EMPTY, LedgerRow

PASS, FAIL, GRACE, WARN = "PASS", "FAIL", "GRACE", "WARN"
DEFAULT_WINDOW_DAYS = 60
RUNNER_TIMEOUT_SECONDS = 120
STDERR_EXCERPT_CHARS = 200
NON_DECISION_OUTCOMES = {"error", "contract-miss"}  # a hook failure or a payload-shape change, not a rule firing


class MetricError(Exception):
    pass


def evaluate_metric(row: LedgerRow, since: date, today: date) -> dict:
    result = {"id": row.id, "metric": row.metric, "count": 0, "items": []}
    try:
        count, items = collect_metric_items(row.metric, since)
    except MetricError as error:
        result.update(status=FAIL, error=str(error))
        return result
    status = PASS if count > 0 else GRACE if row.is_in_grace(today) else FAIL
    result.update(count=count, items=items, status=status)
    return result


def collect_metric_items(metric: str, since: date) -> Tuple[int, List]:
    if metric == EMPTY:
        raise MetricError("row has no metric")
    kind, _, argument = metric.partition(":")
    collectors = {"fires": _fires_items, "evals": _eval_items, "run": _runner_items, "exists": _existence_items}
    if kind not in collectors:
        raise MetricError("unknown metric kind %r" % kind)
    return collectors[kind](argument, since)


def _fires_items(rule_id: str, since: date) -> Tuple[int, List]:
    records, _ = read_jsonl(os.path.join(env.logs_dir(), "keel-fires.jsonl"))
    items = [
        record for record in records
        if record.get("rule_id") == rule_id
        and record.get("outcome") not in NON_DECISION_OUTCOMES
        and _is_within_window(record, since)
    ]
    return len(items), items


def _eval_items(eval_id: str, since: date) -> Tuple[int, List]:
    records, _ = read_jsonl(os.path.join(env.logs_dir(), "keel-evals.jsonl"))
    items = [
        record for record in records
        if record.get("eval_id") == eval_id and record.get("pass") is True and _is_within_window(record, since)
    ]
    return len(items), items


def _is_within_window(record: dict, since: date) -> bool:
    return str(record.get("ts", ""))[:10] >= since.isoformat()


def _runner_items(runner: str, since: date) -> Tuple[int, List]:
    path = find_runner(runner)
    if path is None:
        raise MetricError("no runner measure/metrics/%s in keel or overlay" % runner)
    try:
        completed = subprocess.run([path, "--since", since.isoformat()], capture_output=True, text=True, timeout=RUNNER_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MetricError("runner %s could not run: %s" % (runner, error))
    if completed.returncode != 0:
        raise MetricError("runner %s exited %d: %s" % (runner, completed.returncode, stderr_excerpt(completed)))
    try:
        payload = json.loads(completed.stdout)
    except ValueError:
        raise MetricError("runner %s did not print one JSON object" % runner)
    if not isinstance(payload, dict) or not isinstance(payload.get("count"), int) or not isinstance(payload.get("items"), list):
        raise MetricError('runner %s must print {"count": int, "items": [...]}' % runner)
    return payload["count"], payload["items"]


def find_runner(runner: str) -> str | None:
    candidates = [os.path.join(root, "measure", "metrics", runner) for root in (env.keel_home(), env.overlay_dir())]
    return next((path for path in candidates if os.path.isfile(path) and os.access(path, os.X_OK)), None)


def _existence_items(argument: str, since: date) -> Tuple[int, List]:
    """`<repo path>:<ref>:<path>` counts 1 item when `git show <ref>:<path>` succeeds."""
    parts = argument.split(":", 2)
    if len(parts) != 3:
        raise MetricError("exists metric needs <repo path>:<ref>:<path>")
    repo, ref, path = parts
    object_name = "%s:%s" % (ref, path)
    if not git_succeeds(os.path.expanduser(repo), ["cat-file", "-e", object_name]):
        return 0, []
    return 1, [object_name]


def stderr_excerpt(completed: subprocess.CompletedProcess) -> str:
    return completed.stderr.strip()[:STDERR_EXCERPT_CHARS]

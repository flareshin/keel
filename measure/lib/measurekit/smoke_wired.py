"""Smoke kind `wired-fires`: every hook-layer row's hook is registered in the live settings and fires.

Fixture format and run isolation: DESIGN Interfaces (e), smoke check `wired-fires`.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile

from measurekit.datafiles import read_jsonl
from measurekit.hook_settings import Registration, iter_registrations
from measurekit.ledger import KEEL_SOURCE, LedgerRow, active_stack_names, hook_rows_in_force
from measurekit.metrics import FAIL, PASS
from measurekit.overlay_checkout import is_under, main_worktree_overlay
from measurekit.smoke_context import SmokeContext, assertion, first_items

FIXTURES_DIR = os.path.join("tests", "hooks", "fixtures")
TMP_PLACEHOLDER = "{{TMP}}"
DEFAULT_TIMEOUT_SECONDS = 60


class _Unproven(Exception):
    """A fixture that could not show the hook works; the message names what is missing."""


def check_wired_fires(ctx: SmokeContext) -> list[dict]:
    try:
        rows = hook_rows_in_force(ctx.ledgers, active_stack_names(ctx.overlay_dir))
        registrations = list(iter_registrations(_live_hooks(ctx.data_dir)))
    except (ValueError, OSError) as error:
        return [assertion("wired-fires", "all", FAIL, str(error))]
    if not rows:
        return [assertion("wired-fires", "all", FAIL, "0 hook-layer rows recognized")]
    real_fires = os.path.join(ctx.data_dir, "logs", "keel-fires.jsonl")
    before = _fingerprint(real_fires)
    problems = [problem for row in rows for problem in [_bad_fixture_problem(row, ctx, registrations)] if problem]
    hook_names = sorted({row.hook_name for row in rows})
    problems += [problem for hook in hook_names for problem in [_good_fixture_problem(hook, ctx, registrations)] if problem]
    if _fingerprint(real_fires) != before:
        problems.append("the real keel-fires.jsonl changed during the run (a hook ignores KEEL_DATA_DIR)")
    if problems:
        return [assertion("wired-fires", "all", FAIL, first_items(problems))]
    return [assertion("wired-fires", "all", PASS, "%d rows fired on bad fixtures, %d hooks quiet on good ones" % (len(rows), len(hook_names)))]


def _bad_fixture_problem(row: LedgerRow, ctx: SmokeContext, registrations: list[Registration]) -> str | None:
    checkout = ctx.keel_home if row.source == KEEL_SOURCE else ctx.overlay_dir
    path = os.path.join(checkout, FIXTURES_DIR, "%s.bad.json" % row.id)
    try:
        fixture, exit_code, fires = _run_fixture(path, row.hook_name, registrations)
    except _Unproven as unproven:
        return "%s: %s" % (row.id, unproven)
    expected = fixture.get("expect")
    if any(fire.get("rule_id") == row.id and fire.get("outcome") == expected for fire in fires):
        return None
    return "%s: bad fixture logged no %s fires line for %s (exit %d)" % (row.id, expected, row.id, exit_code)


def _good_fixture_problem(hook: str, ctx: SmokeContext, registrations: list[Registration]) -> str | None:
    path = os.path.join(_hook_checkout(hook, ctx, registrations), FIXTURES_DIR, "%s.good.json" % hook)
    try:
        _, exit_code, fires = _run_fixture(path, hook, registrations)
    except _Unproven as unproven:
        return "%s: %s" % (hook, unproven)
    if fires:
        return "%s: good fixture fired %s" % (hook, ", ".join(sorted({str(fire.get("rule_id")) for fire in fires})))
    if exit_code != 0:
        return "%s: good fixture exited %d" % (hook, exit_code)
    return None


def _hook_checkout(hook: str, ctx: SmokeContext, registrations: list[Registration]) -> str:
    overlays = {os.path.realpath(ctx.overlay_dir), main_worktree_overlay(ctx.overlay_dir)} - {None}
    for registration in registrations:
        if registration.hook_name == hook and is_under(registration.script, overlays):
            return ctx.overlay_dir
    return ctx.keel_home


def _run_fixture(path: str, hook: str, registrations: list[Registration]) -> tuple[dict, int, list[dict]]:
    """(fixture, hook exit code, fires lines the hook wrote) for one fixture fed to the registered command."""
    fixture = _read_fixture(path)
    payload = fixture["payload"]
    registration = _find_registration(registrations, hook, payload)
    with tempfile.TemporaryDirectory(prefix="keel-wired-") as temp_dir:
        env = dict(os.environ, KEEL_DATA_DIR=os.path.join(temp_dir, "data"), KEEL_OVERLAY_DIR=os.path.join(temp_dir, "overlay"))
        for command in fixture.get("setup", []):
            if subprocess.run(command, shell=True, cwd=temp_dir, env=env, capture_output=True).returncode != 0:
                raise _Unproven("setup command failed in %s: %s" % (os.path.basename(path), command))
        stdin = json.dumps(payload).replace(TMP_PLACEHOLDER, json.dumps(temp_dir)[1:-1])
        try:
            completed = subprocess.run(
                registration.command, shell=True, input=stdin, cwd=temp_dir, env=env, capture_output=True, text=True,
                timeout=registration.hook.get("timeout", DEFAULT_TIMEOUT_SECONDS),
            )
        except subprocess.TimeoutExpired:
            raise _Unproven("hook timed out on %s" % os.path.basename(path))
        fires, _ = read_jsonl(os.path.join(temp_dir, "data", "logs", "keel-fires.jsonl"))
    return fixture, completed.returncode, fires


def _read_fixture(path: str) -> dict:
    if not os.path.isfile(path):
        raise _Unproven("missing fixture %s" % path)
    try:
        with open(path, encoding="utf-8") as handle:
            fixture = json.load(handle)
    except ValueError as error:
        raise _Unproven("unreadable fixture %s: %s" % (path, error))
    if not isinstance(fixture, dict) or not isinstance(fixture.get("payload"), dict):
        raise _Unproven("fixture %s has no payload object" % path)
    return fixture


def _find_registration(registrations: list[Registration], hook: str, payload: dict) -> Registration:
    event, tool = payload.get("hook_event_name"), payload.get("tool_name")
    for registration in registrations:
        if registration.hook_name == hook and registration.event == event and (tool is None or registration.covers_tool(tool)):
            if not os.path.isfile(registration.script):
                raise _Unproven("script missing: %s" % registration.script)
            return registration
    raise _Unproven("no %s[%s] registration of hook %s in settings.json" % (event, tool or "*", hook))


def _live_hooks(data_dir: str) -> dict:
    path = os.path.join(data_dir, "settings.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        settings = json.load(handle)
    return settings.get("hooks", {}) if isinstance(settings, dict) else {}


def _fingerprint(path: str) -> tuple[int, int] | None:
    try:
        stat = os.stat(path)
    except FileNotFoundError:
        return None
    return stat.st_size, stat.st_mtime_ns

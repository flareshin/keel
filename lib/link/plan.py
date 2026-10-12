from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from typing import Callable

from link import claude_md, links, settings_json
from link.atomic import move_aside, replace_with_symlink, write_text_atomic
from link.config import KeelPaths, read_text, run_git
from link.fragments import OWNED_KEYS, active_stacks, load_merged_fragments
from measurekit.hook_settings import Registration, iter_registrations
from measurekit.ledger import hook_rows_in_force, load_ledgers_from

BLOCKS_NEVER = "never"
BLOCKS_UNLESS_FORCED = "unless-forced"
BLOCKS_UNLESS_ADOPTED = "unless-adopted"
BLOCKS_ALWAYS = "always"
FORCE_FLAG = "--force"
ADOPT_FLAG = "--adopt"
# The --write flags that lift each block level; None = no flag lifts it. Order = flag order in the printed hint.
LIFTING_FLAGS = {
    BLOCKS_NEVER: (),
    BLOCKS_UNLESS_ADOPTED: (ADOPT_FLAG,),
    BLOCKS_UNLESS_FORCED: (FORCE_FLAG,),
    BLOCKS_ALWAYS: None,
}

CLAUDE_MD_MODE = 0o644
HOOKS_PATH = "githooks"
FAIL_CLOSED = "block"
GATED_TOOLS = {
    "ship-gate": ("Bash",),
    "git-guard": ("Bash", "Edit", "Write", "NotebookEdit"),
}


@dataclass(frozen=True)
class Problem:
    kind: str
    path: str
    detail: str
    blocks_write: str = BLOCKS_NEVER

    @property
    def lifting_flags(self) -> tuple[str, ...] | None:
        return LIFTING_FLAGS[self.blocks_write]

    def blocks(self, force: bool, adopt: bool) -> bool:
        given = {flag for flag, passed in ((FORCE_FLAG, force), (ADOPT_FLAG, adopt)) if passed}
        return self.lifting_flags is None or not set(self.lifting_flags) <= given

    def to_json(self) -> dict:
        return {"kind": self.kind, "path": self.path, "detail": self.detail}


@dataclass(frozen=True)
class Change:
    op: str
    path: str
    apply: Callable[[], None]

    def to_json(self) -> dict:
        return {"op": self.op, "path": self.path}


@dataclass
class Plan:
    changes: list[Change] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)
    merged_settings: dict = field(default_factory=dict)
    settings_backup: str | None = None
    dropped_settings: list[str] = field(default_factory=list)
    claude_md_bytes: int = 0
    claude_md_backup: str | None = None
    conflicts: list[str] = field(default_factory=list)


def build_plan(paths: KeelPaths) -> Plan:
    """Everything --write would change and every drift --check reports; touches nothing."""
    plan = Plan()
    backup_root = settings_json.new_backup_dir(paths)
    for entry in links.read_link_manifest(paths):
        _plan_link(plan, entry, paths, backup_root)
    _plan_claude_md(plan, paths, backup_root)
    _plan_settings(plan, paths, backup_root)
    _plan_hooks_path(plan, paths)
    return plan


def _plan_link(plan: Plan, entry: links.LinkEntry, paths: KeelPaths, backup_root: str) -> None:
    path = os.path.join(paths.data_dir, entry.target)
    backup_path = os.path.join(backup_root, entry.target)
    link_now = lambda: replace_with_symlink(entry.source, path)
    if not os.path.exists(entry.source):
        plan.problems.append(Problem("dangling", path, f"source does not exist: {entry.source}", BLOCKS_ALWAYS))
    elif not os.path.lexists(path):
        plan.problems.append(Problem("link-missing", path, f"should link to {entry.source}"))
        plan.changes.append(Change("symlink", path, link_now))
    elif not os.path.islink(path):
        detail = f"a real file or directory is in the way; --force moves it to {backup_path}"
        plan.problems.append(Problem("target-occupied", path, detail, BLOCKS_UNLESS_FORCED))
        plan.changes.append(Change("symlink", path, _after_moving_aside(path, backup_path, link_now)))
    elif os.readlink(path) == entry.source:
        return
    elif links.is_keel_link(path, paths):
        plan.problems.append(Problem("link-wrong", path, f"keel link points at {os.readlink(path)}, should be {entry.source}"))
        plan.changes.append(Change("replace-link", path, link_now))
    else:
        detail = f"foreign link points at {os.readlink(path)}, should be {entry.source}; --force moves it to {backup_path}"
        plan.problems.append(Problem("link-wrong", path, detail, BLOCKS_UNLESS_FORCED))
        plan.changes.append(Change("replace-link", path, _after_moving_aside(path, backup_path, link_now)))


def _plan_claude_md(plan: Plan, paths: KeelPaths, backup_root: str) -> None:
    path = os.path.join(paths.data_dir, claude_md.FILE_NAME)
    content = claude_md.build_claude_md(paths)
    write_now = lambda: write_text_atomic(path, content, CLAUDE_MD_MODE)
    plan.claude_md_bytes = len(content.encode("utf-8"))
    if plan.claude_md_bytes > claude_md.MAX_BYTES:
        detail = f"generated CLAUDE.md would be {plan.claude_md_bytes} bytes, over the {claude_md.MAX_BYTES}-byte cap"
        plan.problems.append(Problem("claude-md-drift", path, detail, BLOCKS_ALWAYS))
    elif not os.path.lexists(path):
        plan.problems.append(Problem("claude-md-drift", path, "generated CLAUDE.md is missing"))
        plan.changes.append(Change("write-claude-md", path, write_now))
    elif not claude_md.is_generated_claude_md(path):
        backup_path = os.path.join(backup_root, claude_md.FILE_NAME)
        plan.claude_md_backup = backup_path
        detail = f"not a keel-generated CLAUDE.md; --force moves it to {backup_path}"
        plan.problems.append(Problem("target-occupied", path, detail, BLOCKS_UNLESS_FORCED))
        plan.changes.append(Change("write-claude-md", path, _after_moving_aside(path, backup_path, write_now)))
    elif read_text(path) != content:
        plan.problems.append(Problem("claude-md-drift", path, "generated CLAUDE.md is drifted"))
        plan.changes.append(Change("write-claude-md", path, write_now))


def _after_moving_aside(path: str, backup_path: str, then: Callable[[], None]) -> Callable[[], None]:
    def apply() -> None:
        move_aside(path, backup_path)
        then()

    return apply


def _plan_settings(plan: Plan, paths: KeelPaths, backup_root: str) -> None:
    plan.merged_settings, plan.conflicts = load_merged_fragments(paths)
    _check_hook_wiring(plan, paths)
    live = settings_json.read_live_settings(settings_json.settings_path(paths))
    drift = settings_json.drifted_owned_keys(live, plan.merged_settings)
    if not drift:
        return
    edited_by_hand = settings_json.changed_since_last_write(paths, live)
    blocks = BLOCKS_UNLESS_FORCED if edited_by_hand else BLOCKS_NEVER
    detail = "; ".join(drift)
    if edited_by_hand:
        detail += f"; {', '.join(edited_by_hand)} changed since the last --write (--force overwrites)"
    plan.problems.append(Problem("settings-drift", live.path, detail, blocks))
    if _is_first_write_over_owned_keys(paths, live):
        plan.dropped_settings = settings_json.list_dropped_items(live.values, plan.merged_settings)
        detail = f"keel has never written these owned keys; the dry run and --write --adopt list the {len(plan.dropped_settings)} items it would drop"
        plan.problems.append(Problem("settings-unadopted", live.path, detail, BLOCKS_UNLESS_ADOPTED))
    plan.settings_backup = os.path.join(backup_root, settings_json.FILE_NAME)
    write_now = lambda: settings_json.write_settings(live, plan.merged_settings, plan.settings_backup)
    plan.changes.append(Change("merge-settings", live.path, write_now))


def _check_hook_wiring(plan: Plan, paths: KeelPaths) -> None:
    stacks = active_stacks(paths)
    registrations = list(iter_registrations(plan.merged_settings.get("hooks", {})))
    registered = {registration.hook_name for registration in registrations}
    ledger_path = os.path.join(paths.keel_home, "ledger.tsv")
    for row in hook_rows_in_force(load_ledgers_from(paths.keel_home, paths.overlay_dir), stacks):
        if row.hook_name not in registered:
            detail = f"{row.id} ({row.source} ledger): hook {row.hook_name} is not registered in the merged settings"
            plan.problems.append(Problem("hook-unregistered", ledger_path, detail, BLOCKS_ALWAYS))
    core_path = os.path.join(paths.keel_home, "settings", "core.json")
    for registration in registrations:
        if _is_gate(registration) and not _fails_closed(registration.hook):
            detail = f'PreToolUse[{registration.matcher}] {registration.hook_name}: needs "onFailure": "{FAIL_CLOSED}" and a numeric "timeout"'
            plan.problems.append(Problem("gate-onfailure-missing", core_path, detail))


def _is_gate(registration: Registration) -> bool:
    tools = GATED_TOOLS.get(registration.hook_name, ())
    return registration.event == "PreToolUse" and any(registration.covers_tool(tool) for tool in tools)


def _fails_closed(hook: dict) -> bool:
    """A gate whose own process fails must still block the tool call."""
    timeout = hook.get("timeout")
    return hook.get("onFailure") == FAIL_CLOSED and isinstance(timeout, (int, float)) and not isinstance(timeout, bool)


def _is_first_write_over_owned_keys(paths: KeelPaths, live: settings_json.LiveSettings) -> bool:
    return not os.path.isfile(settings_json.link_state_path(paths)) and any(key in live.values for key in OWNED_KEYS)


def _plan_hooks_path(plan: Plan, paths: KeelPaths) -> None:
    """keel's githooks run the public-boundary scan; core.hooksPath lives in the shared config, so worktrees inherit it."""
    keel_home = paths.keel_home
    if not _is_checkout_root(keel_home):
        detail = "KEEL_HOME is not the root of a git checkout; githooks cannot be installed"
        plan.problems.append(Problem("hookspath-drift", keel_home, detail, BLOCKS_ALWAYS))
        return
    current = (run_git(keel_home, "config", "--get", "core.hooksPath") or "").strip()
    if current == HOOKS_PATH:
        return
    plan.problems.append(Problem("hookspath-drift", keel_home, f"core.hooksPath is {current or 'unset'}, should be {HOOKS_PATH}"))
    set_now = lambda: subprocess.run(["git", "-C", keel_home, "config", "core.hooksPath", HOOKS_PATH], check=True, capture_output=True)
    plan.changes.append(Change("set-hooks-path", keel_home, set_now))


def _is_checkout_root(keel_home: str) -> bool:
    """Not just `rev-parse --git-dir`: a plain directory inside another repo passes that, and its config is the parent's."""
    toplevel = run_git(keel_home, "rev-parse", "--show-toplevel")
    return toplevel is not None and os.path.realpath(toplevel.strip()) == os.path.realpath(keel_home)

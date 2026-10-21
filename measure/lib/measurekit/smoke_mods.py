"""Smoke kind `mod-trust` (ledger row F-mod-trust): every installed Claude Code mod has been reviewed.

A mod is a plugin whose `hooks/hooks.json` lists `modules`: JS that runs inside Claude Code and can approve or answer
a tool call before `permissions.deny` and every PreToolUse hook, so no hook can stop it.
"""
from __future__ import annotations

import json
import os
import subprocess

from measurekit.datafiles import data_lines
from measurekit.gitutil import GitError, run_git
from measurekit.metrics import FAIL, PASS, WARN, stderr_excerpt
from measurekit.overlay_checkout import is_under, main_worktree_overlay
from measurekit.smoke_context import SmokeContext, assertion, first_items

REVIEWED_MODS_FILE = "reviewed-mods.txt"
PLUGIN_LIST_TIMEOUT_SECONDS = 60


class _PluginListUnavailable(Exception):
    """`claude plugin list --json` did not run, or printed something other than [{"id", "installPath"}, ...]."""


def check_mod_trust(ctx: SmokeContext) -> list[dict]:
    try:
        plugins = _installed_plugins()
    except _PluginListUnavailable as error:
        return [assertion("mod-trust", "all", WARN, "mod check could not run: %s" % error)]
    reviewed_file = os.path.join(ctx.overlay_dir, REVIEWED_MODS_FILE)
    reviewed_ids = _reviewed_ids(reviewed_file)
    main_overlay = main_worktree_overlay(ctx.overlay_dir)
    mods = [plugin for plugin in plugins if _is_mod(plugin["installPath"])]
    unreviewed = [
        plugin["id"] for plugin in mods
        if plugin["id"] not in reviewed_ids and not _is_committed_overlay_mod(plugin["installPath"], main_overlay)
    ]
    if unreviewed:
        detail = "unreviewed mods: %s; read each with `claude plugin validate <installPath>`, then add its id to %s or uninstall it" % (
            first_items(unreviewed), reviewed_file)
        return [assertion("mod-trust", "all", FAIL, detail)]
    return [assertion("mod-trust", "all", PASS, "no unreviewed mod among %d plugins (%d mods)" % (len(plugins), len(mods)))]


def _installed_plugins() -> list[dict]:
    cli = os.environ.get("KEEL_CLAUDE") or "claude"
    try:
        completed = subprocess.run(
            [cli, "plugin", "list", "--json"], stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=PLUGIN_LIST_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise _PluginListUnavailable("%s plugin list --json: %s" % (cli, error))
    if completed.returncode != 0:
        raise _PluginListUnavailable("%s plugin list --json exited %d: %s" % (cli, completed.returncode, stderr_excerpt(completed)))
    try:
        plugins = json.loads(completed.stdout)
    except ValueError:
        raise _PluginListUnavailable("plugin list output is not JSON")
    if not _is_plugin_list(plugins):
        raise _PluginListUnavailable('plugin list output is not [{"id", "installPath"}, ...]')
    return plugins


def _is_plugin_list(value: object) -> bool:
    return isinstance(value, list) and all(
        isinstance(plugin, dict) and isinstance(plugin.get("id"), str) and isinstance(plugin.get("installPath"), str)
        for plugin in value
    )


def _reviewed_ids(reviewed_file: str) -> set[str]:
    if not os.path.isfile(reviewed_file):
        return set()
    return {line.strip() for _, line in data_lines(reviewed_file)}


def _is_mod(install_path: str) -> bool:
    """A hooks.json that cannot be read or parsed counts as a mod: unreadable is unreviewed."""
    if not os.path.isfile(os.path.join(install_path, "hooks", "hooks.json")):
        return False
    modules = _listed_modules(install_path)
    return modules is None or bool(modules)


def _listed_modules(install_path: str) -> list[str] | None:
    """The `modules` of the plugin's hooks.json, [] when the key is absent; None when it cannot be read or parsed or
    has another shape, `null` included."""
    try:
        with open(os.path.join(install_path, "hooks", "hooks.json"), encoding="utf-8") as handle:
            hooks = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(hooks, dict):
        return None
    modules = hooks.get("modules", [])
    if not (isinstance(modules, list) and all(isinstance(module, str) for module in modules)):
        return None
    return modules


def _is_committed_overlay_mod(install_path: str, overlay: str | None) -> bool:
    """The overlay's own mod is reviewed through overlay commits, so only a tracked and unchanged one whose listed
    modules are tracked files counts; `git status` does not show an ignored build output.

    Links and `..` are resolved first, so a path that only names the overlay on its way out is not exempt.
    """
    mod = os.path.realpath(install_path)
    modules = _listed_modules(mod)
    if overlay is None or not is_under(mod, {overlay}) or modules is None:
        return False
    module_files = {os.path.relpath(os.path.realpath(os.path.join(mod, "hooks", module)), overlay) for module in modules}
    pathspec = ":(literal)" + os.path.relpath(mod, overlay)
    try:
        tracked = set(run_git(overlay, ["ls-files", "-z", "--", pathspec]).split("\0")) - {""}
        changes = run_git(overlay, ["status", "--porcelain", "--", pathspec])
    except (GitError, OSError):
        return False
    return bool(tracked) and not changes.strip() and module_files <= tracked

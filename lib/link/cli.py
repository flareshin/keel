from __future__ import annotations

import argparse
import json
import os
import shlex
import sys

from link import claude_md, links, settings_json
from link.config import EXIT_INTERNAL, EXIT_NEGATIVE, EXIT_OK, EXIT_REFUSED, KeelPaths, Refused, resolve_paths, run_git
from link.plan import FORCE_FLAG, LIFTING_FLAGS, Plan, build_plan

V1_TAG = "v1-final"


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    try:
        paths = resolve_paths()
        if args.unlink:
            return run_unlink(paths)
        plan = build_plan(paths)
        for conflict in plan.conflicts:
            _say(f"link: warning: settings conflict: {conflict}")
        if args.write:
            return run_write(plan, paths, args)
        if args.check:
            _emit([], plan.problems)
            return EXIT_NEGATIVE if plan.problems else EXIT_OK
        _emit(plan.changes, plan.problems, dropped=plan.dropped_settings, claude_md_bytes=plan.claude_md_bytes)
        return EXIT_OK
    except Refused as refusal:
        _say(f"link: refused: {refusal}")
        return EXIT_REFUSED
    except Exception as error:  # noqa: BLE001 - reported with its type, mapped to the shared internal-error code
        _say(f"link: internal error: {type(error).__name__}: {error}")
        return EXIT_INTERNAL


def run_write(plan: Plan, paths: KeelPaths, args: argparse.Namespace) -> int:
    if not args.allow_worktree and _is_linked_worktree(paths.keel_home):
        raise Refused(f"KEEL_HOME {paths.keel_home} is a linked worktree; link a merged checkout or pass --allow-worktree")
    blocking = [problem for problem in plan.problems if problem.blocks(args.force, args.adopt)]
    if blocking:
        _say_drops(plan.dropped_settings)
        _emit([], blocking)
        _say("link: refused: resolve the problems above; nothing was written")
        if all(problem.lifting_flags is not None for problem in blocking):
            _say(f"link: or, once each one is reviewed, run: {_build_write_command(plan, args.allow_worktree)}")
        return EXIT_REFUSED
    if args.adopt:
        _require_every_drop_accepted(plan, args.accept_drops, args.allow_worktree)
    for problem in [problem for problem in plan.problems if args.force and FORCE_FLAG in (problem.lifting_flags or ())]:
        _say(f"link: forced: {problem.path}: {problem.detail}")
    for change in plan.changes:
        change.apply()
    settings_json.record_last_write(paths, plan.merged_settings, plan.settings_backup, plan.claude_md_backup)
    _emit(plan.changes, [])
    return EXIT_OK


def run_unlink(paths: KeelPaths) -> int:
    """Remove keel's links and generated CLAUDE.md, put back the pre-keel owned settings keys (the whole pre-keel file only
    when the live one is not a JSON object) and the moved-aside CLAUDE.md, print the v1 restore command."""
    entries = links.read_link_manifest(paths)
    moved_aside_claude_md = settings_json.read_link_state(paths).get(settings_json.PRE_KEEL_CLAUDE_MD)
    settings_restore = settings_json.restore_pre_keel_settings(paths)
    actions = [settings_restore] if settings_restore else []
    for entry in entries:
        path = os.path.join(paths.data_dir, entry.target)
        if links.is_keel_link(path, paths):
            os.unlink(path)
            actions.append({"op": "remove-link", "path": path})
    generated = os.path.join(paths.data_dir, claude_md.FILE_NAME)
    if claude_md.is_generated_claude_md(generated):
        os.unlink(generated)
        actions.append({"op": "remove-link", "path": generated})
    claude_md_restore = claude_md.restore_moved_aside(generated, moved_aside_claude_md)
    if claude_md_restore:
        actions.append(claude_md_restore)
    if os.path.isfile(settings_json.link_state_path(paths)):
        os.unlink(settings_json.link_state_path(paths))
    restore_paths = _paths_left_for_v1(entries, claude_md_restore, settings_restore)
    _say("link: to restore v1, run:\n  " + build_v1_restore_command(paths.data_dir, restore_paths))
    print(json.dumps({"actions": actions, "problems": []}))
    return EXIT_OK


def build_v1_restore_command(data_dir: str, candidates: list[str]) -> str:
    """`git checkout v1-final -- <paths>` limited to paths the tag holds, so the command cannot fail on a pathspec."""
    if run_git(data_dir, "rev-parse", "-q", "--verify", f"refs/tags/{V1_TAG}") is None:
        _say(f"link: warning: tag {V1_TAG} not found in {data_dir}; the command below assumes it exists")
        restorable = candidates
    else:
        restorable = [path for path in candidates if run_git(data_dir, "cat-file", "-e", f"{V1_TAG}:{path}") is not None]
    if not restorable:
        return f"# {V1_TAG} holds none of the keel-managed paths; nothing to restore"
    quoted = " ".join(shlex.quote(path) for path in restorable)
    return f"git -C {shlex.quote(data_dir)} checkout {V1_TAG} -- {quoted}"


def read_accepted_drops(path: str | None) -> set[str]:
    """Lines of an --accept-drops file; blank and `#` lines skipped."""
    if path is None:
        return set()
    try:
        with open(path, encoding="utf-8") as f:
            return {line.rstrip("\n") for line in f if line.strip() and not line.startswith("#")}
    except OSError as error:
        raise Refused(f"--accept-drops {path}: {error}") from error


def _is_linked_worktree(keel_home: str) -> bool:
    output = run_git(keel_home, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
    if output is None:
        return False
    git_dir, common_dir = output.splitlines()
    return os.path.realpath(git_dir) != os.path.realpath(common_dir)


def _paths_left_for_v1(entries: list[links.LinkEntry], claude_md_restore: dict | None, settings_restore: dict | None) -> list[str]:
    """The managed paths --unlink did not put back from a backup, for the v1 restore command."""
    paths = [entry.target for entry in entries]
    if claude_md_restore is None:
        paths.append(claude_md.FILE_NAME)
    if settings_restore is None or settings_restore["op"] != settings_json.RESTORE_OP:
        paths.append(settings_json.FILE_NAME)
    return paths


def _require_every_drop_accepted(plan: Plan, accept_drops: str | None, allow_worktree: bool) -> None:
    _say_drops(plan.dropped_settings)
    accepted = read_accepted_drops(accept_drops)
    not_accepted = [item for item in plan.dropped_settings if item not in accepted]
    if not_accepted:
        listed = "\n".join(f"  not accepted: {item}" for item in not_accepted)
        raise Refused(
            f"{len(not_accepted)} dropped items are not in --accept-drops:\n{listed}\n"
            "Decide each one (re-declare it in an overlay fragment, or accept the drop), then list accepted lines in a file "
            f"and run: {_build_write_command(plan, allow_worktree)}"
        )


def _build_write_command(plan: Plan, allow_worktree: bool) -> str:
    """The --write with every flag the plan's liftable problems need, plus the --allow-worktree this run was given;
    drops still need an accept file."""
    levels = {problem.blocks_write for problem in plan.problems}
    flags = ["--write"] + [flag for level, lifting in LIFTING_FLAGS.items() if level in levels for flag in lifting or ()]
    if plan.dropped_settings:
        flags.append("--accept-drops <file>")
    if allow_worktree:
        flags.append("--allow-worktree")
    return "bin/link " + " ".join(flags)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    """Parsed flags; argparse itself exits 2 on a usage error."""
    parser = argparse.ArgumentParser(prog="link", description="Link keel into KEEL_DATA_DIR. No flag = dry run.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="create/repair links, CLAUDE.md and owned settings keys")
    mode.add_argument("--check", action="store_true", help="report drift; exit 1 when any; write nothing")
    mode.add_argument("--unlink", action="store_true", help="remove keel links and print the v1 restore command")
    parser.add_argument("--force", action="store_true", help="with --write: move what is in the way aside, overwrite hand-edited owned keys")
    parser.add_argument("--allow-worktree", action="store_true", help="with --write: allow KEEL_HOME to be a linked worktree")
    parser.add_argument("--adopt", action="store_true", help="with --write: take over owned keys keel has never written; lists every drop")
    parser.add_argument("--accept-drops", metavar="FILE", help="with --adopt: file listing each dropped item the user accepted")
    args = parser.parse_args(argv)
    if (args.force or args.allow_worktree or args.adopt) and not args.write:
        parser.error("--force, --allow-worktree and --adopt require --write")
    if args.accept_drops and not args.adopt:
        parser.error("--accept-drops requires --adopt")
    return args


def _emit(changes: list, problems: list, **dry_run_fields: object) -> None:
    print(json.dumps({"actions": [c.to_json() for c in changes], "problems": [p.to_json() for p in problems], **dry_run_fields}))


def _say_drops(dropped: list[str]) -> None:
    for item in dropped:
        _say(f"link: adopt drops: {item}")


def _say(message: str) -> None:
    print(message, file=sys.stderr)

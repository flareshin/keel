from __future__ import annotations

import os

from measurekit.gitutil import GitError, run_git


def main_worktree_overlay(overlay_dir: str) -> str | None:
    overlay = os.path.realpath(overlay_dir)
    try:
        toplevel, git_dir, common_dir = run_git(
            overlay, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).splitlines()
    except (GitError, OSError, ValueError):
        return None
    if os.path.realpath(git_dir) == os.path.realpath(common_dir):
        return overlay
    main_root = os.path.dirname(os.path.realpath(common_dir))
    return os.path.normpath(os.path.join(main_root, os.path.relpath(overlay, os.path.realpath(toplevel))))


def is_under(path: str, roots: set[str]) -> bool:
    resolved = os.path.realpath(path)
    return any(resolved.startswith(root + os.sep) for root in roots)

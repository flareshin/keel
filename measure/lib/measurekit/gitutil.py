"""git called directly (no shell); a failing call raises GitError."""
from __future__ import annotations

import os
import subprocess
import tempfile


class GitError(Exception):
    pass


def run_git(repo: str, args: list[str], extra_env: dict | None = None, stdin_text: str | None = None) -> str:
    env = {**os.environ, **(extra_env or {})}
    completed = subprocess.run(["git", "-C", repo] + args, input=stdin_text, capture_output=True, text=True, env=env)
    if completed.returncode != 0:
        raise GitError("git %s failed in %s: %s" % (" ".join(args[:3]), repo, completed.stderr.strip()))
    return completed.stdout


def git_succeeds(repo: str, args: list[str]) -> bool:
    try:
        run_git(repo, args)
    except (GitError, OSError):
        return False
    return True


def is_git_repo(path: str) -> bool:
    return git_succeeds(path, ["rev-parse", "--git-dir"])


def snapshot_tree(repo: str) -> str:
    """Tree id of the working tree (HEAD + changes + untracked, not ignored); the real index is untouched."""
    root = run_git(repo, ["rev-parse", "--show-toplevel"]).strip()
    head = "HEAD" if git_succeeds(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) else "--empty"
    work_tree = ["--work-tree", root]
    with tempfile.TemporaryDirectory() as temp_dir:
        index_env = {"GIT_INDEX_FILE": os.path.join(temp_dir, "index")}
        run_git(root, work_tree + ["read-tree", head], index_env)
        run_git(root, work_tree + ["add", "-A"], index_env)
        return run_git(root, work_tree + ["write-tree"], index_env).strip()


def repo_key(repo: str) -> str | None:
    """Normalized origin `owner/repo` (lowercase, last two path segments, `.git` stripped); None without an owner/repo origin.

    Not a looser key: `keel evidence write-smoke` looks trees up by its own normalizer, which also needs two segments.
    """
    try:
        url = run_git(repo, ["remote", "get-url", "origin"]).strip()
    except GitError:
        return None
    segments = [segment for segment in url.rstrip("/").removesuffix(".git").replace(":", "/").split("/") if segment]
    return "/".join(segments[-2:]).lower() if len(segments) >= 2 else None

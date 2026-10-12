"""Git facts a hook needs: toplevel, repo key, upstream."""
from __future__ import annotations

import os
import re
import subprocess

GIT_TIMEOUT_SECONDS = 8  # below git-guard's registered 10 s timeout (settings/core.json)


def git(args: list, cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS)


def git_output(args: list, cwd: str) -> str | None:
    """stdout without the trailing newline, or None when git fails."""
    if not os.path.isdir(cwd):
        return None
    result = git(args, cwd)
    if result.returncode != 0:
        return None
    return result.stdout.rstrip("\n")


def find_toplevel(path: str) -> str | None:
    return git_output(["rev-parse", "--show-toplevel"], path)


def normalize_repo_key(url: str) -> str | None:
    """`owner/repo` from any origin form (ssh, https, local path); host ignored."""
    trimmed = url.strip().rstrip("/")
    if trimmed.endswith(".git"):
        trimmed = trimmed[: -len(".git")]
    segments = [segment for segment in re.split(r"[/:]", trimmed) if segment]
    if len(segments) < 2:
        return None
    return ("%s/%s" % (segments[-2], segments[-1])).lower()


def find_repo_key(toplevel: str) -> str | None:
    url = git_output(["remote", "get-url", "origin"], toplevel)
    return normalize_repo_key(url) if url else None


def find_superproject(toplevel: str) -> str | None:
    return git_output(["rev-parse", "--show-superproject-working-tree"], toplevel) or None


def is_commit(toplevel: str, ref: str) -> bool:
    return git_output(["rev-parse", "-q", "--verify", ref + "^{commit}"], toplevel) is not None


def find_upstream(toplevel: str, ref: str) -> str | None:
    """`<ref>@{u}` when it resolves to a commit, else None."""
    upstream = git_output(["rev-parse", "--abbrev-ref", "%s@{u}" % ref], toplevel)
    return upstream if upstream and is_commit(toplevel, upstream) else None


def current_branch(toplevel: str) -> str | None:
    branch = git_output(["rev-parse", "--abbrev-ref", "HEAD"], toplevel)
    return None if branch in (None, "HEAD") else branch

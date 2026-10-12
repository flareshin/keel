"""Thin git wrappers: every command the gate and the CLI need, nothing else."""
from __future__ import annotations

import os
import subprocess
import tempfile
from typing import Dict, List, NamedTuple, Optional, Tuple

from evidence.env import DELETED_MODE, GITLINK_MODE

# ship-gate's merge path runs two fetches and a `gh pr view` in one call: all of them end before its
# registered 60 s timeout (settings/core.json), so the hook still prints its own deny.
GIT_TIMEOUT_SECONDS = 20
FETCH_TIMEOUT_SECONDS = 20
SNAPSHOT_TIMEOUT_SECONDS = 300  # not the hook budget: `keel snapshot`/`keel test` run outside hooks; `add -A` hashes every file
DEFAULT_REMOTE = "origin"
GH_DEFAULT_REMOTE_KEYS = r"^remote\..*\.gh-resolved$"
GH_RESOLVED_BASE = "base"  # the gh-resolved value meaning "the repo this remote's URL names"


class GitError(Exception):
    """A git command failed where failure is not a valid answer."""


class PathEntry(NamedTuple):
    path: str
    blob: Optional[str]  # None = deleted
    mode: str
    old_mode: str

    @property
    def deleted(self) -> bool:
        return self.blob is None

    @property
    def is_gitlink(self) -> bool:
        return self.mode == GITLINK_MODE or (self.deleted and self.old_mode == GITLINK_MODE)


class PathStat(NamedTuple):
    added: int
    deleted: int


class GhDefault(NamedTuple):
    remote: str
    resolved: str  # GH_RESOLVED_BASE, or the owner/repo `gh repo set-default` chose for this remote


def run(repo: str, *args: str, check: bool = True, env: Optional[Dict[str, str]] = None,
        timeout: int = GIT_TIMEOUT_SECONDS) -> subprocess.CompletedProcess:
    completed = subprocess.run(["git", "-C", repo] + list(args), capture_output=True, env=env,
                               timeout=timeout)
    if check and completed.returncode != 0:
        raise GitError("git %s: %s" % (" ".join(args), completed.stderr.decode("utf-8", "replace").strip()))
    return completed


def text(repo: str, *args: str, **kwargs) -> str:
    return run(repo, *args, **kwargs).stdout.decode("utf-8", "replace").strip()


def _output_if_ok(repo: str, *args: str) -> Optional[str]:
    """stdout of a git command whose failure means "no such thing"; None on failure or empty output."""
    completed = run(repo, *args, check=False)
    if completed.returncode != 0:
        return None
    return completed.stdout.decode("utf-8", "replace").strip() or None


def toplevel(path: str) -> Optional[str]:
    root = _output_if_ok(path, "rev-parse", "--show-toplevel") if os.path.isdir(path) else None
    return os.path.realpath(root) if root else None


def origin_url(repo: str) -> Optional[str]:
    return remote_url(repo, DEFAULT_REMOTE)


def remote_url(repo: str, remote: str) -> Optional[str]:
    return _output_if_ok(repo, "remote", "get-url", remote)


def push_urls(repo: str, remote: str) -> List[str]:
    """Every URL a push to `remote` lands on (its pushurls when set, else its urls); empty when `remote` names no
    remote."""
    return (_output_if_ok(repo, "remote", "get-url", "--push", "--all", remote) or "").splitlines()


def remotes(repo: str) -> List[str]:
    return (_output_if_ok(repo, "remote") or "").split()


def push_remote(repo: str) -> str:
    """The remote a `git push` naming none reaches, in git's order: branch.<b>.pushRemote,
    remote.pushDefault, branch.<b>.remote, origin."""
    branch = current_branch(repo)
    keys = ["remote.pushDefault"] if branch is None else [
        "branch.%s.pushRemote" % branch, "remote.pushDefault", "branch.%s.remote" % branch]
    configured = (_output_if_ok(repo, "config", "--get", key) for key in keys)
    return next((remote for remote in configured if remote), DEFAULT_REMOTE)


def gh_default_remote(repo: str) -> Optional[GhDefault]:
    """The remote `gh repo set-default` marked and the value it stored (`remote.<name>.gh-resolved <value>`), or
    None."""
    listed = _output_if_ok(repo, "config", "--get-regexp", GH_DEFAULT_REMOTE_KEYS)
    if listed is None:
        return None
    key, _, value = listed.splitlines()[0].partition(" ")
    return GhDefault(key[len("remote."):-len(".gh-resolved")], value)


def commit_sha(repo: str, rev: str) -> Optional[str]:
    return _output_if_ok(repo, "rev-parse", "--verify", "-q", rev + "^{commit}")


def tree_of_commit(repo: str, sha: str) -> str:
    return text(repo, "rev-parse", "--verify", sha + "^{tree}")


def object_type(repo: str, sha: str) -> Optional[str]:
    return _output_if_ok(repo, "cat-file", "-t", sha)


def ref_exists(repo: str, full_ref: str) -> bool:
    return run(repo, "show-ref", "--verify", "-q", full_ref, check=False).returncode == 0


def current_branch(repo: str) -> Optional[str]:
    return _output_if_ok(repo, "symbolic-ref", "-q", "--short", "HEAD")


def merge_base(repo: str, a: str, b: str) -> Optional[str]:
    return _output_if_ok(repo, "merge-base", a, b)


def is_ancestor(repo: str, ancestor: str, descendant: str) -> bool:
    completed = run(repo, "merge-base", "--is-ancestor", ancestor, descendant, check=False)
    if completed.returncode not in (0, 1):
        raise GitError("merge-base --is-ancestor %s %s: %s" % (ancestor, descendant, completed.stderr.decode()))
    return completed.returncode == 0


def fetch(repo: str, *args: str) -> None:
    run(repo, "fetch", "--quiet", *args, timeout=FETCH_TIMEOUT_SECONDS)


def diff_entries(repo: str, old: str, new: str) -> List[PathEntry]:
    """Changed paths between two tree-ish ids; renames appear as delete + add."""
    fields = run(repo, "diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", old, new).stdout.split(b"\0")
    entries = []
    for meta, path in zip(fields[0::2], fields[1::2]):
        if not meta.startswith(b":"):
            continue
        old_mode, new_mode, _old_sha, new_sha, status = meta[1:].decode().split(" ", 4)
        deleted = status.startswith("D")
        entries.append(PathEntry(path.decode("utf-8", "surrogateescape"),
                                 None if deleted else new_sha, DELETED_MODE if deleted else new_mode, old_mode))
    return entries


def diff_stats(repo: str, old: str, new: str) -> Dict[str, PathStat]:
    raw = run(repo, "diff-tree", "-r", "--numstat", "-z", "--no-renames", old, new).stdout
    stats = {}
    for record in filter(None, raw.split(b"\0")):
        added, deleted, path = record.decode("utf-8", "surrogateescape").split("\t", 2)
        binary = added == "-"  # numstat counts no lines in a binary file
        stats[path] = PathStat(0 if binary else int(added), 0 if binary else int(deleted))
    return stats


def tree_entry(repo: str, tree: str, path: str) -> Optional[Tuple[str, str]]:
    """(mode, object id) of `path` in `tree`, or None when the tree does not hold it."""
    record = run(repo, "ls-tree", "-z", tree, "--", path).stdout.split(b"\0")[0]
    if not record:
        return None
    mode, _type, rest = record.decode("utf-8", "surrogateescape").split(" ", 2)
    return mode, rest.split("\t", 1)[0]


def snapshot_tree(repo: str) -> str:
    """Tree id of HEAD plus tracked changes and untracked files, through a temporary index.
    `--work-tree` names the root explicitly: inside a submodule git may otherwise read the
    superproject's store as its own."""
    handle, index = tempfile.mkstemp(prefix="keel-index-")
    os.close(handle)
    os.unlink(index)
    env = dict(os.environ, GIT_INDEX_FILE=index)
    try:
        run(repo, "--work-tree", repo, "read-tree", "HEAD", env=env, timeout=SNAPSHOT_TIMEOUT_SECONDS)
        run(repo, "--work-tree", repo, "add", "-A", env=env, timeout=SNAPSHOT_TIMEOUT_SECONDS)
        return text(repo, "--work-tree", repo, "write-tree", env=env, timeout=SNAPSHOT_TIMEOUT_SECONDS)
    finally:
        if os.path.exists(index):
            os.unlink(index)

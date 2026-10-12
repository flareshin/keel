"""Public-boundary scan: overlay lexicon and regexes plus keel's generic secret / private-IP rules.

A hit's `rule` names the rule by source and line (`lexicon:3`, `regex:1`, `generic:aws-access-key`),
never the matched term, so private lexicon terms never reach logs. Line 0 is the file path itself.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator

from measurekit.datafiles import TsvError, data_lines, read_tsv_records
from measurekit.env import CHECKOUT_ROOT
from measurekit.gitutil import GitError, run_git

# The generic rules ship with the code that runs, whatever checkout KEEL_HOME names.
GENERIC_RULES_PATH = os.path.join(CHECKOUT_ROOT, "measure", "boundary-generic.tsv")
ZERO_SHA_PATTERN = re.compile(r"^0+$")
HUNK_HEADER = re.compile(r"^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
DIFF_ARGS = ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames"]
# Not taken from `+++` headers: binary and empty files have none.
CHANGED_NAMES_ARGS = ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=d"]
PATH_NAME_LINE = 0

ScanLine = tuple[str, int, str]


class BoundaryUsageError(Exception):
    pass


@dataclass
class Rule:
    name: str
    matches: Callable[[str], bool]


def load_rules(overlay_dir: str, generic_only: bool) -> list[Rule]:
    rules = _generic_rules()
    if generic_only:
        return rules
    lexicon_path = os.path.join(overlay_dir, "boundary", "lexicon.txt")
    if not os.path.isfile(lexicon_path):
        raise BoundaryUsageError("overlay lexicon missing: %s (set KEEL_OVERLAY_DIR or pass --generic-only)" % lexicon_path)
    lexicon_rules = [_lexicon_rule("lexicon:%d" % number, term) for number, term in data_lines(lexicon_path)]
    if not lexicon_rules:
        raise BoundaryUsageError("overlay lexicon has no terms: %s; an empty lexicon would pass every private term" % lexicon_path)
    rules += lexicon_rules
    regex_path = os.path.join(overlay_dir, "boundary", "regex.txt")
    if os.path.isfile(regex_path):
        rules += [_regex_rule("regex:%d" % number, pattern) for number, pattern in data_lines(regex_path)]
    return rules


def _generic_rules() -> list[Rule]:
    try:
        records = read_tsv_records(GENERIC_RULES_PATH, ("name", "regex"))
    except (OSError, TsvError) as error:
        raise BoundaryUsageError("generic rules unreadable: %s" % error)
    return [_regex_rule("generic:" + record["name"], record["regex"]) for record in records]


def _lexicon_rule(name: str, term: str) -> Rule:
    lowered = term.lower()
    return Rule(name, lambda text: lowered in text.lower())


def _regex_rule(name: str, pattern: str) -> Rule:
    try:
        compiled = re.compile(pattern)
    except re.error as error:
        raise BoundaryUsageError("rule %s has an invalid regex: %s" % (name, error))
    return Rule(name, lambda text: compiled.search(text) is not None)


def scan(lines: Iterable[ScanLine], rules: list[Rule]) -> dict:
    scanned, hits = 0, []
    for file_label, line_number, text in lines:
        scanned += 1
        hits += [{"file": file_label, "line": line_number, "rule": rule.name} for rule in rules if rule.matches(text)]
    return {"scanned": scanned, "hits": hits}


def file_lines(root: str, relative_paths: Iterable[str]) -> Iterator[ScanLine]:
    """Every line of every text file; binary files contribute only their name.

    A directory inside a work tree expands to its tracked files; outside one, to every file but `.git`.
    """
    for relative_path in relative_paths:
        full_path = os.path.join(root, relative_path)
        if os.path.isdir(full_path) and not os.path.islink(full_path):
            yield from file_lines(root, _directory_files(root, full_path))
            continue
        yield relative_path, PATH_NAME_LINE, relative_path
        yield from _text_lines(relative_path, full_path)


def _directory_files(root: str, directory: str) -> list[str]:
    try:
        tracked = run_git(directory, ["ls-files", "-z"]).split("\0")
    except GitError:
        return _walk_without_git(root, directory)
    members = [os.path.normpath(os.path.join(directory, name)) for name in tracked if name]
    # Not the directory itself: in an uninitialized submodule the parent lists its gitlink as `./`.
    found = [os.path.relpath(member, root) for member in members if member != os.path.normpath(directory)]
    if not found and _walk_without_git(root, directory):
        raise BoundaryUsageError("%s holds no tracked file; stage its files or name them" % directory)
    return found


def _walk_without_git(root: str, directory: str) -> list[str]:
    found = []
    for current, dir_names, file_names in os.walk(directory):
        dir_names[:] = [name for name in dir_names if name != ".git"]
        found += [os.path.relpath(os.path.join(current, name), root) for name in file_names if name != ".git"]
    return sorted(found)


def _text_lines(label: str, full_path: str) -> Iterator[ScanLine]:
    if os.path.islink(full_path) or not os.path.isfile(full_path):
        return
    with open(full_path, "rb") as handle:
        content = handle.read()
    if b"\0" in content:
        return
    for number, line in enumerate(content.decode("utf-8", errors="replace").splitlines(), start=1):
        yield label, number, line


def staged_lines(repo: str) -> Iterator[ScanLine]:
    yield from _diff_lines(repo, ["--cached"], label_prefix="")


def range_lines(repo: str, commit_range: str) -> Iterator[ScanLine]:
    """Each pushed commit's message and the lines it adds, labelled `<sha12>:<path>`."""
    for commit in _commits_in_range(repo, commit_range):
        short = commit[:12]
        message = run_git(repo, ["log", "-1", "--format=%B", commit])
        for number, line in enumerate(message.splitlines(), start=1):
            yield "%s:message" % short, number, line
        yield from _diff_lines(repo, [_first_parent(repo, commit), commit], label_prefix=short + ":")


def _diff_lines(repo: str, diff_target: list[str], label_prefix: str) -> Iterator[ScanLine]:
    """Each added or changed path name, then the added lines."""
    for name in run_git(repo, CHANGED_NAMES_ARGS + diff_target).split("\0"):
        if name:
            yield label_prefix + name, PATH_NAME_LINE, name
    yield from added_lines(run_git(repo, DIFF_ARGS + diff_target), label_prefix)


def _commits_in_range(repo: str, commit_range: str) -> list[str]:
    """`<old>..<new>`; an all-zero `<old>` (new branch) means every commit of `<new>` not on any remote."""
    old, separator, new = commit_range.partition("..")
    if not separator or not old or not new or new.startswith("."):
        raise BoundaryUsageError("--range takes <old>..<new>, got %r" % commit_range)
    if ZERO_SHA_PATTERN.match(old):
        return run_git(repo, ["rev-list", "--reverse", new, "--not", "--remotes"]).split()
    return run_git(repo, ["rev-list", "--reverse", "%s..%s" % (old, new)]).split()


def _first_parent(repo: str, commit: str) -> str:
    parents = run_git(repo, ["rev-list", "--parents", "-n", "1", commit]).split()[1:]
    return parents[0] if parents else run_git(repo, ["hash-object", "-t", "tree", "--stdin"], stdin_text="").strip()


def added_lines(diff_text: str, label_prefix: str) -> Iterator[ScanLine]:
    """Added lines of a `-U0` unified diff with their new line numbers.

    Inside a hunk the announced line counts are consumed first, so a content line like `+++ x` is never a header.
    """
    path, next_new_line, old_left, new_left = None, 0, 0, 0
    for line in diff_text.splitlines():
        in_hunk = old_left > 0 or new_left > 0
        header = None if in_hunk else HUNK_HEADER.match(line)
        if in_hunk and line.startswith("-"):
            old_left -= 1
        elif in_hunk and line.startswith("+"):
            if path is not None:
                yield label_prefix + path, next_new_line, line[1:]
            next_new_line, new_left = next_new_line + 1, new_left - 1
        elif header:
            old_left, next_new_line, new_left = int(header.group(1) or 1), int(header.group(2)), int(header.group(3) or 1)
        elif not in_hunk and line.startswith("+++ "):
            path = None if line[4:] == "/dev/null" else line[4:].removeprefix("b/")

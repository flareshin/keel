"""`keel test -- <cmd>`: run a test command and keep its result as tests evidence when it counts."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from typing import Dict, List, Optional, Tuple

from evidence import env, gitcmd, registry, store
from evidence.writers import Usage

COUNT_PATTERNS = (
    ("surefire", re.compile(r"Tests run: (\d+)")),
    ("unittest", re.compile(r"^Ran (\d+) tests?\b", re.M)),
    ("tap", re.compile(r"^# pass (\d+)", re.M)),
    ("passed", re.compile(r"^(?!\s*Test (?:Files|Suites)\b).*?\b(\d+) passed\b", re.M)),
)
NO_TESTS_RECOGNIZED = 4
COMMAND_NOT_FOUND = 2


def run(argv: List[str], cwd: str) -> int:
    """Stream the command, then write evidence only for a green run on an unchanged tree."""
    if not argv:
        raise Usage("keel test -- <command…>")
    repo_root = gitcmd.toplevel(cwd)
    if repo_root is None:
        raise Usage("keel test must run inside a git repository")
    repo_key = registry.origin_key(repo_root)
    if repo_key is None:
        raise Usage("the repository needs an origin remote")
    now = env.utc_now()
    run_id = env.new_id("tr", now, env.RUN_ID_RANDOM_BYTES)
    before = gitcmd.snapshot_tree(repo_root)
    submodules_before = _submodule_snapshots(repo_root)
    exit_code, output = _stream(argv, cwd)
    after = gitcmd.snapshot_tree(repo_root)
    submodules_after = _submodule_snapshots(repo_root)
    count, framework = recognize(output)
    result = {"run_id": run_id, "repo": repo_key, "repo_root": repo_root, "cmd": argv, "exit": exit_code,
              "count": count, "framework": framework, "tree": after}
    evidence_id = None
    submodule_evidence: Dict[str, str] = {}
    if exit_code == 0 and count > 0 and before == after:
        evidence = store.write("tests", dict(result, head=gitcmd.commit_sha(repo_root, "HEAD")), repo_key)
        evidence_id = evidence["evidence_id"]
        submodule_evidence = _write_submodule_evidence(result, submodules_before, submodules_after)
    env.append_log_line("keel-tests.jsonl", dict(result, ts=env.iso(env.utc_now()), evidence_id=evidence_id,
                                                 submodule_evidence=submodule_evidence))
    print("KEEL-TEST " + json.dumps({"run_id": run_id, "count": count, "exit": exit_code, "evidence_id": evidence_id,
                                     "submodule_evidence": submodule_evidence}), file=sys.stderr)
    if exit_code == 0 and count == 0:
        return NO_TESTS_RECOGNIZED
    return exit_code


def _submodule_snapshots(repo_root: str) -> Dict[str, str]:
    return {root: gitcmd.snapshot_tree(root) for root in gitcmd.submodule_roots(repo_root)}


def _write_submodule_evidence(result: dict, before: Dict[str, str], after: Dict[str, str]) -> Dict[str, str]:
    written = {}
    for root, tree in after.items():
        repo_key = registry.origin_key(root)
        if repo_key is None or before.get(root) != tree:
            continue
        evidence = store.write("tests", dict(result, repo=repo_key, repo_root=root, tree=tree,
                                             head=gitcmd.commit_sha(root, "HEAD"), superproject=result["repo"]),
                               repo_key)
        written[repo_key] = evidence["evidence_id"]
    return written


def recognize(output: str) -> Tuple[int, Optional[str]]:
    """Total recognized tests and the first framework seen; surefire counts its last total only."""
    total = 0
    framework = None
    for name, pattern in COUNT_PATTERNS:
        counts = [int(match.group(1)) for match in pattern.finditer(output)]
        if not counts:
            continue
        framework = framework or name
        total += counts[-1] if name == "surefire" else sum(counts)
    return total, framework


def _stream(argv: List[str], cwd: str) -> Tuple[int, str]:
    try:
        process = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except FileNotFoundError:
        print("keel test: command not found: %s" % argv[0], file=sys.stderr)
        return COMMAND_NOT_FOUND, ""
    chunks = []
    for raw in process.stdout:
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()
        chunks.append(raw.decode("utf-8", "replace"))
    return process.wait(), "".join(chunks)

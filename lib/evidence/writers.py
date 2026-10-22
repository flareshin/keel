"""Writes review, smoke, approval and ack evidence after validating what the caller claims."""
from __future__ import annotations

import json
import os
from typing import Dict, Optional, Tuple

from evidence import env, gitcmd, registry, store
from evidence.chain import Chain, build_chains

REVIEW_CLAIM_KEYS = ("v", "repo_root", "review_base", "head", "snapshot_tree", "since", "run_id",
                     "root_run_id", "review_kind")
NO_TEST_REASON = "no_test_reason"  # optional: the reviewer's reason a logic change ships without a test (K3)
SOURCE_KEYS = ("session_id", "agent_id", "agent_type", "transcript_path", "agent_transcript_path", "via")
REVIEW_KINDS = ("lens-review", "single-lens")
VERDICTS = ("PASS", "NEEDS_FIXES")
VIAS = ("SubagentHandback", "SubagentStop")
APPROVAL_SOURCE = "cli"


class Refused(Exception):
    """The request is well-formed but must not produce evidence (exit 3)."""


class Usage(Exception):
    """The request is malformed (exit 2)."""


def write_review(request: dict) -> dict:
    """`keel evidence write-review`: recompute the reviewed paths from git ids, never from the message."""
    claim = _validated_claim(request.get("keel_evidence"))
    verdict = request.get("verdict")
    if verdict not in VERDICTS:
        raise Usage("verdict must be one of %s" % ", ".join(VERDICTS))
    source = _validated_source(request.get("source"))
    check_provenance(source)
    repo_root, repo_key = _repo_of(claim["repo_root"])
    _check_objects(repo_root, claim)
    reviewed_tree = gitcmd.tree_of_commit(repo_root, claim["head"]) if claim["head"] else claim["snapshot_tree"]
    since_id, since_tree = _resolve_since(repo_key, claim)
    duplicate = _same_review(repo_key, claim["run_id"], reviewed_tree)
    if duplicate:
        return {"evidence_id": duplicate["evidence_id"], "repo": repo_key, "paths": len(duplicate["paths"])}
    diff_from = since_tree or claim["review_base"]
    paths = [{"path": entry.path, "blob": entry.blob, "mode": entry.mode}
             for entry in gitcmd.diff_entries(repo_root, diff_from, reviewed_tree)]
    body = {
        "repo": repo_key, "repo_root": repo_root, "run_id": claim["run_id"], "root_run_id": claim["root_run_id"],
        "since": since_id, "since_tree": since_tree, "review_base": claim["review_base"], "head": claim["head"],
        "snapshot_tree": claim["snapshot_tree"], "reviewed_tree": reviewed_tree,
        "review_kind": claim["review_kind"], "verdict": verdict, "paths": paths, "source": source,
        NO_TEST_REASON: claim.get(NO_TEST_REASON),
    }
    evidence = store.write("review", body, repo_key)
    return {"evidence_id": evidence["evidence_id"], "repo": repo_key, "paths": len(paths)}


def check_provenance(source: dict) -> None:
    """Review evidence comes from a subagent whose transcript exists, never from the main thread."""
    if not source["agent_id"]:
        raise Refused("no agent_id: review evidence comes from a subagent, never the main thread")
    agent = os.path.realpath(os.path.expanduser(source["agent_transcript_path"]))
    if not os.path.isfile(agent):
        raise Refused("agent transcript does not exist: " + agent)


def write_smoke(repo_path: str, run_id: Optional[str]) -> dict:
    repo_root, repo_key = _repo_of(repo_path)
    run = _smoke_run(run_id)
    if run is None:
        raise Refused("no smoke run %s in keel-smoke.jsonl" % (run_id or "(latest)"))
    if not run.get("ok"):
        raise Refused("smoke run %s failed" % run.get("run_id"))
    tree = (run.get("trees") or {}).get(repo_key)
    if not tree:
        raise Refused("smoke run %s did not cover %s" % (run.get("run_id"), repo_key))
    evidence = store.write("smoke", {"repo": repo_key, "repo_root": repo_root, "run_id": run["run_id"], "tree": tree},
                           repo_key)
    return {"evidence_id": evidence["evidence_id"], "repo": repo_key, "tree": tree}


def write_approval(root_run_id: str, kind: str) -> dict:
    """`keel approve`: pin every repo's chain head of this root; refuse when none or any is not PASS."""
    if not env.RUN_ID_RE.match(root_run_id or ""):
        raise Usage("root_run_id must match %s" % env.RUN_ID_RE.pattern)
    heads = chain_heads(root_run_id)
    if not heads:
        raise Refused("no review chain with root %s" % root_run_id)
    failing = sorted(key for key, head in heads.items() if head["verdict"] != "PASS")
    if failing:
        raise Refused("chain head is not PASS for %s" % ", ".join(failing))
    from evidence import codex_review
    for head in heads.values():
        if head.get("review_kind") == codex_review.KIND or (head.get("source") or {}).get("via") == codex_review.VIA:
            codex_review.validate_evidence(head)
    pinned = {key: head["evidence_id"] for key, head in heads.items()}
    commits = {}
    for key, head in heads.items():
        commit = gitcmd.commit_sha(head['repo_root'], 'HEAD')
        if commit and gitcmd.tree_of_commit(head['repo_root'], commit) == head['reviewed_tree']:
            commits[key] = commit
    evidence = store.write(kind, {"root_run_id": root_run_id, "heads": pinned, "source": APPROVAL_SOURCE,
                                  "session_id": None, "commits": commits})
    return {"evidence_id": evidence["evidence_id"], "kind": kind, "root_run_id": root_run_id, "heads": pinned}


def chain_heads(root_run_id: str) -> Dict[str, dict]:
    """Newest chain head per repo for one root."""
    return {repo_key: chain.head for repo_key, chain in newest_chains(root_run_id).items()}


def newest_chains(root_run_id: str) -> Dict[str, Chain]:
    chains = {}
    for repo_key in store.repo_keys("review"):
        for chain in build_chains(store.load("review", repo_key)):
            if chain.root_run_id == root_run_id:
                chains[repo_key] = chain
                break
    return chains


def _validated_claim(claim) -> dict:
    if not isinstance(claim, dict) or set(claim) - {NO_TEST_REASON} != set(REVIEW_CLAIM_KEYS):
        raise Usage("keel_evidence must have exactly the keys %s (plus optional %s)" % (", ".join(REVIEW_CLAIM_KEYS), NO_TEST_REASON))
    reason = claim.get(NO_TEST_REASON)
    if reason is not None and not (isinstance(reason, str) and reason.strip()):
        raise Usage("%s must be a non-empty string" % NO_TEST_REASON)
    if claim["v"] != 1:
        raise Usage("keel_evidence.v must be 1")
    if (claim["head"] is None) == (claim["snapshot_tree"] is None):
        raise Usage("exactly one of head and snapshot_tree must be set")
    for key in ("review_base", "head", "snapshot_tree", "since"):
        if claim[key] is not None and not env.SHA_RE.match(str(claim[key])):
            raise Usage("%s must be a 40-hex id" % key)
    for key in ("run_id", "root_run_id"):
        if not env.RUN_ID_RE.match(str(claim[key])):
            raise Usage("%s must match %s" % (key, env.RUN_ID_RE.pattern))
    if claim["review_kind"] not in REVIEW_KINDS:
        raise Usage("review_kind must be one of " + ", ".join(REVIEW_KINDS))
    if claim["since"] is None and claim["run_id"] != claim["root_run_id"]:
        raise Refused("a root review needs root_run_id == run_id")
    return claim


def _validated_source(source) -> dict:
    if not isinstance(source, dict) or set(source) != set(SOURCE_KEYS):
        raise Usage("source must have exactly the keys " + ", ".join(SOURCE_KEYS))
    for key in ("session_id", "transcript_path", "agent_transcript_path"):
        if not source[key] or not isinstance(source[key], str):
            raise Usage("source.%s must be a non-empty string" % key)
    if source["via"] not in VIAS:
        raise Usage("source.via must be one of " + ", ".join(VIAS))
    if source["agent_id"] is not None and not isinstance(source["agent_id"], str):
        raise Usage("source.agent_id must be a string")
    return source


def _repo_of(path: str) -> Tuple[str, str]:
    repo_root = gitcmd.toplevel(path)
    if repo_root is None or repo_root != os.path.realpath(path):
        raise Refused("%s is not the root of a git repository" % path)
    repo_key = registry.origin_key(repo_root)
    if repo_key is None:
        raise Refused("%s has no origin remote to name the repo by" % repo_root)
    return repo_root, repo_key


def _check_objects(repo_root: str, claim: dict) -> None:
    expected = {"review_base": "commit", "head": "commit", "snapshot_tree": "tree", "since": "tree"}
    for key, kind in expected.items():
        if claim[key] is not None and gitcmd.object_type(repo_root, claim[key]) != kind:
            raise Refused("%s %s is not a %s in %s" % (key, claim[key], kind, repo_root))


def _resolve_since(repo_key: str, claim: dict) -> Tuple[Optional[str], Optional[str]]:
    if claim["since"] is None:
        return None, None
    for review in reversed(store.load("review", repo_key)):
        if review["root_run_id"] == claim["root_run_id"] and review["reviewed_tree"] == claim["since"]:
            return review["evidence_id"], claim["since"]
    raise Refused("no review of root %s reviewed tree %s" % (claim["root_run_id"], claim["since"]))


def _same_review(repo_key: str, run_id: str, reviewed_tree: str) -> Optional[dict]:
    return next((review for review in store.load("review", repo_key)
                 if review["run_id"] == run_id and review["reviewed_tree"] == reviewed_tree), None)


def _smoke_run(run_id: Optional[str]) -> Optional[dict]:
    path = os.path.join(env.logs_dir(), "keel-smoke.jsonl")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as stream:
        runs = [json.loads(line) for line in stream if line.strip()]
    matching = [run for run in runs if run_id is None or run.get("run_id") == run_id]
    return matching[-1] if matching else None


from __future__ import annotations

from collections import deque
from typing import List, NamedTuple, Optional, Tuple

from evidence import codex_review, comment_cleanup, gitcmd, registry, store, writers
from evidence.chain import Chain, build_chains
from evidence.gitcmd import GitError, PathEntry
from evidence.registry import GatedRepo
from evidence.risk import LIGHT, SMOKE_ONLY, Risk, classify
from evidence.writers import NO_TEST_REASON

K1 = "K1"
K3 = "K3"
RISK = "risk"
PASS = "PASS"
LENS_REVIEW = "lens-review"
GATE_SMOKE = "smoke"
PATHS_SHOWN = 8


class Reason(NamedTuple):
    rule_id: str
    text: str


class Outgoing(NamedTuple):
    repo_root: str
    repo_key: str
    row: GatedRepo
    head: str
    merge_base: str
    needs_approval: bool


class Decision(NamedTuple):
    ok: bool
    reasons: Tuple[Reason, ...]
    risk_class: Optional[str]
    root_run_id: Optional[str]
    files: int
    lines: int
    k3_waiver: Optional[str]
    root_run_ids: Tuple[str, ...] = ()


def judge(outgoing: Outgoing) -> Decision:

    entries = gitcmd.diff_entries(outgoing.repo_root, outgoing.merge_base, outgoing.head)
    if not entries:
        return Decision(True, (), None, None, 0, 0, None)
    stats = gitcmd.diff_stats(outgoing.repo_root, outgoing.merge_base, outgoing.head)
    risk = classify(entries, stats, registry.risk_rules(outgoing.row.risk_rules))
    if outgoing.row.gate == GATE_SMOKE or risk.risk_class == SMOKE_ONLY:
        reasons = _smoke_reasons(outgoing, entries)
        return Decision(not reasons, tuple(reasons), risk.risk_class, None, risk.files, risk.lines, None)
    chain, roots, reasons = _resolve_reviews(outgoing, entries)
    reasons += _test_reasons(outgoing, entries, risk)
    waiver = _no_test_reason(chain)
    unchanged_logic = {entry.path for entry in entries if not entry.deleted
                       and comment_cleanup.matches_content(outgoing.repo_root, entry.path,
                           gitcmd.tree_entry(outgoing.repo_root, outgoing.merge_base, entry.path),
                           (entry.mode, entry.blob))}
    reasons += _same_range_test_reasons(risk, waiver, unchanged_logic)
    root_run_id = chain.root_run_id if chain else None
    used_waiver = waiver if risk.logic_paths() and not risk.has_test_path() else None
    return Decision(not reasons, tuple(reasons), risk.risk_class, root_run_id, risk.files, risk.lines, used_waiver, roots)


def covers(repo_root: str, tree: str, entries: List[PathEntry]) -> bool:

    try:
        return all(comment_cleanup.matches_content(repo_root, entry.path, gitcmd.tree_entry(repo_root, tree, entry.path),
                                                  None if entry.deleted else (entry.mode, entry.blob))
                   for entry in entries)
    except GitError:
        return False


def bound_evidence(kind: str, root_run_id: str, repo_key: str, head_id: str) -> Optional[dict]:

    return next((evidence for evidence in reversed(store.load(kind))
                 if evidence["root_run_id"] == root_run_id and evidence["heads"].get(repo_key) == head_id), None)


def _resolve_reviews(outgoing: Outgoing, entries: List[PathEntry]):
    chains = build_chains(store.load("review", outgoing.repo_key))
    chain, reasons = _best_chain(outgoing, entries, chains)
    if not reasons:
        return chain, (chain.root_run_id,), reasons
    series = _approved_series(outgoing, chains)
    if series:
        return None, series, []
    return chain, (), reasons


def _approved_series(outgoing: Outgoing, chains: List[Chain]) -> Tuple[str, ...]:
    pending = deque([(outgoing.head, ())])
    visited = set()
    while pending:
        boundary, suffix = pending.popleft()
        if boundary == outgoing.merge_base:
            return suffix
        if boundary in visited:
            continue
        visited.add(boundary)
        for base, root in _approved_predecessors(outgoing, boundary, chains):
            pending.append((base, (root,) + suffix))
    return ()


def _approved_predecessors(outgoing: Outgoing, boundary: str, chains: List[Chain]):
    tree = gitcmd.tree_of_commit(outgoing.repo_root, boundary)
    for chain in chains:
        base = chain.root["review_base"]
        if base == boundary:
            continue
        if chain.head["reviewed_tree"] != tree and not covers(outgoing.repo_root, chain.head["reviewed_tree"],
                gitcmd.diff_entries(outgoing.repo_root, chain.head["reviewed_tree"], tree)):
            continue
        if not gitcmd.is_ancestor(outgoing.repo_root, outgoing.merge_base, base):
            continue
        if not gitcmd.is_ancestor(outgoing.repo_root, base, boundary):
            continue
        interval = outgoing._replace(head=boundary, merge_base=base, needs_approval=True)
        entries = gitcmd.diff_entries(outgoing.repo_root, base, boundary)
        if not _chain_reasons(interval, chain, entries):
            yield base, chain.root_run_id


def _best_chain(outgoing: Outgoing, entries: List[PathEntry],
                chains: List[Chain]) -> Tuple[Optional[Chain], List[Reason]]:
    if not chains:
        return None, [Reason(K1, "no review evidence for %s: run lens-review on this change" % outgoing.repo_key)]
    judged = [(chain, _chain_reasons(outgoing, chain, entries)) for chain in chains]
    for chain, reasons in judged:
        if not reasons:
            return chain, []


    return min(judged, key=lambda item: (bool(_coverage_reasons(item[0], entries, outgoing.repo_root)), judged.index(item)))


def _chain_reasons(outgoing: Outgoing, chain: Chain, entries: List[PathEntry]) -> List[Reason]:
    reasons = []
    root = chain.root_run_id
    if chain.head["verdict"] != PASS:
        reasons.append(Reason(K1, "chain %s ends in %s: a delta review must pass first" % (root, chain.head["verdict"])))
    if not gitcmd.is_ancestor(outgoing.repo_root, chain.root["review_base"], outgoing.merge_base):
        reasons.append(Reason(K1, "chain %s reviewed from %s, not from the merge base %s or an ancestor of it"
                              % (root, chain.root["review_base"][:10], outgoing.merge_base[:10])))
    reasons += _coverage_reasons(chain, entries, outgoing.repo_root)
    if any(link["review_kind"] not in (LENS_REVIEW, codex_review.KIND) for link in chain.links):
        reasons.append(Reason(RISK, "every change needs a lens-review chain; chain %s has a %s link"
                              % (root, "single-lens")))
    reasons += _provenance_reasons(chain)
    reasons += _approval_reasons(outgoing, chain)
    return reasons


def _coverage_reasons(chain: Chain, entries: List[PathEntry], repo: str) -> List[Reason]:
    missing = []
    for entry in entries:
        if entry.is_gitlink:
            continue
        reviewed = chain.reviewed.get(entry.path)
        if reviewed is None:
            missing.append("%s (not in any reviewed diff)" % entry.path)
        elif entry.deleted and reviewed[0] is not None:
            missing.append("%s (deletion not reviewed)" % entry.path)
        elif not entry.deleted and not comment_cleanup.matches_content(repo, entry.path,
                (reviewed[1], reviewed[0]), (entry.mode, entry.blob)):
            missing.append("%s (content or mode changed after review)" % entry.path)
    if not missing:
        return []
    return [Reason(K1, "chain %s does not cover: %s" % (chain.root_run_id, _shown(missing)))]


def _provenance_reasons(chain: Chain) -> List[Reason]:

    for link in chain.links:
        if link.get("review_kind") == codex_review.KIND or (link.get("source") or {}).get("via") == codex_review.VIA:
            try:
                codex_review.validate_evidence(link)
            except (writers.Refused, OSError, ValueError, KeyError, TypeError) as error:
                return [Reason(K1, "invalid Codex provenance: %s" % error)]
        if not (link.get("source") or {}).get("agent_id"):
            return [Reason(K1, "review %s has no agent provenance" % link["evidence_id"])]
    return []


def _approval_reasons(outgoing: Outgoing, chain: Chain) -> List[Reason]:


    head_id = chain.head["evidence_id"]
    if not outgoing.needs_approval or bound_evidence("approval", chain.root_run_id, outgoing.repo_key, head_id):
        return []
    return [Reason(K1, "no approval bound to chain head %s: run `keel approve %s`" % (head_id, chain.root_run_id))]


def _test_reasons(outgoing: Outgoing, entries: List[PathEntry], risk: Risk) -> List[Reason]:
    if risk.risk_class == LIGHT and not outgoing.row.tests_required:
        return []
    if not outgoing.row.tests_required:
        return [Reason(K3, "add test infrastructure first: %s has tests=none and the change is %s"
                       % (outgoing.repo_key, risk.risk_class))]
    if _covered_by("tests", outgoing, entries):
        return []
    return [Reason(K3, "no tests evidence covers this exact content: run `keel test -- <test command>`")]


def _same_range_test_reasons(risk: Risk, waiver: Optional[str], unchanged_logic=()) -> List[Reason]:

    logic = [path for path in risk.logic_paths() if path not in unchanged_logic]
    if not logic or risk.has_test_path() or waiver:
        return []
    return [Reason(K3, "logic changed with no test in the same range: %s; add a test, or have the reviewer state "
                       "%s in KEEL-EVIDENCE" % (_shown(logic), NO_TEST_REASON))]


def _no_test_reason(chain: Optional[Chain]) -> Optional[str]:

    return chain.head.get(NO_TEST_REASON) if chain else None


def _covered_by(kind: str, outgoing: Outgoing, entries: List[PathEntry]) -> bool:
    return any(covers(outgoing.repo_root, evidence["tree"], entries) for evidence in store.load(kind, outgoing.repo_key))


def _smoke_reasons(outgoing: Outgoing, entries: List[PathEntry]) -> List[Reason]:
    if _covered_by("smoke", outgoing, entries):
        return []
    return [Reason(RISK, "no smoke evidence covers this exact content: run measure/smoke, then `keel evidence write-smoke`")]


def _shown(items: List[str]) -> str:
    shown = ", ".join(items[:PATHS_SHOWN])
    if len(items) > PATHS_SHOWN:
        shown += ", +%d more" % (len(items) - PATHS_SHOWN)
    return shown

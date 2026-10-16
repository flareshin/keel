from __future__ import annotations

import subprocess

from evidence import env, gitcmd, registry, store, verify, writers
from evidence.chain import build_chains


def approved_fast_forward(repo: str, target: str) -> bool:
    if not isinstance(target, str) or not env.SHA_RE.fullmatch(target):
        return False
    try:
        key = registry.origin_key(repo)
        row = registry.lookup(key)
        if not row or row.gate != 'code' or gitcmd.object_type(repo, target) != 'commit':
            return False
        if gitcmd.text(repo, 'status', '--porcelain', '--untracked-files=all'):
            return False
        head = gitcmd.commit_sha(repo, 'HEAD')
        if not head or gitcmd.merge_base(repo, head, target) != head:
            return False
        tree = gitcmd.tree_of_commit(repo, target)
        approved = set()
        for chain in build_chains(store.load('review', key)):
            proof = verify.bound_evidence('approval', chain.root_run_id, key, chain.head['evidence_id'])
            if (chain.head['reviewed_tree'] == tree and chain.head['verdict'] == 'PASS'
                    and proof and proof.get('commits', {}).get(key) == target):
                approved.add(chain.root_run_id)
        if not approved:
            return False
        if head == target:
            return any(not verify._provenance_reasons(chain) for chain in build_chains(store.load('review', key))
                       if chain.root_run_id in approved)
        decision = verify.judge(verify.Outgoing(repo, key, row, target, head, True))
        return decision.ok and bool(approved.intersection(decision.root_run_ids))
    except (gitcmd.GitError, registry.RegistryError, store.EvidenceError, writers.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return False

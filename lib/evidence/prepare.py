from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

from evidence import env, gitcmd, registry, risk, writers


def review(request: dict) -> dict:
    diffs = request.get('diffs')
    if not isinstance(diffs, list) or not diffs:
        raise writers.Usage('review prepare needs a nonempty diffs list')
    targets = [prepare_target(target) for target in diffs]
    lenses_path = Path(env.data_dir()) / 'workflows/review-lenses.json'
    lenses = json.loads(lenses_path.read_text()) if 'lenses' not in request else {}
    return {'diff_outputs': [json.dumps(target) for target in targets],
            'run_id_output': env.new_id('rv', env.utc_now(), env.RUN_ID_RANDOM_BYTES),
            'lenses_output': {'lenses': lenses.get('lenses', []), 'guardrails': lenses.get('guardrails', '')},
            'needs_fixes_rounds': count_needs_fixes_rounds(request.get('rootRunId')),
            'risk_class': review_risk_class(targets)}


def count_needs_fixes_rounds(root_run_id) -> int:
    if not isinstance(root_run_id, str):
        return 0
    chains = writers.newest_chains(root_run_id).values()
    return max((sum(link['verdict'] == 'NEEDS_FIXES' for link in chain.links) for chain in chains), default=0)


def prepare_target(target: dict) -> dict:
    if not isinstance(target, dict) or set(target) - {'repo', 'base', 'head', 'since'}:
        raise writers.Usage('invalid review target')
    if not isinstance(target.get('repo'), str):
        raise writers.Usage('target repository must be a path')
    repo = gitcmd.toplevel(target['repo'])
    base = target.get('base')
    if repo is None or not isinstance(base, str) or base.startswith('-'):
        raise writers.Usage('target needs a repository and base ref')
    head = target.get('head')
    if head is not None and (not isinstance(head, str) or head.startswith('-')):
        raise writers.Usage('invalid head ref')
    end = gitcmd.commit_sha(repo, head) if head else gitcmd.snapshot_tree(repo)
    if not end:
        raise writers.Refused('review head does not exist')
    start = gitcmd.merge_base(repo, base, end if head else 'HEAD')
    if not end or not start:
        raise writers.Refused('review target objects do not exist')
    since = target.get('since')
    if since is not None and (not isinstance(since, str) or not env.SHA_RE.fullmatch(since)
                              or gitcmd.object_type(repo, since) != 'tree'):
        raise writers.Refused('since must be a recorded snapshot tree')
    stat = gitcmd.text(repo, 'diff', '--shortstat', since or start, end)
    return {'repo_root': repo, 'review_base': start, 'head': end if head else None,
            'snapshot_tree': None if head else end, 'diff_stat': stat}


def review_risk_class(targets: List[dict]) -> Optional[str]:
    classes = [repo_risk_class(target) for target in targets]
    if None in classes:
        return None
    return max(classes, key=risk.CLASS_ORDER.index)


def repo_risk_class(target: dict) -> Optional[str]:
    repo = target['repo_root']
    row = registry.lookup(registry.origin_key(repo))
    if not registry.is_gated(row):
        return None
    end = target['head'] or target['snapshot_tree']
    entries = gitcmd.diff_entries(repo, target['review_base'], end)
    stats = gitcmd.diff_stats(repo, target['review_base'], end)
    return risk.classify(entries, stats, registry.risk_rules(row.risk_rules)).risk_class

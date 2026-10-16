from __future__ import annotations

import os
from typing import NamedTuple

from evidence import codex_review as native
from evidence import gitcmd, store, writers

REPORT_KEYS = native.REPORT_KEYS | {'since_tree', 'root_run_id'}
SOURCE_KEYS = {'version', 'via', 'session_id', 'agent_id', 'reviewers'}
REVIEWER_KEYS = {'session_id', 'path', 'sha256'}


class Review(NamedTuple):
    identity: str
    path: str
    sha256: str
    meta: dict
    report: dict


class Bundle(NamedTuple):
    author: str
    base: str
    tree: str
    since_tree: str | None
    root_run_id: str
    previous: dict | None
    findings: dict


def register(repo_path: str, audit_ids: list[str], verifier_ids: list[str]) -> dict:
    repo, key = writers._repo_of(repo_path)
    reviews = load_reviews(audit_ids + verifier_ids)
    if any(review.report.get('role') != 'audit' for review in reviews[:len(audit_ids)]):
        raise writers.Refused('--audits must name audit children')
    if any(review.report.get('role') != 'verify' for review in reviews[len(audit_ids):]):
        raise writers.Refused('--verifiers must name verifier children')
    run_id = review_run_id(reviews)
    existing = writers._same_review(key, run_id, reviews[0].report.get('tree'))
    bundle = validate_evidence(existing) if existing else analyze(repo, key, reviews, set())
    caller = os.environ.get('CODEX_THREAD_ID')
    if caller and caller != bundle.author:
        raise writers.Refused('review belongs to a different author session')
    if gitcmd.snapshot_tree(repo) != bundle.tree:
        raise writers.Refused('working tree changed after the review')
    body = build_body(repo, key, bundle, reviews)
    if existing:
        if any(existing.get(key) != value for key, value in body.items()):
            raise writers.Refused('existing review differs from the requested completed children')
        evidence = existing
    else:
        evidence = store.write('review', body, key)
    return {'evidence_id': evidence['evidence_id'], 'root_run_id': bundle.root_run_id,
            'verdict': evidence['verdict'], 'paths': len(evidence['paths'])}


def load_reviews(identities: list[str]) -> list[Review]:
    if not identities or len(identities) != len(set(identities)):
        raise writers.Refused('review children must be nonempty and distinct')
    reviews = []
    for identity in identities:
        path, content = native.locate_session(identity)
        meta, report = native.completed_report(content, identity)
        reviews.append(Review(identity, str(path), native.digest(content), meta, report))
    return reviews


def analyze(repo: str, key: str, reviews: list[Review], trail: set[str], previous_id: str | None = None) -> Bundle:
    author = shared_author(reviews)
    first = reviews[0].report
    target = tuple(first.get(name) for name in ('base', 'tree', 'since_tree', 'root_run_id'))
    audits, verifiers = {}, {}
    for review in reviews:
        validate_report(review.report, repo, target)
        report = review.report
        if report['role'] == 'audit':
            lens = next(iter(report['lenses']))
            if lens in audits:
                raise writers.Refused('each lens needs exactly one independent auditor')
            audits[lens] = review
        else:
            identity = report['audit_session']
            if identity in verifiers:
                raise writers.Refused('each nonempty audit gets one batched verifier')
            verifiers[identity] = review
    if set(audits) != native.LENSES:
        raise writers.Refused('native audit must cover all five lenses exactly once')
    expected = {review.identity for review in audits.values() if review.report['findings']}
    if set(verifiers) != expected:
        raise writers.Refused('verify exactly the audits with findings; clean audits need no verifier')
    base, tree, since_tree, root = target
    previous, prior_findings = prior_review(key, base, since_tree, root, trail, previous_id)
    findings = settle_lenses(audits, verifiers, prior_findings)
    native.validate_rule_checks(repo, base, tree, audits['rule-checks'].report)
    run_id = review_run_id(reviews)
    return Bundle(author, base, tree, since_tree, root or run_id, previous, findings)


def shared_author(reviews: list[Review]) -> str:
    parents = set()
    try:
        for review in reviews:
            parent = review.meta['source']['subagent']['thread_spawn']['parent_thread_id']
            if parent != review.meta['parent_thread_id']:
                raise ValueError()
            parents.add(parent)
        if len(parents) != 1:
            raise ValueError()
        author = parents.pop()
        if author in {review.identity for review in reviews}:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise writers.Refused('reviewers must be distinct children of the same author')
    native.locate_session(author)
    return author


def validate_report(report: dict, repo: str, target: tuple) -> None:
    if set(report) != REPORT_KEYS or report.get('version') != 2 or report.get('role') not in ('audit', 'verify'):
        raise writers.Refused('invalid lens review schema or role')
    if report['repo'] != repo or tuple(report[name] for name in ('base', 'tree', 'since_tree', 'root_run_id')) != target:
        raise writers.Refused('native reviewers disagree about the target')
    for name in ('base', 'tree', 'since_tree'):
        identity = report[name]
        if name == 'since_tree' and identity is None:
            continue
        if not isinstance(identity, str) or not writers.env.SHA_RE.fullmatch(identity):
            raise writers.Refused('invalid target object id')
    if (report['since_tree'] is None) != (report['root_run_id'] is None):
        raise writers.Refused('delta reviews need both since_tree and root_run_id')
    root = report['root_run_id']
    if root is not None and (not isinstance(root, str) or not writers.env.RUN_ID_RE.fullmatch(root)):
        raise writers.Refused('invalid delta root run id')
    lenses = report['lenses']
    if not isinstance(lenses, dict):
        raise writers.Refused('lenses must be an object')
    if report['role'] == 'audit':
        if len(lenses) != 1 or not set(lenses) <= native.LENSES or report['audit_session'] is not None:
            raise writers.Refused('each auditor covers exactly one lens')
        for item in lenses.values():
            if not isinstance(item, dict) or set(item) != {'status', 'evidence'} or item['status'] != 'complete' or not native.nonblank(item['evidence']):
                raise writers.Refused('incomplete or unproven review lens')
    elif lenses or not isinstance(report['audit_session'], str):
        raise writers.Refused('verifiers settle findings instead of repeating lens audits')
    native.validate_findings(report['findings'])


def prior_review(key: str, base: str, since_tree, root, trail: set[str], previous_id: str | None) -> tuple:
    if since_tree is None:
        return None, {lens: [] for lens in native.LENSES}
    if previous_id is None:
        previous = writers.chain_heads(root).get(key)
    else:
        previous = next((review for review in store.load('review', key)
                         if review['evidence_id'] == previous_id), None)
    if not previous or (previous['root_run_id'], previous['reviewed_tree'], previous['review_base']) != (root, since_tree, base):
        raise writers.Refused('delta must follow the exact previous review with the same base')
    if previous.get('source', {}).get('version') != 2:
        raise writers.Refused('lens delta requires an existing version 2 review chain')
    prior_bundle = validate_evidence(previous, trail)
    return previous, prior_bundle.findings


def settle_lenses(audits: dict, verifiers: dict, prior_findings: dict) -> dict:
    findings = {}
    for lens, review in audits.items():
        audit = review.report
        remaining = native.adjudicated_findings(prior_findings[lens], audit['decisions'])
        if audit['findings']:
            verification = verifiers[review.identity].report
            remaining += native.adjudicated_findings(audit['findings'], verification['decisions'])
            remaining += verification['findings']
        native.validate_findings(remaining)
        findings[lens] = remaining
    return findings


def review_run_id(reviews: list[Review]) -> str:
    identities = '\n'.join(sorted(review.identity for review in reviews))
    return 'cx2-' + native.digest(identities.encode())[:32]


def build_body(repo: str, key: str, bundle: Bundle, reviews: list[Review]) -> dict:
    if gitcmd.object_type(repo, bundle.base) != 'commit' or gitcmd.object_type(repo, bundle.tree) != 'tree':
        raise writers.Refused('review target objects do not exist')
    paths = [{'path': entry.path, 'blob': entry.blob, 'mode': entry.mode}
             for entry in gitcmd.diff_entries(repo, bundle.since_tree or bundle.base, bundle.tree)]
    if not paths:
        raise writers.Refused('review recognized zero changed paths')
    findings = [finding for lens in bundle.findings.values() for finding in lens]
    verdict = 'NEEDS_FIXES' if any(finding['impact'] in ('high', 'medium') for finding in findings) else 'PASS'
    run_id = review_run_id(reviews)
    source = {'version': 2, 'via': native.VIA, 'session_id': bundle.author,
              'agent_id': min(review.identity for review in reviews if review.report['role'] == 'audit'),
              'reviewers': [{'session_id': review.identity, 'path': review.path, 'sha256': review.sha256}
                            for review in sorted(reviews, key=lambda item: item.identity)]}
    return {'repo': key, 'repo_root': repo, 'run_id': run_id, 'root_run_id': bundle.root_run_id,
            'since': bundle.previous['evidence_id'] if bundle.previous else None,
            'since_tree': bundle.since_tree, 'review_base': bundle.base, 'head': None,
            'snapshot_tree': bundle.tree, 'reviewed_tree': bundle.tree, 'review_kind': native.KIND,
            'verdict': verdict, 'paths': paths, 'source': source, writers.NO_TEST_REASON: None}


def validate_evidence(evidence: dict, trail: set[str] | None = None) -> Bundle:
    trail = set() if trail is None else set(trail)
    identity = evidence.get('evidence_id')
    if identity in trail:
        raise writers.Refused('cyclic native review chain')
    trail.add(identity)
    source = evidence.get('source') or {}
    if set(source) != SOURCE_KEYS or source['version'] != 2 or source['via'] != native.VIA:
        raise writers.Refused('invalid lens review provenance')
    recorded = source['reviewers']
    if not isinstance(recorded, list) or any(not isinstance(item, dict) or set(item) != REVIEWER_KEYS for item in recorded):
        raise writers.Refused('invalid reviewer source list')
    reviews = load_reviews([item['session_id'] for item in recorded])
    bundle = analyze(evidence['repo_root'], evidence['repo'], reviews, trail, evidence.get('since'))
    expected = build_body(evidence['repo_root'], evidence['repo'], bundle, reviews)
    if any(evidence.get(key) != value for key, value in expected.items()):
        raise writers.Refused('native lens evidence differs from its completed reviews or Git target')
    return bundle

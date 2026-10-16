from __future__ import annotations

import hashlib
import json
import os
import pwd
import re
import subprocess
import sys
from pathlib import Path
import uuid

from evidence import gitcmd, store, writers

KIND = 'codex-lens-review'
VIA = 'CodexSubagents'
LENSES = {'reuse', 'contract', 'tests', 'readable-code', 'rule-checks'}
REPORT_KEYS = {'version', 'role', 'repo', 'base', 'tree', 'lenses', 'findings', 'audit_session', 'decisions'}
SOURCE_KEYS = {'via', 'session_id', 'audit_id', 'agent_id', 'audit_path', 'agent_transcript_path', 'audit_sha256', 'agent_sha256'}


def register(repo_path: str, audit_id: str, verifier_id: str) -> dict:
    repo, key = writers._repo_of(repo_path)
    audit_path, audit_bytes = locate_session(audit_id)
    verifier_path, verifier_bytes = locate_session(verifier_id)
    audit_meta, audit = completed_report(audit_bytes, audit_id)
    verifier_meta, verification = completed_report(verifier_bytes, verifier_id)
    author = shared_author(audit_meta, verifier_meta, audit_id, verifier_id)
    caller = os.environ.get('CODEX_THREAD_ID')
    if caller and caller != author:
        raise writers.Refused('review belongs to a different author session')
    locate_session(author)
    verdict = validate_reports(audit, verification, repo, audit_id)
    base, tree = audit['base'], audit['tree']
    validate_rule_checks(repo, base, tree, audit, verification)
    if gitcmd.object_type(repo, base) != 'commit' or gitcmd.object_type(repo, tree) != 'tree':
        raise writers.Refused('review target objects do not exist')
    if gitcmd.snapshot_tree(repo) != tree:
        raise writers.Refused('working tree changed after the review')
    paths = [{'path': entry.path, 'blob': entry.blob, 'mode': entry.mode}
             for entry in gitcmd.diff_entries(repo, base, tree)]
    if not paths:
        raise writers.Refused('review recognized zero changed paths')
    root = 'cx-' + verifier_id
    source = {'via': VIA, 'session_id': author, 'audit_id': audit_id, 'agent_id': verifier_id,
              'audit_path': str(audit_path), 'agent_transcript_path': str(verifier_path),
              'audit_sha256': digest(audit_bytes), 'agent_sha256': digest(verifier_bytes)}
    body = {'repo': key, 'repo_root': repo, 'run_id': root, 'root_run_id': root, 'since': None,
            'since_tree': None, 'review_base': base, 'head': None, 'snapshot_tree': tree, 'reviewed_tree': tree,
            'review_kind': KIND, 'verdict': verdict, 'paths': paths, 'source': source, writers.NO_TEST_REASON: None}
    validate_evidence(body)
    existing = writers._same_review(key, root, tree)
    if existing:
        validate_evidence(existing)
        evidence = existing
    else:
        evidence = store.write('review', body, key)
    return {'evidence_id': evidence['evidence_id'], 'root_run_id': root, 'verdict': verdict, 'paths': len(paths)}


def validate_evidence(evidence: dict) -> None:
    source = evidence.get('source') or {}
    if set(source) != SOURCE_KEYS or source.get('via') != VIA or evidence.get('review_kind') != KIND:
        raise writers.Refused('invalid Codex review provenance')
    audit_path, audit_bytes = locate_session(source['audit_id'])
    verifier_path, verifier_bytes = locate_session(source['agent_id'])
    if (str(audit_path), str(verifier_path), digest(audit_bytes), digest(verifier_bytes)) != (
            source['audit_path'], source['agent_transcript_path'], source['audit_sha256'], source['agent_sha256']):
        raise writers.Refused('Codex review transcript changed or moved')
    audit_meta, audit = completed_report(audit_bytes, source['audit_id'])
    verifier_meta, verification = completed_report(verifier_bytes, source['agent_id'])
    author = shared_author(audit_meta, verifier_meta, source['audit_id'], source['agent_id'])
    if author != source['session_id']:
        raise writers.Refused('Codex author identity changed')
    locate_session(author)
    verdict = validate_reports(audit, verification, evidence['repo_root'], source['audit_id'])
    validate_rule_checks(evidence['repo_root'], audit['base'], audit['tree'], audit, verification)
    root = 'cx-' + source['agent_id']
    if (evidence.get('review_base'), evidence.get('reviewed_tree'), evidence.get('snapshot_tree'),
            evidence.get('verdict'), evidence.get('run_id'), evidence.get('root_run_id'), evidence.get('head'),
            evidence.get('since'), evidence.get('since_tree'), evidence.get(writers.NO_TEST_REASON)) != (
            audit['base'], audit['tree'], audit['tree'], verdict, root, root, None, None, None, None):
        raise writers.Refused('Codex evidence does not match its completed reviews')


def locate_session(identity: str) -> tuple[Path, bytes]:
    try:
        if str(uuid.UUID(identity)) != identity:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise writers.Refused('Codex session id must be a canonical UUID')
    root = session_root()
    matches = list((root / 'sessions').glob(f'**/rollout-*-{identity}.jsonl'))
    if len(matches) != 1:
        raise writers.Refused('expected one live Codex rollout for ' + identity)
    path = matches[0]
    if path.is_symlink() or not path.resolve().is_relative_to(root / 'sessions'):
        raise writers.Refused('Codex rollout escaped its session root')
    try:
        content = path.read_bytes()
        records = [json.loads(line) for line in content.splitlines()]
        if not records or records[0].get('type') != 'session_meta' or records[0]['payload'].get('id') != identity:
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise writers.Refused('invalid Codex rollout: ' + str(path))
    return path.resolve(), content


def session_root() -> Path:
    return (Path(pwd.getpwuid(os.getuid()).pw_dir) / '.codex').resolve()


def completed_report(content: bytes, identity: str) -> tuple[dict, dict]:
    try:
        records = [json.loads(line) for line in content.splitlines()]
        meta = records[0]['payload']
        if records[0]['type'] != 'session_meta' or meta['id'] != identity:
            raise ValueError()
        turn = None
        final = None
        complete = False
        for record in records[1:]:
            payload = record.get('payload') or {}
            if record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
                turn, final, complete = payload.get('turn_id'), None, False
            if record.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'assistant' and payload.get('phase') == 'final_answer':
                final = ''.join(item['text'] for item in payload['content'] if item.get('type') == 'output_text')
            if record.get('type') == 'event_msg' and payload.get('type') in ('task_complete', 'turn_aborted'):
                complete = payload.get('type') == 'task_complete' and bool(turn) and payload.get('turn_id') == turn
        if not complete or final is None:
            raise ValueError()
        report = json.loads(final)
        if not isinstance(report, dict):
            raise ValueError()
        return meta, report
    except (ValueError, KeyError, TypeError, AttributeError, IndexError):
        raise writers.Refused('Codex reviewer has no completed structured final report')


def shared_author(audit: dict, verifier: dict, audit_id: str, verifier_id: str) -> str:
    try:
        parents = []
        for meta in (audit, verifier):
            parent = meta['source']['subagent']['thread_spawn']['parent_thread_id']
            if parent != meta['parent_thread_id']:
                raise ValueError()
            parents.append(parent)
        if parents[0] != parents[1] or len({parents[0], audit_id, verifier_id}) != 3:
            raise ValueError()
        return parents[0]
    except (KeyError, ValueError, TypeError):
        raise writers.Refused('audit and verifier must be distinct children of the same author')


def validate_reports(audit: dict, verification: dict, repo: str, audit_id: str) -> str:
    for report, role in ((audit, 'audit'), (verification, 'verify')):
        if set(report) != REPORT_KEYS or report.get('version') != 1 or report.get('role') != role:
            raise writers.Refused('invalid native review report schema or role')
        if report.get('repo') != repo or report.get('base') != audit.get('base') or report.get('tree') != audit.get('tree'):
            raise writers.Refused('native reviewers disagree about the target')
        for key in ('base', 'tree'):
            if not isinstance(report.get(key), str) or not writers.env.SHA_RE.fullmatch(report[key]):
                raise writers.Refused('invalid target object id')
        lenses = report.get('lenses')
        if not isinstance(lenses, dict) or set(lenses) != LENSES:
            raise writers.Refused('every native review must cover all five lenses')
        if any(not isinstance(item, dict) or set(item) != {'status', 'evidence'} or item.get('status') != 'complete' or not nonblank(item.get('evidence')) for item in lenses.values()):
            raise writers.Refused('incomplete or unproven review lens')
        validate_findings(report.get('findings'))
    if audit['audit_session'] is not None or audit['decisions'] != [] or verification['audit_session'] != audit_id:
        raise writers.Refused('invalid audit linkage')
    decisions = verification.get('decisions')
    if not isinstance(decisions, list):
        raise writers.Refused('verifier decisions must be a list')
    ids = [finding['id'] for finding in audit['findings']]
    seen = []
    confirmed = []
    for decision in decisions:
        if not isinstance(decision, dict) or set(decision) != {'id', 'verdict', 'evidence'} or decision.get('verdict') not in ('confirmed', 'refuted') or not nonblank(decision.get('evidence')):
            raise writers.Refused('every finding needs an evidenced verifier decision')
        seen.append(decision['id'])
        if decision['verdict'] == 'confirmed':
            confirmed.append(decision['id'])
    if sorted(seen) != sorted(ids):
        raise writers.Refused('verifier must settle every audit finding exactly once')
    findings = [finding for finding in audit['findings'] if finding['id'] in confirmed] + verification['findings']
    return 'NEEDS_FIXES' if any(finding['impact'] in ('high', 'medium') for finding in findings) else 'PASS'


def validate_findings(findings) -> None:
    if not isinstance(findings, list):
        raise writers.Refused('findings must be a list')
    ids = []
    for finding in findings:
        if not isinstance(finding, dict) or set(finding) != {'id', 'impact', 'evidence', 'scenario'}:
            raise writers.Refused('invalid finding schema')
        if finding['impact'] not in ('high', 'medium', 'low') or any(not nonblank(finding[key]) for key in ('id', 'evidence', 'scenario')):
            raise writers.Refused('finding needs impact, file evidence and a failure scenario')
        ids.append(finding['id'])
    if len(ids) != len(set(ids)):
        raise writers.Refused('finding ids must be unique')


def nonblank(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def run_rule_checks(repo: str, base: str, tree: str) -> str:
    script = Path(__file__).resolve().parents[2] / 'skills/readable-code/scripts/rule-checks.py'
    try:
        run = subprocess.run([sys.executable, str(script), '--repo', repo, '--base', base, '--head', tree],
                             capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise writers.Refused('rule-checks could not complete: ' + str(error))
    summaries = re.findall(r'^summary repos=([0-9]+) scanned_lines=([0-9]+) signals=([0-9]+) unscanned=(\S+) blocked=(\S+)$', run.stdout, re.M)
    if run.returncode or len(summaries) != 1 or int(summaries[0][0]) == 0 or summaries[0][3:] != ('none', 'none'):
        raise writers.Refused('rule-checks failed, recognized zero repos or left targets unscanned')
    return next(line for line in run.stdout.splitlines() if line.startswith('summary '))


def validate_rule_checks(repo: str, base: str, tree: str, audit: dict, verification: dict) -> None:
    measured = run_rule_checks(repo, base, tree)
    for report in (audit, verification):
        cited = re.findall(r'summary repos=[0-9]+ scanned_lines=[0-9]+ signals=[0-9]+ unscanned=\S+ blocked=\S+', report['lenses']['rule-checks']['evidence'])
        if cited != [measured]:
            raise writers.Refused('each reviewer must cite the exact rule-checks summary for the reviewed target')

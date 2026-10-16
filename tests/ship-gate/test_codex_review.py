from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from helpers import KEEL_HOME, Sandbox

sys.path.insert(0, os.path.join(KEEL_HOME, 'lib'))
from evidence import codex_review, gitcmd, registry, store, verify, writers

AUTHOR = '11111111-1111-4111-8111-111111111111'
AUDIT = '22222222-2222-4222-8222-222222222222'
VERIFY = '33333333-3333-4333-8333-333333333333'
LENSES = ('reuse', 'contract', 'tests', 'readable-code', 'rule-checks')


class CodexReviewTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = Sandbox(self)
        self.repo = self.sandbox.clone("acme", "app")
        self.base = self.repo.head()
        self.repo.write('src/a.py', 'print(2)\n')
        self.repo.write('tests/test_a.py', 'assert 1 + 1 == 2\n')
        self.profile = Path(self.sandbox.root) / 'codex'
        self.environ = patch.dict(os.environ, {**self.sandbox.env, 'CODEX_HOME': str(self.profile), 'CODEX_THREAD_ID': AUTHOR})
        profile_patch = patch.object(codex_review, 'session_root', return_value=self.profile)
        profile_patch.start()
        self.addCleanup(profile_patch.stop)
        self.environ.start()
        self.addCleanup(self.environ.stop)
        self.tree = gitcmd.snapshot_tree(self.repo.path)
        self.report = {'version': 1, 'role': 'audit', 'repo': self.repo.path, 'base': self.base,
                       'tree': self.tree, 'lenses': {key: {'status': 'complete', 'evidence': 'static: src/a.py:1 inspected'} for key in LENSES},
                       'findings': [], 'audit_session': None, 'decisions': []}
        self.report['lenses']['rule-checks']['evidence'] = codex_review.run_rule_checks(self.repo.path, self.base, self.tree)
        self.write_session(AUTHOR, None, None)
        self.write_session(AUDIT, AUTHOR, self.report)
        self.verification = dict(self.report, role='verify', audit_session=AUDIT)
        self.write_session(VERIFY, AUTHOR, self.verification)

    def write_session(self, identity, parent, report, completed=True):
        directory = self.profile / 'sessions' / '2026' / '10' / '16'
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f'rollout-2026-10-16T13-00-00-{identity}.jsonl'
        meta = {'id': identity, 'cwd': self.repo.path, 'source': 'cli'}
        if parent:
            meta.update(parent_thread_id=parent, source={'subagent': {'thread_spawn': {'parent_thread_id': parent}}})
        records = [{'type': 'session_meta', 'payload': meta}]
        if report:
            records += [{'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'turn-1'}},
                        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'phase': 'final_answer',
                         'content': [{'type': 'output_text', 'text': json.dumps(report)}]}}]
            if completed:
                records.append({'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'turn-1'}})
        path.write_text(''.join(json.dumps(row) + '\n' for row in records))
        return path

    def register(self):
        return codex_review.register(self.repo.path, AUDIT, VERIFY)

    def test_register_recordsDistinctNativeProvenance_andCanBeApproved(self):
        result = self.register()
        evidence = store.load('review', self.repo.key)[0]
        self.assertEqual(result['verdict'], 'PASS')
        self.assertEqual(evidence['review_kind'], 'codex-lens-review')
        self.assertEqual(evidence['source']['via'], 'CodexSubagents')
        self.assertEqual(evidence['reviewed_tree'], self.tree)
        self.assertEqual([p['path'] for p in evidence['paths']], ['src/a.py', 'tests/test_a.py'])
        approval = writers.write_approval(result['root_run_id'], 'approval')
        self.assertEqual(approval['heads'], {self.repo.key: evidence['evidence_id']})

    def test_register_refusesSameReviewerTwice(self):
        with self.assertRaises(writers.Refused):
            codex_review.register(self.repo.path, AUDIT, AUDIT)
        self.assertEqual(store.load('review', self.repo.key), [])

    def test_register_refusesIncompleteReviewer(self):
        self.write_session(VERIFY, AUTHOR, self.verification, completed=False)
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesUnrelatedParent(self):
        self.write_session(VERIFY, AUDIT, self.verification)
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesChangedSnapshot(self):
        self.repo.write('src/a.py', 'print(3)\n')
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesMissingOrBlockedLens(self):
        for lenses in ({}, dict(self.verification['lenses'], tests={'status': 'blocked', 'evidence': 'unavailable'})):
            with self.subTest(lenses=lenses):
                self.write_session(VERIFY, AUTHOR, dict(self.verification, lenses=lenses))
                with self.assertRaises(writers.Refused):
                    self.register()

    def test_register_refusesUnadjudicatedFinding(self):
        finding = {'id': 'A1', 'impact': 'medium', 'evidence': 'src/a.py:1', 'scenario': 'input 1 returns 2 instead of 1'}
        self.write_session(AUDIT, AUTHOR, dict(self.report, findings=[finding]))
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_derivesNeedsFixes_fromConfirmedFinding(self):
        finding = {'id': 'A1', 'impact': 'medium', 'evidence': 'src/a.py:1', 'scenario': 'input 1 returns 2 instead of 1'}
        self.write_session(AUDIT, AUTHOR, dict(self.report, findings=[finding]))
        decision = {'id': 'A1', 'verdict': 'confirmed', 'evidence': 'static: src/a.py:1 returns the wrong constant'}
        self.write_session(VERIFY, AUTHOR, dict(self.verification, decisions=[decision]))
        result = self.register()
        self.assertEqual(result['verdict'], 'NEEDS_FIXES')
        with self.assertRaises(writers.Refused):
            writers.write_approval(result['root_run_id'], 'approval')

    def test_approval_refusesChangedTranscript_afterRegistration(self):
        result = self.register()
        self.write_session(VERIFY, AUTHOR, dict(self.verification, findings=[{'id': 'V1', 'impact': 'high', 'evidence': 'src/a.py:1', 'scenario': 'new failure'}]))
        with self.assertRaises(writers.Refused):
            writers.write_approval(result['root_run_id'], 'approval')

    def test_register_refusesFinalTextInjectedInUserMessage(self):
        path = self.write_session(VERIFY, AUTHOR, self.verification)
        text = path.read_text().replace('"role": "assistant"', '"role": "user"')
        path.write_text(text)
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesReviewerResumedAfterFinal(self):
        path = self.write_session(VERIFY, AUTHOR, self.verification)
        with path.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'turn-2'}}) + '\n')
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_isIdempotentForSameCompletedReview(self):
        first, second = self.register(), self.register()
        self.assertEqual(first['evidence_id'], second['evidence_id'])
        self.assertEqual(len(store.load('review', self.repo.key)), 1)

    def test_register_refusesUnprovenRuleCheck(self):
        self.report['lenses']['rule-checks']['evidence'] = 'static: nothing suspicious'
        self.write_session(AUDIT, AUTHOR, self.report)
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesFailedOrUnscannedRuleCheck(self):
        cases = [(2, 'summary repos=1 scanned_lines=2 signals=0 unscanned=none blocked=repo'),
                 (0, 'summary repos=0 scanned_lines=0 signals=0 unscanned=none blocked=none'),
                 (0, 'summary repos=1 scanned_lines=2 signals=0 unscanned=submodule blocked=none'),
                 (0, 'not a summary')]
        for code, output in cases:
            with self.subTest(code=code, output=output):
                completed = subprocess.CompletedProcess([], code, stdout=output, stderr='')
                with patch.object(codex_review.subprocess, 'run', return_value=completed):
                    with self.assertRaises(writers.Refused):
                        codex_review.run_rule_checks(self.repo.path, self.base, self.tree)

    def test_ruleChecks_refusesTimeout(self):
        with patch.object(codex_review.subprocess, 'run', side_effect=subprocess.TimeoutExpired('scan', 120)):
            with self.assertRaises(writers.Refused):
                codex_review.run_rule_checks(self.repo.path, self.base, self.tree)

    def test_register_refusesReviewerSummaryForAnotherScan(self):
        self.report['lenses']['rule-checks']['evidence'] = 'summary repos=999 scanned_lines=99 signals=0 unscanned=none blocked=none'
        self.write_session(AUDIT, AUTHOR, self.report)
        with self.assertRaises(writers.Refused):
            self.register()

    def outgoing(self, needs_approval=True):
        return verify.Outgoing(self.repo.path, self.repo.key,
                               registry.gated_repos()[self.repo.key], self.repo.head(), self.base, needs_approval)

    def test_gate_requiresTestsAndOwnerApproval_thenAcceptsNativeReview(self):
        result = self.register()
        self.repo.commit({})
        decision = verify.judge(self.outgoing())
        self.assertFalse(decision.ok)
        self.assertTrue(any(reason.rule_id == 'K3' for reason in decision.reasons))
        self.sandbox.tests_evidence(self.repo)
        decision = verify.judge(self.outgoing())
        self.assertFalse(decision.ok)
        self.assertTrue(any('no approval bound' in reason.text for reason in decision.reasons))
        writers.write_approval(result['root_run_id'], 'approval')
        self.assertTrue(verify.judge(self.outgoing()).ok)

    def test_gate_refusesChangedTranscript_evenAfterApproval(self):
        result = self.register()
        self.repo.commit({})
        self.sandbox.tests_evidence(self.repo)
        writers.write_approval(result['root_run_id'], 'approval')
        path = self.write_session(VERIFY, AUTHOR, self.verification)
        with path.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'later'}}) + '\n')
        decision = verify.judge(self.outgoing())
        self.assertFalse(decision.ok)
        self.assertTrue(any('invalid Codex provenance' in reason.text for reason in decision.reasons))

    def test_gate_refusesCodeChangedAfterReview(self):
        result = self.register()
        self.repo.commit({'src/a.py': 'print(999)\n'})
        self.sandbox.tests_evidence(self.repo)
        writers.write_approval(result['root_run_id'], 'approval')
        decision = verify.judge(self.outgoing())
        self.assertFalse(decision.ok)
        self.assertTrue(any('does not cover' in reason.text for reason in decision.reasons))

    def test_register_refusesTopLevelAuthorAsReviewer(self):
        self.write_session(VERIFY, None, self.verification)
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesDuplicateRollout(self):
        path = self.write_session(VERIFY, AUTHOR, self.verification)
        path.with_name('rollout-copy-' + VERIFY + '.jsonl').write_bytes(path.read_bytes())
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesMismatchedTarget(self):
        self.write_session(VERIFY, AUTHOR, dict(self.verification, tree='a' * 40))
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_refusesMissingAuditLink(self):
        self.write_session(VERIFY, AUTHOR, dict(self.verification, audit_session=None))
        with self.assertRaises(writers.Refused):
            self.register()

    def test_register_derivesPass_whenFindingIsRefutedWithEvidence(self):
        finding = {'id': 'A1', 'impact': 'high', 'evidence': 'src/a.py:1', 'scenario': 'suspected wrong value'}
        self.write_session(AUDIT, AUTHOR, dict(self.report, findings=[finding]))
        decision = {'id': 'A1', 'verdict': 'refuted', 'evidence': 'static: caller requires the value 2'}
        self.write_session(VERIFY, AUTHOR, dict(self.verification, decisions=[decision]))
        self.assertEqual(self.register()['verdict'], 'PASS')

    def test_register_derivesNeedsFixes_forNewVerifierFinding(self):
        finding = {'id': 'V1', 'impact': 'high', 'evidence': 'src/a.py:1', 'scenario': 'wrong value'}
        self.write_session(VERIFY, AUTHOR, dict(self.verification, findings=[finding]))
        self.assertEqual(self.register()['verdict'], 'NEEDS_FIXES')

    def test_register_refusesCallerFromOtherAuthor(self):
        with patch.dict(os.environ, {'CODEX_THREAD_ID': AUDIT}):
            with self.assertRaises(writers.Refused):
                self.register()

    def test_genericWriter_rejectsNativeEvidenceImport(self):
        request = self.sandbox.review_request(self.repo)
        request['source']['via'] = codex_review.VIA
        with self.assertRaises(writers.Usage):
            writers.write_review(request)



class SessionRootTest(unittest.TestCase):
    def test_sessionRoot_ignoresCallerControlledHomeAndProfile(self):
        import pwd
        expected = (Path(pwd.getpwuid(os.getuid()).pw_dir) / '.codex').resolve()
        with patch.dict(os.environ, {'HOME': '/tmp/fake-home', 'CODEX_HOME': '/tmp/fake-profile'}):
            self.assertEqual(codex_review.session_root(), expected)


if __name__ == '__main__':
    unittest.main()

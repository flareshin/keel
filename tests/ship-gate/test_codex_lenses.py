from __future__ import annotations

import copy
import unittest
import uuid
from unittest.mock import patch

import test_codex_review as legacy
from test_codex_review import AUTHOR, LENSES
from evidence import cli, codex_review, gitcmd, store, verify, writers


class CodexLensesTest(unittest.TestCase):
    write_session = legacy.CodexReviewTest.write_session
    outgoing = legacy.CodexReviewTest.outgoing

    def setUp(self):
        legacy.CodexReviewTest.setUp(self)
        self.audits = []
        self.reports = {}
        for lens in LENSES:
            identity = str(uuid.uuid4())
            report = dict(copy.deepcopy(self.report), version=2,
                          lenses={lens: copy.deepcopy(self.report['lenses'][lens])},
                          since_tree=None, root_run_id=None)
            self.audits.append(identity)
            self.reports[identity] = report
            self.write_session(identity, AUTHOR, report)
        self.verifiers = []

    def register_lenses(self):
        from evidence import codex_lenses
        return codex_lenses.register(self.repo.path, self.audits, self.verifiers)

    def combine_audits(self):
        identity = str(uuid.uuid4())
        report = copy.deepcopy(self.reports[self.audits[0]])
        report['lenses'] = {lens: copy.deepcopy(self.reports[audit]['lenses'][lens])
                            for lens, audit in zip(LENSES, self.audits)}
        self.audits = [identity]
        self.reports[identity] = report
        self.write_session(identity, AUTHOR, report)
        return identity

    def test_lenses_acceptsOneIndependentAuditor_coveringAllLenses(self):
        self.combine_audits()

        result = self.register_lenses()

        self.assertEqual(result['verdict'], 'PASS')
        self.assertEqual(len(store.load('review', self.repo.key)[0]['source']['reviewers']), 1)

    def test_lenses_combinedAuditorStillNeedsEveryLens(self):
        identity = self.combine_audits()
        del self.reports[identity]['lenses']['tests']
        self.write_session(identity, AUTHOR, self.reports[identity])

        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_combinedFindingsNeedLensIdentity(self):
        identity = self.combine_audits()
        self.reports[identity]['findings'] = [{'id': 'A1', 'impact': 'medium',
            'evidence': 'src/a.py:1', 'scenario': 'caller receives wrong constant'}]
        self.write_session(identity, AUTHOR, self.reports[identity])

        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_compatibilityInventoryCountsUnexpiredReadOnlyRecords(self):
        self.assertEqual(cli.compatibility()['read_only_records'], 0)
        legacy.CodexReviewTest.register(self)

        inventory = cli.compatibility()

        self.assertEqual(inventory['read_only_records'], 1)
        self.assertFalse(inventory['reader_removable'])

    def test_lenses_combinedFindingGetsSeparateVerifier(self):
        identity = self.combine_audits()
        self.reports[identity]['findings'] = [{'id': 'contract:A1', 'impact': 'medium',
            'evidence': 'src/a.py:1', 'scenario': 'caller receives wrong constant'}]
        self.write_session(identity, AUTHOR, self.reports[identity])
        verifier = self.add_verifier(identity, 'confirmed')
        self.reports[verifier]['decisions'][0]['id'] = 'contract:A1'
        self.write_session(verifier, AUTHOR, self.reports[verifier])

        self.assertEqual(self.register_lenses()['verdict'], 'NEEDS_FIXES')

    def test_lenses_combinedDeltaSettlesPriorFindingWithLensPrefix(self):
        self.add_verifier(self.add_finding(), 'confirmed')
        previous = self.register_lenses()
        self.start_delta(previous)
        identity = self.combine_audits()
        self.reports[identity]['decisions'] = [{'id': 'contract:A1', 'verdict': 'refuted',
            'evidence': 'src/a.py:1 fixed; caller and regression checked'}]
        self.write_session(identity, AUTHOR, self.reports[identity])

        self.assertEqual(self.register_lenses()['verdict'], 'PASS')

    def test_lenses_retiredRegistrationFlagsCannotCreateEvidence(self):
        self.assertEqual(cli.main(['evidence', 'record-codex', '--repo', self.repo.path,
                                  '--audit', self.audits[0], '--verify', self.audits[1]]), 2)
        self.assertEqual(store.load('review', self.repo.key), [])

    def add_finding(self, lens='contract', impact='medium'):
        identity = self.audits[LENSES.index(lens)]
        finding = {'id': 'A1', 'impact': impact, 'evidence': 'src/a.py:1',
                   'scenario': 'input 1 returns 2 instead of 1'}
        self.reports[identity]['findings'] = [finding]
        self.write_session(identity, AUTHOR, self.reports[identity])
        return identity

    def add_verifier(self, audit_id, verdict='refuted'):
        identity = str(uuid.uuid4())
        report = dict(copy.deepcopy(self.reports[audit_id]), role='verify', lenses={},
                      findings=[], audit_session=audit_id,
                      decisions=[{'id': 'A1', 'verdict': verdict, 'evidence': 'static: src/a.py:1 inspected caller'}])
        self.verifiers.append(identity)
        self.reports[identity] = report
        self.write_session(identity, AUTHOR, report)
        return identity

    def test_lenses_registersFiveCleanAudits_withoutVerifiers(self):
        result = self.register_lenses()
        self.assertEqual(result['verdict'], 'PASS')
        evidence = store.load('review', self.repo.key)[0]
        codex_review.validate_evidence(evidence)
        self.assertEqual(len(evidence['source']['reviewers']), 5)
        writers.write_approval(result['root_run_id'], 'approval')

    def test_lenses_refusesAuthorAsReviewer(self):
        self.write_session(self.audits[0], self.audits[0], self.reports[self.audits[0]])
        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_refusesMissingDuplicateOrBlockedLens(self):
        original = self.audits[:]
        for candidate in (original[:-1], original + [original[0]]):
            self.audits = candidate
            with self.assertRaises(writers.Refused):
                self.register_lenses()
        self.audits = original
        identity = self.audits[0]
        self.reports[identity]['lenses'][LENSES[0]]['status'] = 'blocked'
        self.write_session(identity, AUTHOR, self.reports[identity])
        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_refusesFindingWithoutVerification(self):
        self.add_finding()
        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_batchesFindingDecisions_inOneVerifier(self):
        audit = self.add_finding()
        second = dict(self.reports[audit]['findings'][0], id='A2')
        self.reports[audit]['findings'].append(second)
        self.write_session(audit, AUTHOR, self.reports[audit])
        verifier = self.add_verifier(audit)
        self.reports[verifier]['decisions'].append(dict(self.reports[verifier]['decisions'][0], id='A2'))
        self.write_session(verifier, AUTHOR, self.reports[verifier])
        self.assertEqual(self.register_lenses()['verdict'], 'PASS')

    def test_lenses_preservesConfirmedFailure_andRefusesApproval(self):
        self.add_verifier(self.add_finding(), 'confirmed')
        result = self.register_lenses()
        self.assertEqual(result['verdict'], 'NEEDS_FIXES')
        with self.assertRaises(writers.Refused):
            writers.write_approval(result['root_run_id'], 'approval')

    def test_lenses_refusesVerifierThatRepeatsFullReview(self):
        verifier = self.add_verifier(self.add_finding())
        self.reports[verifier]['lenses'] = copy.deepcopy(self.report['lenses'])
        self.write_session(verifier, AUTHOR, self.reports[verifier])
        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_refusesIncompleteOrExtraVerifier(self):
        audit = self.add_finding()
        verifier = self.add_verifier(audit)
        self.reports[verifier]['decisions'] = []
        self.write_session(verifier, AUTHOR, self.reports[verifier])
        with self.assertRaises(writers.Refused):
            self.register_lenses()
        self.reports[audit]['findings'] = []
        self.write_session(audit, AUTHOR, self.reports[audit])
        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_refusesChangedTranscript_afterRegistration(self):
        result = self.register_lenses()
        self.reports[self.audits[0]]['findings'] = [{'id': 'new', 'impact': 'high',
            'evidence': 'src/a.py:1', 'scenario': 'new fault'}]
        self.write_session(self.audits[0], AUTHOR, self.reports[self.audits[0]])
        with self.assertRaises(writers.Refused):
            writers.write_approval(result['root_run_id'], 'approval')

    def test_lenses_refusesChangedCandidate_orDifferentAuthor(self):
        with patch.dict('os.environ', {'CODEX_THREAD_ID': self.audits[0]}):
            with self.assertRaises(writers.Refused):
                self.register_lenses()
        self.repo.write('src/a.py', 'print(999)\n')
        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_registrationIsIdempotent_forSameCompletedChildren(self):
        first = self.register_lenses()
        second = self.register_lenses()
        self.assertEqual(first['evidence_id'], second['evidence_id'])
        self.assertEqual(len(store.load('review', self.repo.key)), 1)

    def test_lenses_newVerifierCannotReuseEarlierPassRecord(self):
        audit = self.add_finding()
        self.add_verifier(audit)
        first = self.register_lenses()
        self.verifiers = []
        self.add_verifier(audit, 'confirmed')

        second = self.register_lenses()

        self.assertNotEqual(first['evidence_id'], second['evidence_id'])
        self.assertEqual(second['verdict'], 'NEEDS_FIXES')
        with self.assertRaises(writers.Refused):
            writers.write_approval(second['root_run_id'], 'approval')

    def test_lenses_refusesUnprovenRuleCheck(self):
        audit = self.audits[LENSES.index('rule-checks')]
        self.reports[audit]['lenses']['rule-checks']['evidence'] = 'looks clean'
        self.write_session(audit, AUTHOR, self.reports[audit])
        with self.assertRaises(writers.Refused):
            self.register_lenses()

    def test_lenses_requiresTestsAndApproval_atGate(self):
        result = self.register_lenses()
        self.repo.commit({})
        self.assertFalse(verify.judge(self.outgoing()).ok)
        self.sandbox.tests_evidence(self.repo)
        self.assertFalse(verify.judge(self.outgoing()).ok)
        writers.write_approval(result['root_run_id'], 'approval')
        self.assertTrue(verify.judge(self.outgoing()).ok)

    def test_lenses_cliAcceptsAudits_withoutVerificationForCleanReview(self):
        with patch.object(cli, '_print') as output:
            rc = cli.main(['evidence', 'record-codex', '--repo', self.repo.path,
                           '--audits', ','.join(self.audits)])
        self.assertEqual(rc, 0)
        self.assertEqual(output.call_args.args[0]['verdict'], 'PASS')

    def start_delta(self, previous, value=3):
        old_tree = self.tree
        self.repo.write('src/a.py', f'print({value})\n')
        self.tree = gitcmd.snapshot_tree(self.repo.path)
        self.audits, self.verifiers = [], []
        for lens in LENSES:
            identity = str(uuid.uuid4())
            report = dict(copy.deepcopy(self.report), version=2, tree=self.tree,
                          lenses={lens: copy.deepcopy(self.report['lenses'][lens])},
                          since_tree=old_tree, root_run_id=previous['root_run_id'])
            if lens == 'rule-checks':
                report['lenses'][lens]['evidence'] = codex_review.run_rule_checks(self.repo.path, self.base, self.tree)
            self.audits.append(identity)
            self.reports[identity] = report
            self.write_session(identity, AUTHOR, report)

    def test_lenses_deltaLinksPriorPass_andReviewsOnlyChangedPaths(self):
        previous = self.register_lenses()
        self.start_delta(previous)
        result = self.register_lenses()
        self.assertEqual(result['root_run_id'], previous['root_run_id'])
        head = writers.chain_heads(previous['root_run_id'])[self.repo.key]
        self.assertEqual(head['since'], previous['evidence_id'])
        self.assertEqual([item['path'] for item in head['paths']], ['src/a.py'])
        codex_review.validate_evidence(head)

    def test_lenses_deltaRollbackUsesExactHistoricalParent(self):
        root = self.register_lenses()
        self.start_delta(root)
        middle = self.register_lenses()
        self.start_delta(middle, value=2)

        final = self.register_lenses()

        writers.write_approval(final['root_run_id'], 'approval')
        head = writers.chain_heads(root['root_run_id'])[self.repo.key]
        self.assertEqual(head['since'], middle['evidence_id'])
        codex_review.validate_evidence(head)
        self.assertEqual(self.register_lenses()['evidence_id'], final['evidence_id'])

    def test_lenses_deltaRequiresEvidenceForEveryPriorBlockingFinding(self):
        self.add_verifier(self.add_finding(), 'confirmed')
        previous = self.register_lenses()
        self.start_delta(previous)
        with self.assertRaises(writers.Refused):
            self.register_lenses()
        audit = self.audits[LENSES.index('contract')]
        self.reports[audit]['decisions'] = [{'id': 'A1', 'verdict': 'refuted',
            'evidence': 'src/a.py:1 now returns 3; regression test covers input'}]
        self.write_session(audit, AUTHOR, self.reports[audit])
        self.assertEqual(self.register_lenses()['verdict'], 'PASS')

    def test_lenses_deltaCannotClearUnresolvedPriorFinding(self):
        self.add_verifier(self.add_finding(), 'confirmed')
        previous = self.register_lenses()
        self.start_delta(previous)
        audit = self.audits[LENSES.index('contract')]
        self.reports[audit]['decisions'] = [{'id': 'A1', 'verdict': 'confirmed',
            'evidence': 'src/a.py:1 still violates caller contract'}]
        self.write_session(audit, AUTHOR, self.reports[audit])
        self.assertEqual(self.register_lenses()['verdict'], 'NEEDS_FIXES')

    def test_lenses_deltaPreservesFindingsAcrossMultipleFixes(self):
        self.add_verifier(self.add_finding(), 'confirmed')
        root = self.register_lenses()
        self.start_delta(root)
        audit = self.audits[LENSES.index('contract')]
        self.reports[audit]['decisions'] = [{'id': 'A1', 'verdict': 'confirmed',
            'evidence': 'src/a.py:1 still violates contract'}]
        self.write_session(audit, AUTHOR, self.reports[audit])
        middle = self.register_lenses()
        self.start_delta(middle, value=4)
        with self.assertRaises(writers.Refused):
            self.register_lenses()
        audit = self.audits[LENSES.index('contract')]
        self.reports[audit]['decisions'] = [{'id': 'A1', 'verdict': 'refuted',
            'evidence': 'src/a.py:1 fixed and caller checked'}]
        self.write_session(audit, AUTHOR, self.reports[audit])
        final = self.register_lenses()
        self.assertEqual(final['verdict'], 'PASS')
        self.assertEqual(final['root_run_id'], root['root_run_id'])
        writers.write_approval(final['root_run_id'], 'approval')

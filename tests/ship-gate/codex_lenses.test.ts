import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import * as cli from '../../lib/evidence/cli.ts';
import * as codexLenses from '../../lib/evidence/codex_lenses.ts';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import * as store from '../../lib/evidence/store.ts';
import * as verify from '../../lib/evidence/verify.ts';
import * as writers from '../../lib/evidence/writers.ts';
import { AUTHOR, CodexFixture, LENSES } from './codex_helpers.ts';

const refused = writers.Refused;

class LensFixture extends CodexFixture {
  audits: string[] = [];
  verifiers: string[] = [];
  reports: Record<string, any> = {};

  constructor(t: TestContext) {
    super(t);
    for (const lens of LENSES) {
      const identity = randomUUID();
      const report = {
        ...structuredClone(this.report), version: 2, lenses: { [lens]: structuredClone(this.report.lenses[lens]) },
        since_tree: null, root_run_id: null,
      };
      this.audits.push(identity);
      this.reports[identity] = report;
      this.writeSession(identity, AUTHOR, report);
    }
  }

  registerLenses(): any {
    return codexLenses.register(this.repo.path, this.audits, this.verifiers);
  }

  combineAudits(): string {
    const identity = randomUUID();
    const report = structuredClone(this.reports[this.audits[0]!]);
    report.lenses = Object.fromEntries(LENSES.map((lens, index) => [lens, structuredClone(this.reports[this.audits[index]!].lenses[lens])]));
    this.audits = [identity];
    this.reports[identity] = report;
    this.writeSession(identity, AUTHOR, report);
    return identity;
  }

  addFinding(lens = 'contract', impact = 'medium'): string {
    const identity = this.audits[LENSES.indexOf(lens)]!;
    this.reports[identity].findings = [{ id: 'A1', impact, evidence: 'src/a.py:1', scenario: 'input 1 returns 2 instead of 1' }];
    this.writeSession(identity, AUTHOR, this.reports[identity]);
    return identity;
  }

  addVerifier(auditId: string, verdict = 'refuted'): string {
    const identity = randomUUID();
    const report = {
      ...structuredClone(this.reports[auditId]), role: 'verify', lenses: {}, findings: [], audit_session: auditId,
      decisions: [{ id: 'A1', verdict, evidence: 'static: src/a.py:1 inspected caller' }],
    };
    this.verifiers.push(identity);
    this.reports[identity] = report;
    this.writeSession(identity, AUTHOR, report);
    return identity;
  }

  startDelta(previous: { root_run_id: string }, value = 3): void {
    const oldTree = this.tree;
    this.repo.write('src/a.py', `print(${value})\n`);
    this.tree = gitcmd.snapshotTree(this.repo.path);
    this.audits = [];
    this.verifiers = [];
    for (const lens of LENSES) {
      const identity = randomUUID();
      const report = {
        ...structuredClone(this.report), version: 2, tree: this.tree, lenses: { [lens]: structuredClone(this.report.lenses[lens]) },
        since_tree: oldTree, root_run_id: previous.root_run_id,
      };
      if (lens === 'rule-checks') report.lenses[lens].evidence = codexReview.runRuleChecks(this.repo.path, this.base, this.tree);
      this.audits.push(identity);
      this.reports[identity] = report;
      this.writeSession(identity, AUTHOR, report);
    }
  }

  rewrite(identity: string): void {
    this.writeSession(identity, AUTHOR, this.reports[identity]);
  }
}

describe('CodexLensesTest', () => {
  test('lenses_preservesTestsAuditorReason_throughRegistrationAndGate', (t) => {
    const f = new LensFixture(t);
    unlinkSync(join(f.repo.path, 'tests/test_a.py'));
    f.tree = gitcmd.snapshotTree(f.repo.path);
    for (const identity of f.audits) {
      f.reports[identity].tree = f.tree;
      if (f.reports[identity].lenses['rule-checks']) {
        f.reports[identity].lenses['rule-checks'].evidence = codexReview.runRuleChecks(f.repo.path, f.base, f.tree);
      }
      f.rewrite(identity);
    }
    const audit = f.audits[LENSES.indexOf('tests')]!;
    const reason = 'Static contract reviewed; this fixture intentionally has no changed test path.';
    f.reports[audit].no_test_reason = reason;
    f.rewrite(audit);
    const registered = f.registerLenses();
    const evidence = store.loadReviews(f.repo.key)[0]!;
    assert.equal(evidence.no_test_reason, reason);
    codexReview.validateEvidence(evidence);
    f.repo.commit({});
    f.sandbox.testsEvidence(f.repo);
    assert.equal(verify.judge(f.outgoing()).ok, false);
    writers.writeApproval(registered.root_run_id, 'approval');
    assert.equal(verify.judge(f.outgoing()).ok, true);
    assert.throws(() => codexReview.validateEvidence({ ...evidence, no_test_reason: 'substituted' }), refused);
  });

  test('lenses_acceptsOneIndependentAuditor_coveringAllLenses', (t) => {
    const f = new LensFixture(t);
    f.combineAudits();
    const registered = f.registerLenses();
    assert.equal(registered.verdict, 'PASS');
    assert.equal(store.loadReviews(f.repo.key)[0]!.source['reviewers'].length, 1);
    assert.equal(store.loadReviews(f.repo.key)[0]!.no_test_reason, null);
  });

  test('lenses_acceptsCombinedTestsAuditorReason', (t) => {
    const f = new LensFixture(t);
    const audit = f.combineAudits();
    f.reports[audit].no_test_reason = 'Only prose changed; the documented contract was inspected.';
    f.rewrite(audit);
    f.registerLenses();
    assert.equal(store.loadReviews(f.repo.key)[0]!.no_test_reason, f.reports[audit].no_test_reason);
  });

  for (const reason of [null, '', '  ', 1, {}]) {
    test(`lenses_refusesInvalidTestReason_${JSON.stringify(reason)}`, (t) => {
      const f = new LensFixture(t);
      const audit = f.audits[LENSES.indexOf('tests')]!;
      f.reports[audit].no_test_reason = reason;
      f.rewrite(audit);
      assert.throws(() => f.registerLenses(), /no_test_reason must be a nonblank reason from the tests auditor/);
    });
  }

  test('lenses_refusesReasonFromAnotherLensOrVerifier', (t) => {
    const f = new LensFixture(t);
    const audit = f.audits[0]!;
    f.reports[audit].no_test_reason = 'Not supplied by the tests auditor.';
    f.rewrite(audit);
    assert.throws(() => f.registerLenses(), /no_test_reason must be a nonblank reason from the tests auditor/);
    delete f.reports[audit].no_test_reason;
    f.rewrite(audit);
    const verifier = f.addVerifier(f.addFinding());
    f.reports[verifier].no_test_reason = 'A verifier cannot waive changed tests.';
    f.rewrite(verifier);
    assert.throws(() => f.registerLenses(), /no_test_reason must be a nonblank reason from the tests auditor/);
  });

  test('lenses_deltaDoesNotInheritTestReason', (t) => {
    const f = new LensFixture(t);
    const audit = f.audits[LENSES.indexOf('tests')]!;
    f.reports[audit].no_test_reason = 'Reason applies only to the first candidate.';
    f.rewrite(audit);
    const previous = f.registerLenses();
    f.startDelta(previous);
    f.registerLenses();
    assert.equal(writers.chainHeads(previous.root_run_id).get(f.repo.key)!.no_test_reason, null);
  });

  test('lenses_combinedAuditorStillNeedsEveryLens', (t) => {
    const f = new LensFixture(t);
    const identity = f.combineAudits();
    delete f.reports[identity].lenses.tests;
    f.rewrite(identity);
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_combinedFindingsNeedLensIdentity', (t) => {
    const f = new LensFixture(t);
    const identity = f.combineAudits();
    f.reports[identity].findings = [{ id: 'A1', impact: 'medium', evidence: 'src/a.py:1', scenario: 'caller receives wrong constant' }];
    f.rewrite(identity);
    assert.throws(() => f.registerLenses(), refused);
  });

  test('compatibilityInventoryCountsUnexpiredReadOnlyRecords', (t) => {
    const f = new LensFixture(t);
    assert.equal(cli.compatibility()['read_only_records'], 0);
    f.register();
    const inventory = cli.compatibility();
    assert.equal(inventory['read_only_records'], 1);
    assert.equal(inventory['reader_removable'], false);
  });

  test('lenses_combinedFindingGetsSeparateVerifier', (t) => {
    const f = new LensFixture(t);
    const identity = f.combineAudits();
    f.reports[identity].findings = [{ id: 'contract:A1', impact: 'medium', evidence: 'src/a.py:1', scenario: 'caller receives wrong constant' }];
    f.rewrite(identity);
    const verifier = f.addVerifier(identity, 'confirmed');
    f.reports[verifier].decisions[0].id = 'contract:A1';
    f.rewrite(verifier);
    assert.equal(f.registerLenses().verdict, 'NEEDS_FIXES');
  });

  test('lenses_combinedDeltaSettlesPriorFindingWithLensPrefix', (t) => {
    const f = new LensFixture(t);
    f.addVerifier(f.addFinding(), 'confirmed');
    const previous = f.registerLenses();
    f.startDelta(previous);
    const identity = f.combineAudits();
    f.reports[identity].decisions = [{ id: 'contract:A1', verdict: 'refuted', evidence: 'src/a.py:1 fixed; caller and regression checked' }];
    f.rewrite(identity);
    assert.equal(f.registerLenses().verdict, 'PASS');
  });

  test('lenses_retiredRegistrationFlagsCannotCreateEvidence', async (t) => {
    const f = new LensFixture(t);
    const status = await cli.main(['evidence', 'record-codex', '--repo', f.repo.path, '--audit', f.audits[0]!, '--verify', f.audits[1]!]);
    assert.equal(status, 2);
    assert.deepEqual(store.loadReviews(f.repo.key), []);
  });

  test('lenses_registersFiveCleanAudits_withoutVerifiers', (t) => {
    const f = new LensFixture(t);
    const registered = f.registerLenses();
    assert.equal(registered.verdict, 'PASS');
    const evidence = store.loadReviews(f.repo.key)[0]!;
    codexReview.validateEvidence(evidence);
    assert.equal(evidence.source['reviewers'].length, 5);
    writers.writeApproval(registered.root_run_id, 'approval');
  });

  test('lenses_refusesAuthorAsReviewer', (t) => {
    const f = new LensFixture(t);
    f.writeSession(f.audits[0]!, f.audits[0]!, f.reports[f.audits[0]!]);
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_refusesMissingDuplicateOrBlockedLens', (t) => {
    const f = new LensFixture(t);
    const original = f.audits.slice();
    for (const candidate of [original.slice(0, -1), [...original, original[0]!]]) {
      f.audits = candidate;
      assert.throws(() => f.registerLenses(), refused);
    }
    f.audits = original;
    const identity = f.audits[0]!;
    f.reports[identity].lenses[LENSES[0]!].status = 'blocked';
    f.rewrite(identity);
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_refusesFindingWithoutVerification', (t) => {
    const f = new LensFixture(t);
    f.addFinding();
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_batchesFindingDecisions_inOneVerifier', (t) => {
    const f = new LensFixture(t);
    const audit = f.addFinding();
    f.reports[audit].findings.push({ ...f.reports[audit].findings[0], id: 'A2' });
    f.rewrite(audit);
    const verifier = f.addVerifier(audit);
    f.reports[verifier].decisions.push({ ...f.reports[verifier].decisions[0], id: 'A2' });
    f.rewrite(verifier);
    assert.equal(f.registerLenses().verdict, 'PASS');
  });

  test('lenses_preservesConfirmedFailure_andRefusesApproval', (t) => {
    const f = new LensFixture(t);
    f.addVerifier(f.addFinding(), 'confirmed');
    const registered = f.registerLenses();
    assert.equal(registered.verdict, 'NEEDS_FIXES');
    assert.throws(() => writers.writeApproval(registered.root_run_id, 'approval'), refused);
  });

  test('lenses_refusesVerifierThatRepeatsFullReview', (t) => {
    const f = new LensFixture(t);
    const verifier = f.addVerifier(f.addFinding());
    f.reports[verifier].lenses = structuredClone(f.report.lenses);
    f.rewrite(verifier);
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_refusesIncompleteOrExtraVerifier', (t) => {
    const f = new LensFixture(t);
    const audit = f.addFinding();
    const verifier = f.addVerifier(audit);
    f.reports[verifier].decisions = [];
    f.rewrite(verifier);
    assert.throws(() => f.registerLenses(), refused);
    f.reports[audit].findings = [];
    f.rewrite(audit);
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_refusesChangedTranscript_afterRegistration', (t) => {
    const f = new LensFixture(t);
    const registered = f.registerLenses();
    f.reports[f.audits[0]!].findings = [{ id: 'new', impact: 'high', evidence: 'src/a.py:1', scenario: 'new fault' }];
    f.rewrite(f.audits[0]!);
    assert.throws(() => writers.writeApproval(registered.root_run_id, 'approval'), refused);
  });

  test('lenses_refusesChangedCandidate_orDifferentAuthor', (t) => {
    const f = new LensFixture(t);
    process.env['CODEX_THREAD_ID'] = f.audits[0]!;
    assert.throws(() => f.registerLenses(), refused);
    process.env['CODEX_THREAD_ID'] = AUTHOR;
    f.repo.write('src/a.py', 'print(999)\n');
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_registrationIsIdempotent_forSameCompletedChildren', (t) => {
    const f = new LensFixture(t);
    const first = f.registerLenses();
    const second = f.registerLenses();
    assert.equal(first.evidence_id, second.evidence_id);
    assert.equal(store.loadReviews(f.repo.key).length, 1);
  });

  test('lenses_newVerifierCannotReuseEarlierPassRecord', (t) => {
    const f = new LensFixture(t);
    const audit = f.addFinding();
    f.addVerifier(audit);
    const first = f.registerLenses();
    f.verifiers = [];
    f.addVerifier(audit, 'confirmed');

    const second = f.registerLenses();

    assert.notEqual(first.evidence_id, second.evidence_id);
    assert.equal(second.verdict, 'NEEDS_FIXES');
    assert.throws(() => writers.writeApproval(second.root_run_id, 'approval'), refused);
  });

  test('lenses_refusesUnprovenRuleCheck', (t) => {
    const f = new LensFixture(t);
    const audit = f.audits[LENSES.indexOf('rule-checks')]!;
    f.reports[audit].lenses['rule-checks'].evidence = 'looks clean';
    f.rewrite(audit);
    assert.throws(() => f.registerLenses(), refused);
  });

  test('lenses_requiresTestsAndApproval_atGate', (t) => {
    const f = new LensFixture(t);
    const registered = f.registerLenses();
    f.repo.commit({});
    assert.equal(verify.judge(f.outgoing()).ok, false);
    f.sandbox.testsEvidence(f.repo);
    assert.equal(verify.judge(f.outgoing()).ok, false);
    writers.writeApproval(registered.root_run_id, 'approval');
    assert.equal(verify.judge(f.outgoing()).ok, true);
  });

  test('lenses_cliAcceptsAudits_withoutVerificationForCleanReview', async (t) => {
    const f = new LensFixture(t);
    const output = t.mock.method(cli.seams, 'print', () => undefined);
    const status = await cli.main(['evidence', 'record-codex', '--repo', f.repo.path, '--audits', f.audits.join(',')]);
    assert.equal(status, 0);
    assert.equal((output.mock.calls[0]!.arguments[0] as any).verdict, 'PASS');
  });

  test('lenses_deltaLinksPriorPass_andReviewsOnlyChangedPaths', (t) => {
    const f = new LensFixture(t);
    const previous = f.registerLenses();
    f.startDelta(previous);
    const registered = f.registerLenses();
    assert.equal(registered.root_run_id, previous.root_run_id);
    const head = writers.chainHeads(previous.root_run_id).get(f.repo.key)!;
    assert.equal(head.since, previous.evidence_id);
    assert.deepEqual(head.paths.map((item) => item.path), ['src/a.py']);
    codexReview.validateEvidence(head);
  });

  test('lenses_deltaRollbackUsesExactHistoricalParent', (t) => {
    const f = new LensFixture(t);
    const root = f.registerLenses();
    f.startDelta(root);
    const middle = f.registerLenses();
    f.startDelta(middle, 2);

    const final = f.registerLenses();

    writers.writeApproval(final.root_run_id, 'approval');
    const head = writers.chainHeads(root.root_run_id).get(f.repo.key)!;
    assert.equal(head.since, middle.evidence_id);
    codexReview.validateEvidence(head);
    assert.equal(f.registerLenses().evidence_id, final.evidence_id);
  });

  test('lenses_deltaRequiresEvidenceForEveryPriorBlockingFinding', (t) => {
    const f = new LensFixture(t);
    f.addVerifier(f.addFinding(), 'confirmed');
    const previous = f.registerLenses();
    f.startDelta(previous);
    assert.throws(() => f.registerLenses(), refused);
    const audit = f.audits[LENSES.indexOf('contract')]!;
    f.reports[audit].decisions = [{ id: 'A1', verdict: 'refuted', evidence: 'src/a.py:1 now returns 3; regression test covers input' }];
    f.rewrite(audit);
    assert.equal(f.registerLenses().verdict, 'PASS');
  });

  test('lenses_deltaCannotClearUnresolvedPriorFinding', (t) => {
    const f = new LensFixture(t);
    f.addVerifier(f.addFinding(), 'confirmed');
    const previous = f.registerLenses();
    f.startDelta(previous);
    const audit = f.audits[LENSES.indexOf('contract')]!;
    f.reports[audit].decisions = [{ id: 'A1', verdict: 'confirmed', evidence: 'src/a.py:1 still violates caller contract' }];
    f.rewrite(audit);
    assert.equal(f.registerLenses().verdict, 'NEEDS_FIXES');
  });

  test('lenses_deltaPreservesFindingsAcrossMultipleFixes', (t) => {
    const f = new LensFixture(t);
    f.addVerifier(f.addFinding(), 'confirmed');
    const root = f.registerLenses();
    f.startDelta(root);
    let audit = f.audits[LENSES.indexOf('contract')]!;
    f.reports[audit].decisions = [{ id: 'A1', verdict: 'confirmed', evidence: 'src/a.py:1 still violates contract' }];
    f.rewrite(audit);
    const middle = f.registerLenses();
    f.startDelta(middle, 4);
    assert.throws(() => f.registerLenses(), refused);
    audit = f.audits[LENSES.indexOf('contract')]!;
    f.reports[audit].decisions = [{ id: 'A1', verdict: 'refuted', evidence: 'src/a.py:1 fixed and caller checked' }];
    f.rewrite(audit);
    const final = f.registerLenses();
    assert.equal(final.verdict, 'PASS');
    assert.equal(final.root_run_id, root.root_run_id);
    writers.writeApproval(final.root_run_id, 'approval');
  });
});

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import * as store from '../../lib/evidence/store.ts';
import * as verify from '../../lib/evidence/verify.ts';
import * as writers from '../../lib/evidence/writers.ts';
import { AUDIT, AUTHOR, CodexFixture, VERIFY } from './codex_helpers.ts';

const refused = writers.Refused;
const FINDING = { id: 'A1', impact: 'medium', evidence: 'src/a.py:1', scenario: 'input 1 returns 2 instead of 1' };

describe('CodexReviewTest', () => {
  test('reader_recordsDistinctNativeProvenance_andCanBeApproved', (t) => {
    const f = new CodexFixture(t);
    const registered = f.register();
    const evidence = store.loadReviews(f.repo.key)[0]!;
    assert.equal(registered.verdict, 'PASS');
    assert.equal(evidence.review_kind, 'codex-lens-review');
    assert.equal(evidence.source['via'], 'CodexSubagents');
    assert.equal(evidence.reviewed_tree, f.tree);
    assert.deepEqual(evidence.paths.map((entry) => entry.path), ['src/a.py', 'tests/test_a.py']);
    const approval = writers.writeApproval(registered.root_run_id, 'approval');
    assert.deepEqual(approval['heads'], { [f.repo.key]: evidence.evidence_id });
  });

  test('retiredWriter_isUnavailable', () => {
    assert.ok(!('register' in codexReview));
  });

  test('reader_refusesIncompleteReviewer', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(VERIFY, AUTHOR, f.verification, false);
    assert.throws(() => f.register(), refused);
  });

  test('reader_refusesUnrelatedParent', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(VERIFY, AUDIT, f.verification);
    assert.throws(() => f.register(), refused);
  });

  test('reader_acceptsHistoricalEvidence_afterWorkingTreeChanges', (t) => {
    const f = new CodexFixture(t);
    const registered = f.register();
    f.repo.write('src/a.py', 'print(3)\n');
    codexReview.validateEvidence(store.loadReviews(f.repo.key)[0]!);
    assert.equal(registered.verdict, 'PASS');
  });

  test('reader_refusesMissingOrBlockedLens', (t) => {
    const f = new CodexFixture(t);
    const blocked = { ...f.verification.lenses, tests: { status: 'blocked', evidence: 'unavailable' } };
    for (const lenses of [{}, blocked]) {
      f.writeSession(VERIFY, AUTHOR, { ...f.verification, lenses });
      assert.throws(() => f.register(), refused);
    }
  });

  test('reader_refusesUnadjudicatedFinding', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(AUDIT, AUTHOR, { ...f.report, findings: [FINDING] });
    assert.throws(() => f.register(), refused);
  });

  test('reader_derivesNeedsFixes_fromConfirmedFinding', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(AUDIT, AUTHOR, { ...f.report, findings: [FINDING] });
    const decision = { id: 'A1', verdict: 'confirmed', evidence: 'static: src/a.py:1 returns the wrong constant' };
    f.writeSession(VERIFY, AUTHOR, { ...f.verification, decisions: [decision] });
    const registered = f.register();
    assert.equal(registered.verdict, 'NEEDS_FIXES');
    assert.throws(() => writers.writeApproval(registered.root_run_id, 'approval'), refused);
  });

  test('approval_refusesChangedTranscript_afterRegistration', (t) => {
    const f = new CodexFixture(t);
    const registered = f.register();
    const finding = { id: 'V1', impact: 'high', evidence: 'src/a.py:1', scenario: 'new failure' };
    f.writeSession(VERIFY, AUTHOR, { ...f.verification, findings: [finding] });
    assert.throws(() => writers.writeApproval(registered.root_run_id, 'approval'), refused);
  });

  test('reader_refusesFinalTextInjectedInUserMessage', (t) => {
    const f = new CodexFixture(t);
    const path = f.writeSession(VERIFY, AUTHOR, f.verification);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"role":"assistant"', '"role":"user"'));
    assert.throws(() => f.register(), refused);
  });

  test('reader_refusesReviewerResumedAfterFinal', (t) => {
    const f = new CodexFixture(t);
    const path = f.writeSession(VERIFY, AUTHOR, f.verification);
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }) + '\n');
    assert.throws(() => f.register(), refused);
  });

  test('reader_isIdempotentForSameCompletedReview', (t) => {
    const f = new CodexFixture(t);
    const first = f.register();
    const second = f.register();
    assert.equal(first.evidence_id, second.evidence_id);
    assert.equal(store.loadReviews(f.repo.key).length, 1);
  });

  test('reader_refusesUnprovenRuleCheck', (t) => {
    const f = new CodexFixture(t);
    f.report.lenses['rule-checks'].evidence = 'static: nothing suspicious';
    f.writeSession(AUDIT, AUTHOR, f.report);
    assert.throws(() => f.register(), refused);
  });

  test('reader_refusesFailedOrUnscannedRuleCheck', (t) => {
    const f = new CodexFixture(t);
    const cases: Array<[number, string]> = [
      [2, 'summary repos=1 scanned_lines=2 signals=0 unscanned=none blocked=repo'],
      [0, 'summary repos=0 scanned_lines=0 signals=0 unscanned=none blocked=none'],
      [0, 'summary repos=1 scanned_lines=2 signals=0 unscanned=submodule blocked=none'],
      [0, 'not a summary'],
    ];
    for (const [code, output] of cases) {
      const completed = { status: code, signal: null, stdout: Buffer.from(output), stderr: Buffer.alloc(0), pid: 1, output: [] };
      const spawn = t.mock.method(childProcess, 'spawnSync', () => completed);
      assert.throws(() => codexReview.runRuleChecks(f.repo.path, f.base, f.tree), refused, `${code} ${output}`);
      spawn.mock.restore();
    }
  });

  test('ruleChecks_refusesTimeout', (t) => {
    const f = new CodexFixture(t);
    const timedOut = { error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: null };
    t.mock.method(childProcess, 'spawnSync', () => timedOut);
    assert.throws(() => codexReview.runRuleChecks(f.repo.path, f.base, f.tree), refused);
  });

  test('reader_refusesReviewerSummaryForAnotherScan', (t) => {
    const f = new CodexFixture(t);
    f.report.lenses['rule-checks'].evidence = 'summary repos=999 scanned_lines=99 signals=0 unscanned=none blocked=none';
    f.writeSession(AUDIT, AUTHOR, f.report);
    assert.throws(() => f.register(), refused);
  });

  test('gate_requiresTestsAndOwnerApproval_thenAcceptsNativeReview', (t) => {
    const f = new CodexFixture(t);
    const registered = f.register();
    f.repo.commit({});
    let decision = verify.judge(f.outgoing());
    assert.equal(decision.ok, false);
    assert.ok(decision.reasons.some((reason) => reason.ruleId === 'K3'));
    f.sandbox.testsEvidence(f.repo);
    decision = verify.judge(f.outgoing());
    assert.equal(decision.ok, false);
    assert.ok(decision.reasons.some((reason) => reason.text.includes('no approval bound')));
    writers.writeApproval(registered.root_run_id, 'approval');
    assert.equal(verify.judge(f.outgoing()).ok, true);
  });

  test('gate_refusesChangedTranscript_evenAfterApproval', (t) => {
    const f = new CodexFixture(t);
    const registered = f.register();
    f.repo.commit({});
    f.sandbox.testsEvidence(f.repo);
    writers.writeApproval(registered.root_run_id, 'approval');
    const path = f.writeSession(VERIFY, AUTHOR, f.verification);
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } }) + '\n');
    const decision = verify.judge(f.outgoing());
    assert.equal(decision.ok, false);
    assert.ok(decision.reasons.some((reason) => reason.text.includes('invalid Codex provenance')));
  });

  test('gate_refusesCodeChangedAfterReview', (t) => {
    const f = new CodexFixture(t);
    const registered = f.register();
    f.repo.commit({ 'src/a.py': 'print(999)\n' });
    f.sandbox.testsEvidence(f.repo);
    writers.writeApproval(registered.root_run_id, 'approval');
    const decision = verify.judge(f.outgoing());
    assert.equal(decision.ok, false);
    assert.ok(decision.reasons.some((reason) => reason.text.includes('does not cover')));
  });

  test('reader_refusesTopLevelAuthorAsReviewer', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(VERIFY, null, f.verification);
    assert.throws(() => f.register(), refused);
  });

  test('reader_refusesDuplicateRollout', (t) => {
    const f = new CodexFixture(t);
    const path = f.writeSession(VERIFY, AUTHOR, f.verification);
    copyFileSync(path, join(dirname(path), `rollout-copy-${VERIFY}.jsonl`));
    assert.throws(() => f.register(), refused);
    assert.ok(basename(path).includes(VERIFY));
  });

  test('reader_refusesMismatchedTarget', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(VERIFY, AUTHOR, { ...f.verification, tree: 'a'.repeat(40) });
    assert.throws(() => f.register(), refused);
  });

  test('reader_refusesMissingAuditLink', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(VERIFY, AUTHOR, { ...f.verification, audit_session: null });
    assert.throws(() => f.register(), refused);
  });

  test('reader_derivesPass_whenFindingIsRefutedWithEvidence', (t) => {
    const f = new CodexFixture(t);
    const finding = { id: 'A1', impact: 'high', evidence: 'src/a.py:1', scenario: 'suspected wrong value' };
    f.writeSession(AUDIT, AUTHOR, { ...f.report, findings: [finding] });
    const decision = { id: 'A1', verdict: 'refuted', evidence: 'static: caller requires the value 2' };
    f.writeSession(VERIFY, AUTHOR, { ...f.verification, decisions: [decision] });
    assert.equal(f.register().verdict, 'PASS');
  });

  test('reader_derivesNeedsFixes_forNewVerifierFinding', (t) => {
    const f = new CodexFixture(t);
    const finding = { id: 'V1', impact: 'high', evidence: 'src/a.py:1', scenario: 'wrong value' };
    f.writeSession(VERIFY, AUTHOR, { ...f.verification, findings: [finding] });
    assert.equal(f.register().verdict, 'NEEDS_FIXES');
  });

  test('genericWriter_rejectsNativeEvidenceImport', (t) => {
    const f = new CodexFixture(t);
    const request = f.sandbox.reviewRequest(f.repo);
    request.source.via = codexReview.VIA;
    assert.throws(() => writers.writeReview(request), writers.Usage);
  });
});

describe('SessionRootTest', () => {
  test('sessionRoot_ignoresCallerControlledHomeAndProfile', (t) => {
    const saved = { HOME: process.env['HOME'], CODEX_HOME: process.env['CODEX_HOME'] };
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    process.env['HOME'] = '/tmp/fake-home';
    process.env['CODEX_HOME'] = '/tmp/fake-profile';
    const expected = join(realpathSync(userInfo().homedir), '.codex');
    assert.equal(codexReview.sessionRoot(), expected);
  });
});

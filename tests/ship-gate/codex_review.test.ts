import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import * as codexReview from '../../lib/evidence/codex_review.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import * as store from '../../lib/evidence/store.ts';
import * as verify from '../../lib/evidence/verify.ts';
import * as writers from '../../lib/evidence/writers.ts';
import { AUDIT, AUTHOR, CodexFixture, VERIFY } from './codex_helpers.ts';

const refused = writers.Refused;

function readVerifier(): void {
  const [, bytes] = codexReview.locateSession(VERIFY);
  codexReview.completedReport(bytes, VERIFY);
}

function versionOneEvidence(f: CodexFixture): any {
  const [auditPath, auditBytes] = codexReview.locateSession(AUDIT);
  const [verifierPath, verifierBytes] = codexReview.locateSession(VERIFY);
  const root = 'cx-' + VERIFY;
  return {
    repo: f.repo.key, repo_root: f.repo.path, run_id: root, root_run_id: root,
    since: null, since_tree: null, review_base: f.base, head: null,
    snapshot_tree: f.tree, reviewed_tree: f.tree, review_kind: codexReview.KIND, verdict: 'PASS',
    paths: gitcmd.diffEntries(f.repo.path, f.base, f.tree).map((entry) => ({ path: entry.path, blob: entry.blob, mode: entry.mode })),
    source: {
      via: codexReview.VIA, session_id: AUTHOR, audit_id: AUDIT, agent_id: VERIFY,
      audit_path: auditPath, agent_transcript_path: verifierPath,
      audit_sha256: codexReview.digest(auditBytes), agent_sha256: codexReview.digest(verifierBytes),
    },
    [writers.NO_TEST_REASON]: null,
  };
}

describe('CodexReviewTest', () => {

  test('retiredWriter_isUnavailable', () => {
    assert.ok(!('register' in codexReview));
  });

  test('reader_refusesIncompleteReviewer', (t) => {
    const f = new CodexFixture(t);
    f.writeSession(VERIFY, AUTHOR, f.verification, false);
    assert.throws(() => readVerifier(), refused);
  });







  test('reader_refusesFinalTextInjectedInUserMessage', (t) => {
    const f = new CodexFixture(t);
    const path = f.writeSession(VERIFY, AUTHOR, f.verification);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"role":"assistant"', '"role":"user"'));
    assert.throws(() => readVerifier(), refused);
  });

  test('reader_refusesReviewerResumedAfterFinal', (t) => {
    const f = new CodexFixture(t);
    const path = f.writeSession(VERIFY, AUTHOR, f.verification);
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }) + '\n');
    assert.throws(() => readVerifier(), refused);
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

  test('ruleChecks_runsTheScriptUnderKeelHome', (t) => {
    const f = new CodexFixture(t);
    const keelHome = join(f.sandbox.root, 'keel-home');
    const summary = 'summary repos=1 scanned_lines=2 signals=0 unscanned=none blocked=none';
    const completed = { status: 0, signal: null, stdout: Buffer.from(summary + '\n'), stderr: Buffer.alloc(0), pid: 1, output: [] };
    const spawn = t.mock.method(childProcess, 'spawnSync', () => completed);
    f.sandbox.patchProcessEnv(t, { KEEL_HOME: keelHome });
    assert.equal(codexReview.runRuleChecks(f.repo.path, f.base, f.tree), summary);
    assert.equal(spawn.mock.calls[0]!.arguments[1]![0], join(keelHome, 'skills/writing-readable-code/scripts/rule-checks.ts'));
  });

  test('ruleChecks_refusesTimeout', (t) => {
    const f = new CodexFixture(t);
    const timedOut = { error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: null };
    t.mock.method(childProcess, 'spawnSync', () => timedOut);
    assert.throws(() => codexReview.runRuleChecks(f.repo.path, f.base, f.tree), refused);
  });






  test('reader_refusesDuplicateRollout', (t) => {
    const f = new CodexFixture(t);
    const path = f.writeSession(VERIFY, AUTHOR, f.verification);
    copyFileSync(path, join(dirname(path), `rollout-copy-${VERIFY}.jsonl`));
    assert.throws(() => readVerifier(), refused);
    assert.ok(basename(path).includes(VERIFY));
  });





  test('validateEvidence_refusesVersionOneEvidenceWithIntactSessions', (t) => {
    const f = new CodexFixture(t);
    const evidence = versionOneEvidence(f);
    assert.throws(() => codexReview.validateEvidence(evidence),
      (error: Error) => error instanceof refused && error.message === 'Codex review evidence must be version 2');
    assert.throws(() => codexReview.validateEvidence({ ...evidence, source: { ...evidence.source, version: 1 } }),
      (error: Error) => error instanceof refused && error.message === 'Codex review evidence must be version 2');
  });

  test('gate_refusesStoredVersionOneEvidence_atApprovalAndShipping', (t) => {
    const f = new CodexFixture(t);
    const evidence = versionOneEvidence(f);
    store.write('review', evidence, f.repo.key);
    f.repo.commit({});
    f.sandbox.testsEvidence(f.repo);
    assert.throws(() => writers.writeApproval(evidence.root_run_id, 'approval'), refused);
    const decision = verify.judge(f.outgoing());
    assert.equal(decision.ok, false);
    assert.ok(decision.reasons.some((reason) => reason.text.includes('invalid Codex provenance: Codex review evidence must be version 2')),
      JSON.stringify(decision.reasons));
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

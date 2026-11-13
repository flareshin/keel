import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const NOT_READY = 1;

function feature(t: TestContext): [Sandbox, Repo] {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(LOGIC_WITH_TEST);
  return [sandbox, repo];
}

function check(sandbox: Sandbox, repo: Repo) {
  return sandbox.keel(['evidence', 'check', '--repo', repo.path]);
}

describe('EvidenceCheckTest', () => {
  test('check_isReady_whenThePushWouldPass', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.fullBundle(repo);
    const run = check(sandbox, repo);
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.repo, 'acme/app');
    assert.equal(run.json.head, repo.head());
    assert.equal(run.json.root_run_id, 'rv-root-0001');
    assert.deepEqual(run.json.reasons, []);
  });

  test('check_namesK3_whenNoTestsRanInThisRepo', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.review(repo);
    sandbox.approve('rv-root-0001');
    const run = check(sandbox, repo);
    assert.equal(run.rc, NOT_READY, run.stderr);
    assert.equal(run.json.ok, false);
    assert.ok(run.json.reasons.some((reason: any) => reason.rule_id === 'K3' && reason.text.includes('no tests evidence')), run.stdout);
  });

  test('check_namesK3_whenACommitAfterTheTestRunChangedTheContent', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.fullBundle(repo);
    repo.commit({ 'src/a.py': 'print(2)\n' });
    const run = check(sandbox, repo);
    assert.equal(run.rc, NOT_READY, run.stderr);
    assert.ok(run.json.reasons.some((reason: any) => reason.rule_id === 'K3'), run.stdout);
  });

  test('check_writesNoFire_soItNeverCountsAsAGateDecision', (t) => {
    const [sandbox, repo] = feature(t);
    check(sandbox, repo);
    assert.deepEqual(sandbox.fires(), []);
  });
});

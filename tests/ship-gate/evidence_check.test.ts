import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { DEFAULT_REGISTRY, LOGIC_WITH_TEST, PUSH_APPROVAL_REGISTRY, Sandbox } from './helpers.ts';
import type { Repo, Run } from './helpers.ts';

const READY = 0;
const NOT_READY = 1;
const USAGE = 2;
const PUSH_DENIED = 2;

function feature(t: TestContext, registry: string[] = DEFAULT_REGISTRY): [Sandbox, Repo] {
  const sandbox = new Sandbox(t, registry);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(LOGIC_WITH_TEST);
  return [sandbox, repo];
}

function check(sandbox: Sandbox, repo: Repo): Run {
  return sandbox.keel(['evidence', 'check', '--repo', repo.path]);
}

function assertAgreesWithThePush(sandbox: Sandbox, repo: Repo, run: Run): void {
  const push = sandbox.push(repo);
  assert.equal(push.rc, run.json.ok ? READY : PUSH_DENIED, push.stderr);
}

function hasReason(run: Run, ruleId: string, text: string): boolean {
  return run.json.reasons.some((reason: any) => reason.rule_id === ruleId && reason.text.includes(text));
}

describe('EvidenceCheckTest', () => {
  test('check_isReady_whenReviewAndTestsCoverThePush_andTheRepoNeedsNoApproval', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.pushBundle(repo);
    const run = check(sandbox, repo);
    assert.equal(run.rc, READY, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.gated, true);
    assert.equal(run.json.repo, 'acme/app');
    assert.equal(run.json.head, repo.head());
    assert.equal(run.json.root_run_id, 'rv-root-0001');
    assert.deepEqual(run.json.reasons, []);
    assertAgreesWithThePush(sandbox, repo, run);
  });

  test('check_namesK1_whenThePushNeedsApprovalAndTheOwnerHasNotApproved', (t) => {
    const [sandbox, repo] = feature(t, PUSH_APPROVAL_REGISTRY);
    sandbox.pushBundle(repo);
    const run = check(sandbox, repo);
    assert.equal(run.rc, NOT_READY, run.stderr);
    assert.ok(hasReason(run, 'K1', 'no approval bound to chain head'), run.stdout);
    assertAgreesWithThePush(sandbox, repo, run);
  });

  test('check_isReady_whenThePushNeedsApprovalAndTheOwnerApproved', (t) => {
    const [sandbox, repo] = feature(t, PUSH_APPROVAL_REGISTRY);
    sandbox.fullBundle(repo);
    const run = check(sandbox, repo);
    assert.equal(run.rc, READY, run.stderr);
    assertAgreesWithThePush(sandbox, repo, run);
  });

  test('check_namesK3_whenNoTestsRanInThisRepo', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.review(repo);
    const run = check(sandbox, repo);
    assert.equal(run.rc, NOT_READY, run.stderr);
    assert.equal(run.json.ok, false);
    assert.ok(hasReason(run, 'K3', 'no tests evidence'), run.stdout);
    assertAgreesWithThePush(sandbox, repo, run);
  });

  test('check_namesK3_whenACommitAfterTheTestRunChangedTheContent', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.pushBundle(repo);
    repo.commit({ 'src/a.py': 'print(2)\n' });
    const run = check(sandbox, repo);
    assert.equal(run.rc, NOT_READY, run.stderr);
    assert.ok(hasReason(run, 'K3', 'no tests evidence'), run.stdout);
    assertAgreesWithThePush(sandbox, repo, run);
  });

  test('check_isReady_forARepoTheGateTurnsOff', (t) => {
    const sandbox = new Sandbox(t, [...DEFAULT_REGISTRY, 'acme/other\toff\tmain\t-\tnone']);
    const other = sandbox.clone('acme', 'other');
    other.commit({ 'src/b.py': 'print(1)\n' });
    const run = check(sandbox, other);
    assert.equal(run.rc, READY, run.stderr);
    assert.equal(run.json.gated, false);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.repo, 'acme/other');
    assertAgreesWithThePush(sandbox, other, run);
  });

  test('check_isReady_forARepoTheRegistryDoesNotList', (t) => {
    const sandbox = new Sandbox(t);
    const unlisted = sandbox.clone('acme', 'unlisted');
    const run = check(sandbox, unlisted);
    assert.equal(run.rc, READY, run.stderr);
    assert.equal(run.json.gated, false);
    assertAgreesWithThePush(sandbox, unlisted, run);
  });

  test('check_writesNoFire_soItNeverCountsAsAGateDecision', (t) => {
    const [sandbox, repo] = feature(t);
    const run = check(sandbox, repo);
    assert.equal(run.rc, NOT_READY, run.stderr);
    assert.deepEqual(sandbox.fires(), []);
  });

  test('check_asksForAFetch_whenTheIntegrationBaseRefIsMissing', (t) => {
    const [sandbox, repo] = feature(t);
    repo.git('update-ref', '-d', 'refs/remotes/origin/main');
    const run = check(sandbox, repo);
    assert.equal(run.rc, USAGE, run.stdout);
    assert.ok(run.stderr.includes('base origin/main is missing: run `git fetch origin`'), run.stderr);
  });

  test('check_refusesAPathOutsideAnyRepository', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.keel(['evidence', 'check', '--repo', sandbox.home]);
    assert.equal(run.rc, USAGE, run.stdout);
    assert.ok(run.stderr.includes('is not in a git repository'), run.stderr);
  });

  test('check_requiresRepo', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.keel(['evidence', 'check']);
    assert.equal(run.rc, USAGE, run.stdout);
    assert.ok(run.stderr.includes('check requires --repo'), run.stderr);
  });
});

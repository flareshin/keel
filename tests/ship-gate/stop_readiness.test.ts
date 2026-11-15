import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { DEFAULT_REGISTRY, LOGIC_WITH_TEST, PUSH_APPROVAL_REGISTRY, Sandbox } from './helpers.ts';
import type { Repo, Run } from './helpers.ts';

const PASS = 0;

function feature(t: TestContext, registry: string[] = DEFAULT_REGISTRY): [Sandbox, Repo] {
  const sandbox = new Sandbox(t, registry);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(LOGIC_WITH_TEST);
  return [sandbox, repo];
}

function stop(sandbox: Sandbox, cwd: string, options: { session?: string; continuing?: boolean } = {}): Run {
  return sandbox.hook({
    session_id: options.session ?? 's1', transcript_path: '/dev/null', cwd, permission_mode: 'default',
    hook_event_name: 'Stop', stop_hook_active: options.continuing ?? false, last_assistant_message: 'done',
  });
}

function feedback(run: Run): string {
  assert.equal(run.rc, PASS, run.stderr);
  const output = run.json;
  assert.equal(output.hookSpecificOutput.hookEventName, 'Stop');
  return output.hookSpecificOutput.additionalContext;
}

function assertSilent(run: Run): void {
  assert.equal(run.rc, PASS, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
}

describe('StopReadinessTest', () => {
  test('stop_namesK3_whenTheUnpushedHeadHasNoTestsEvidence', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.review(repo);
    const context = feedback(stop(sandbox, repo.path));
    assert.ok(context.includes('[K3]'), context);
    assert.ok(context.includes('no tests evidence'), context);
    assert.ok(context.includes(repo.head().slice(0, 12)), context);
  });

  test('stop_namesK1_whenNoReviewCoversTheUnpushedHead', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.testsEvidence(repo);
    const context = feedback(stop(sandbox, repo.path));
    assert.ok(context.includes('[K1]'), context);
  });

  test('stop_isSilent_whenReviewAndTestsCoverTheHead', (t) => {
    const [sandbox, repo] = feature(t);
    sandbox.pushBundle(repo);
    assertSilent(stop(sandbox, repo.path));
  });

  test('stop_isSilent_whenOnlyTheOwnersApprovalIsMissing', (t) => {
    const [sandbox, repo] = feature(t, PUSH_APPROVAL_REGISTRY);
    sandbox.pushBundle(repo);
    assert.equal(sandbox.keel(['evidence', 'check', '--repo', repo.path]).json.ok, false);
    assertSilent(stop(sandbox, repo.path));
  });

  test('stop_isSilent_whenTheTurnAlreadyContinuesForAStopHook', (t) => {
    const [sandbox, repo] = feature(t);
    assertSilent(stop(sandbox, repo.path, { continuing: true }));
  });

  test('stop_isSilent_whenTheUpstreamAlreadyHoldsTheHead', (t) => {
    const [sandbox, repo] = feature(t);
    repo.git('push', '-q', '-u', 'origin', 'feature');
    assertSilent(stop(sandbox, repo.path));
  });

  test('stop_tellsAgain_whenACommitLandsAfterTheUpstreamWasPushed', (t) => {
    const [sandbox, repo] = feature(t);
    repo.git('push', '-q', '-u', 'origin', 'feature');
    repo.commit({ 'src/a.py': 'print(3)\n' });
    feedback(stop(sandbox, repo.path));
  });

  test('stop_isSilent_whenTheHeadHasNoCommitPastTheIntegrationBase', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    assertSilent(stop(sandbox, repo.path));
  });

  test('stop_tellsOnce_forTheSameSessionHeadAndReasons', (t) => {
    const [sandbox, repo] = feature(t);
    feedback(stop(sandbox, repo.path));
    assertSilent(stop(sandbox, repo.path));
    feedback(stop(sandbox, repo.path, { session: 's2' }));
  });

  test('stop_tellsAgain_afterANewCommitMovesTheHead', (t) => {
    const [sandbox, repo] = feature(t);
    feedback(stop(sandbox, repo.path));
    repo.commit({ 'src/a.py': 'print(2)\n' });
    feedback(stop(sandbox, repo.path));
  });

  test('stop_tellsEveryTime_andSaysSoOnStderr_whenTheReminderRecordCannotBeKept', (t) => {
    const [sandbox, repo] = feature(t);
    mkdirSync(join(sandbox.data, 'state', 'keel'), { recursive: true });
    writeFileSync(join(sandbox.data, 'state', 'keel', 'stop-readiness'), 'not a directory\n');
    const first = stop(sandbox, repo.path);
    feedback(first);
    assert.ok(first.stderr.includes('could not record the Stop reminder'), first.stderr);
    const second = stop(sandbox, repo.path);
    feedback(second);
    assert.ok(second.stderr.includes('ENOTDIR'), second.stderr);
  });

  test('stop_writesOneWarnFire_andNoDeny', (t) => {
    const [sandbox, repo] = feature(t);
    feedback(stop(sandbox, repo.path));
    stop(sandbox, repo.path);
    const fires = sandbox.fires();
    assert.equal(fires.length, 1, JSON.stringify(fires));
    assert.equal(fires[0].outcome, 'warn');
    assert.equal(fires[0].hook, 'ship-gate');
  });

  test('stop_isSilent_forARepoTheGateTurnsOff', (t) => {
    const sandbox = new Sandbox(t, [...DEFAULT_REGISTRY, 'acme/other\toff\tmain\t-\tnone']);
    const other = sandbox.clone('acme', 'other');
    other.branch('feature');
    other.commit({ 'src/b.py': 'print(1)\n' });
    assertSilent(stop(sandbox, other.path));
  });

  test('stop_isSilent_outsideAnyRepository', (t) => {
    const sandbox = new Sandbox(t);
    assertSilent(stop(sandbox, sandbox.home));
  });

  test('stop_isSilent_whenTheIntegrationBaseRefIsMissing', (t) => {
    const [sandbox, repo] = feature(t);
    repo.git('update-ref', '-d', 'refs/remotes/origin/main');
    const run = stop(sandbox, repo.path);
    assert.equal(run.rc, PASS, run.stderr);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes('push readiness at Stop not judged'), run.stderr);
    assert.ok(run.stderr.includes('origin/main is missing'), run.stderr);
  });
});

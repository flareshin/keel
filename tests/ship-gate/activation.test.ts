import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { checkLiveCheckouts } from '../../hooks/git-guard/git-guard.ts';
import { steps } from '../../hooks/lib/hookkit/shell.ts';
import { approvedFastForward } from '../../lib/evidence/activation.ts';
import { AUTO_MERGE_REGISTRY, KEEL_HOME, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

class ActivationFixture {
  box: Sandbox;
  repo: Repo;
  before: string;
  target: string;

  constructor(t: TestContext, registry?: string[]) {
    this.box = new Sandbox(t, registry);
    this.repo = this.box.clone('acme', 'app');
    this.before = this.repo.head();
    this.repo.commit({ 'src/a.py': 'print(2)\n', 'tests/test_a.py': 'assert 2 == 2\n' });
    this.target = this.repo.head();
    this.box.review(this.repo);
    this.box.testsEvidence(this.repo);
    this.repo.git('checkout', '--detach', this.before);
    this.box.patchProcessEnv(t);
  }

  approveTarget(read = false): void {
    this.repo.git('checkout', '--detach', this.target);
    const args = ['approve', 'rv-root-0001', ...(read ? ['--read'] : [])];
    assert.equal(this.box.keel(args).rc, 0);
    this.repo.git('checkout', '--detach', this.before);
  }
}

describe('ActivationTest', () => {
  test('activation_requiresOwnerApproval_forExactTarget', (t) => {
    const f = new ActivationFixture(t);
    assert.equal(approvedFastForward(f.repo.path, f.target), false);
    f.approveTarget(true);
    assert.equal(approvedFastForward(f.repo.path, f.target), false);
    f.approveTarget();

    assert.equal(approvedFastForward(f.repo.path, f.target), true);
    assert.equal(approvedFastForward(f.repo.path, 'main'), false);
    f.repo.write('dirty.txt', 'unreviewed\n');
    assert.equal(approvedFastForward(f.repo.path, f.target), false);
  });

  test('activation_guardAllowsOnlyApprovedLiteralFastForward', (t) => {
    const f = new ActivationFixture(t);
    f.approveTarget();
    f.box.patchProcessEnv(t, { KEEL_HOME: f.repo.path });

    const approved = checkLiveCheckouts(steps('git merge --ff-only ' + f.target, f.repo.path));
    const ordinary = checkLiveCheckouts(steps('git merge ' + f.target, f.repo.path));

    assert.deepEqual(approved, []);
    assert.ok(ordinary.some((item) => item.ruleId === 'C-isolation'));
  });

  test('activation_gitGuardProcess_passesAnApprovedFastForward_andDeniesTheSameMergeWithoutApproval', (t) => {
    const f = new ActivationFixture(t);
    const guard = (command: string) => spawnSync(process.execPath, [join(KEEL_HOME, 'hooks', 'git-guard', 'git-guard.ts')], {
      input: JSON.stringify(f.box.bashPayload(f.repo, command)), encoding: 'utf8', env: { ...f.box.env, KEEL_HOME: f.repo.path },
    });
    const merge = 'git merge --ff-only ' + f.target;

    const unapproved = guard(merge);
    f.approveTarget();
    const approved = guard(merge);
    const ordinary = guard('git merge ' + f.target);

    assert.equal(unapproved.status, 2, unapproved.stderr);
    assert.match(unapproved.stderr, /\[C-isolation\]/);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(approved.stderr, '');
    assert.equal(ordinary.status, 2, ordinary.stderr);
    assert.match(ordinary.stderr, /\[C-isolation\]/);
  });

  test('activation_passesWithoutApproval_whenTheRegistryMergesThisRepoOnReviewAndTests', (t) => {
    const f = new ActivationFixture(t, AUTO_MERGE_REGISTRY);
    assert.equal(approvedFastForward(f.repo.path, f.target), true);
    f.repo.write('dirty.txt', 'unreviewed\n');
    assert.equal(approvedFastForward(f.repo.path, f.target), false);
  });

  test('activation_refusesAnUnreviewedTree_whenTheRegistryMergesThisRepo', (t) => {
    const f = new ActivationFixture(t, AUTO_MERGE_REGISTRY);
    f.repo.git('checkout', '--detach', f.target);
    f.repo.commit({ 'src/a.py': 'print(3)\n' });
    const unreviewed = f.repo.head();
    f.repo.git('checkout', '--detach', f.before);
    assert.equal(approvedFastForward(f.repo.path, unreviewed), false);
  });

  test('activation_refusesExpiredTests_whenTheRegistryMergesThisRepo', (t) => {
    const f = new ActivationFixture(t, AUTO_MERGE_REGISTRY);
    const path = f.box.evidenceFiles('tests')[0]!;
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    evidence.expires_at = '2000-01-01T00:00:00Z';
    writeFileSync(path, JSON.stringify(evidence));
    assert.equal(approvedFastForward(f.repo.path, f.target), false);
  });

  test('activation_refusesDifferentCommitWithSameTree', (t) => {
    const f = new ActivationFixture(t);
    f.approveTarget();
    f.repo.git('checkout', '--detach', f.target);
    f.repo.git('commit', '--allow-empty', '-m', 'unapproved identity');
    const different = f.repo.head();
    f.repo.git('checkout', '--detach', f.before);

    assert.equal(approvedFastForward(f.repo.path, different), false);
  });

  test('activation_refusesExpiredTests', (t) => {
    const f = new ActivationFixture(t);
    f.approveTarget();
    const path = f.box.evidenceFiles('tests')[0]!;
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    evidence.expires_at = '2000-01-01T00:00:00Z';
    writeFileSync(path, JSON.stringify(evidence));
    assert.equal(approvedFastForward(f.repo.path, f.target), false);
  });

  test('activation_refusesNonFastForward_withFreshEvidence', (t) => {
    const f = new ActivationFixture(t);
    f.approveTarget();
    assert.equal(approvedFastForward(f.repo.path, f.target), true);
    f.repo.commit({ 'src/a.py': 'print(999)\n' });
    assert.equal(approvedFastForward(f.repo.path, f.target), false);
  });
});

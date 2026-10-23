import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { approvedFastForward } from '../../lib/evidence/activation.ts';
import { Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

class ActivationFixture {
  box: Sandbox;
  repo: Repo;
  before: string;
  target: string;

  constructor(t: TestContext) {
    this.box = new Sandbox(t);
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

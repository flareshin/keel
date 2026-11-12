import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { LOGIC_WITH_TEST, Sandbox, readJson } from './helpers.ts';
import type { Repo } from './helpers.ts';

const PRODUCTION = 'production';
const DAY_MS = 24 * 3600 * 1000;

interface Develop {
  sandbox: Sandbox;
  repo: Repo;
  head: string;
}

function releasePullRequest(sandbox: Sandbox, head: string): void {
  const body = { state: 'OPEN', statusCheckRollup: [], baseRefName: PRODUCTION, headRefOid: head };
  writeFileSync(sandbox.ghResponse, JSON.stringify(body));
}

function reviewedBranch(sandbox: Sandbox, repo: Repo, name: string, files: Record<string, string>, runId: string): void {
  repo.git('checkout', '-q', '-b', name, 'main');
  const start = repo.head();
  repo.commit(files, name);
  sandbox.review(repo, { runId, reviewBase: start, head: repo.head() });
  sandbox.approve(runId);
  repo.git('checkout', '-q', 'main');
}

function mergeIntoDevelop(repo: Repo, name: string): void {
  repo.git('merge', '-q', '--no-ff', '-m', `Merge ${name}`, name);
}

function developAheadOfProduction(t: TestContext, extra?: (sandbox: Sandbox, repo: Repo) => void): Develop {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app');
  repo.git('push', '-q', 'origin', `main:${PRODUCTION}`);
  reviewedBranch(sandbox, repo, 'first', LOGIC_WITH_TEST, 'rv-first-0001');
  mergeIntoDevelop(repo, 'first');
  reviewedBranch(sandbox, repo, 'second', { 'src/b.py': 'print(2)\n', 'tests/test_b.py': 'def test_b():\n    assert True\n' }, 'rv-second-0001');
  reviewedBranch(sandbox, repo, 'third', { 'src/d.py': 'print(4)\n', 'tests/test_d.py': 'def test_d():\n    assert True\n' }, 'rv-third-0001');
  mergeIntoDevelop(repo, 'third');
  mergeIntoDevelop(repo, 'second');
  if (extra) extra(sandbox, repo);
  repo.git('push', '-q', 'origin', 'main');
  repo.git('fetch', '-q', 'origin');
  sandbox.testsEvidence(repo);
  const head = repo.head();
  releasePullRequest(sandbox, head);
  return { sandbox, repo, head };
}

function promote(develop: Develop) {
  return develop.sandbox.push(develop.repo, `gh pr merge 9 --merge --match-head-commit ${develop.head}`);
}

function approvePromote(develop: Develop, head = develop.head) {
  const run = develop.sandbox.keel(['approve', '--promote', develop.repo.key, head]);
  assert.equal(run.rc, 0, run.stderr);
  return run;
}

function unreviewedCommitOnDevelop(_sandbox: Sandbox, repo: Repo): void {
  repo.commit({ 'src/c.py': 'print(3)\n', 'tests/test_c.py': 'def test_c():\n    assert True\n' }, 'unreviewed');
}

function plan(develop: Develop) {
  const run = develop.sandbox.keel(['evidence', 'promote-plan', '--repo', develop.repo.path, '--base', `origin/${PRODUCTION}`, '--head', develop.head]);
  assert.equal(run.rc, 0, run.stderr);
  return run.json;
}

describe('PromoteTest', () => {
  test('promote_credits_develop_chains_forked_after_the_production_merge_base', (t) => {
    const develop = developAheadOfProduction(t);
    approvePromote(develop);
    const run = promote(develop);
    assert.equal(run.rc, 0, run.stderr);
  });

  test('promote_denies_without_an_approval_bound_to_the_merged_sha', (t) => {
    const develop = developAheadOfProduction(t);
    const run = promote(develop);
    assert.equal(run.rc, 2, run.stderr);
    assert.ok(run.stderr.includes(`keel approve --promote ${develop.repo.key} ${develop.head}`), run.stderr);
  });

  test('promote_approval_for_another_sha_does_not_count', (t) => {
    const develop = developAheadOfProduction(t);
    approvePromote(develop, develop.repo.git('rev-parse', 'HEAD^1'));
    assert.equal(promote(develop).rc, 2);
  });

  test('promote_denies_an_uncovered_commit_until_a_review_of_only_that_step_passes', (t) => {
    const develop = developAheadOfProduction(t, unreviewedCommitOnDevelop);
    approvePromote(develop);
    const denied = promote(develop);
    assert.equal(denied.rc, 2, denied.stderr);
    assert.ok(denied.stderr.includes('keel evidence promote-plan'), denied.stderr);
    develop.sandbox.review(develop.repo, { runId: 'rv-delta-0001', reviewBase: develop.repo.git('rev-parse', 'HEAD^1'), head: develop.head });
    const run = promote(develop);
    assert.equal(run.rc, 0, run.stderr);
  });

  test('promote_plan_lists_credited_steps_and_the_uncovered_run', (t) => {
    const develop = developAheadOfProduction(t, unreviewedCommitOnDevelop);
    const parent = develop.repo.git('rev-parse', 'HEAD^1');
    const result = plan(develop);
    assert.equal(result.head, develop.head);
    assert.deepEqual(result.uncovered, [{ base: parent, head: develop.head, commits: 1 }]);
    assert.deepEqual(result.steps.map((step: any) => step.root_run_id), [null, 'rv-second-0001', 'rv-third-0001', 'rv-first-0001']);
  });

  test('promote_plan_counts_a_review_of_the_uncovered_run_as_credit', (t) => {
    const develop = developAheadOfProduction(t, unreviewedCommitOnDevelop);
    develop.sandbox.review(develop.repo, { runId: 'rv-delta-0001', reviewBase: develop.repo.git('rev-parse', 'HEAD^1'), head: develop.head });
    const result = plan(develop);
    assert.deepEqual(result.uncovered, []);
    assert.equal(result.steps[0].root_run_id, 'rv-delta-0001');
  });

  test('approve_promote_refuses_a_malformed_repo_or_sha', (t) => {
    const sandbox = new Sandbox(t);
    assert.equal(sandbox.keel(['approve', '--promote', 'acme/app', 'abc']).rc, 2);
    assert.equal(sandbox.keel(['approve', '--promote', 'not-a-repo', 'a'.repeat(40)]).rc, 2);
  });

  test('review_and_approval_evidence_live_thirty_days_and_tests_fourteen', (t) => {
    const develop = developAheadOfProduction(t);
    const lifetime = (path: string) => {
      const evidence = readJson(path);
      return Math.round((Date.parse(evidence.expires_at) - Date.parse(evidence.created_at)) / DAY_MS);
    };
    assert.equal(lifetime(develop.sandbox.evidenceFiles('review')[0]!), 30);
    assert.equal(lifetime(develop.sandbox.evidenceFiles('approval')[0]!), 30);
    assert.equal(lifetime(develop.sandbox.evidenceFiles('tests')[0]!), 14);
    approvePromote(develop);
    assert.equal(lifetime(develop.sandbox.evidenceFiles('promote')[0]!), 30);
  });
});

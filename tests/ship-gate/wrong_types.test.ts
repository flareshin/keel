import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { LOGIC_WITH_TEST, Repo, Sandbox } from './helpers.ts';

const DENIED = 2;
const PASSED = 0;
const NOT_A_LIST: Array<[string, unknown]> = [
  ['string', 'abc'], ['object', { name: 'ci', conclusion: 'FAILURE' }], ['number', 5], ['true', true], ['zero', 0], ['false', false],
  ['empty string', ''], ['empty object', {}],
];
const NOT_TEXT: Array<[string, unknown]> = [['number', 1], ['true', true], ['list', ['x']], ['object', { k: 'v' }], ['zero', 0], ['false', false]];

function readyToMerge(sandbox: Sandbox): [Repo, string] {
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  const head = repo.commit(LOGIC_WITH_TEST);
  repo.git('push', '-q', 'origin', 'feature');
  sandbox.review(repo, { head });
  sandbox.testsEvidence(repo);
  sandbox.approve('rv-root-0001');
  return [repo, head];
}

function answer(sandbox: Sandbox, head: string, overrides: Record<string, unknown>): void {
  const body = {
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
    baseRefName: 'main', headRefOid: head, ...overrides,
  };
  writeFileSync(sandbox.ghResponse, JSON.stringify(body));
}

function merge(sandbox: Sandbox, repo: Repo, head: string) {
  return sandbox.push(repo, `gh pr merge 7 --squash --match-head-commit ${head}`);
}

describe('WrongTypeGhAnswerTest', () => {
  for (const [label, value] of [['number', 5], ['true', true], ['list', ['main']], ['object', { k: 'v' }], ['zero', 0], ['false', false], ['empty string', ''], ['null', null]] as const) {
    test(`merge_denies_whenBaseRefNameIs_${label.replace(' ', '_')}`, (t) => {
      const sandbox = new Sandbox(t);
      const [repo, head] = readyToMerge(sandbox);
      answer(sandbox, head, { baseRefName: value });
      const run = merge(sandbox, repo, head);
      assert.equal(run.rc, DENIED, run.stderr);
      assert.ok(run.stderr.includes('gh pr view returned no baseRefName'), run.stderr);
    });
  }

  for (const [label, value] of NOT_A_LIST) {
    test(`merge_denies_whenStatusCheckRollupIs_${label.replace(' ', '_')}`, (t) => {
      const sandbox = new Sandbox(t);
      const [repo, head] = readyToMerge(sandbox);
      answer(sandbox, head, { statusCheckRollup: value });
      const run = merge(sandbox, repo, head);
      assert.equal(run.rc, DENIED, run.stderr);
      assert.ok(run.stderr.includes('FieldTypeError: statusCheckRollup must be a list'), run.stderr);
    });
  }

  test('merge_passes_whenStatusCheckRollupIsNullOrAbsent', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = readyToMerge(sandbox);
    answer(sandbox, head, { statusCheckRollup: null });
    assert.equal(merge(sandbox, repo, head).rc, PASSED);
  });

  for (const key of ['conclusion', 'status', 'state']) {
    for (const [label, value] of NOT_TEXT) {
      test(`merge_denies_whenACheck_${key}_Is_${label}`, (t) => {
        const sandbox = new Sandbox(t);
        const [repo, head] = readyToMerge(sandbox);
        answer(sandbox, head, { statusCheckRollup: [{ name: 'ci', [key]: value }] });
        const run = merge(sandbox, repo, head);
        assert.equal(run.rc, DENIED, run.stderr);
        assert.ok(run.stderr.includes(`FieldTypeError: check ${key} must be a string`), run.stderr);
      });
    }
  }

  test('merge_readsAnEmptyOrNullConclusionAsAbsent_andJudgesTheStatusBehindIt', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = readyToMerge(sandbox);
    answer(sandbox, head, { statusCheckRollup: [{ name: 'ci', conclusion: '', status: 'IN_PROGRESS' }, { name: 'lint', conclusion: null, status: 'COMPLETED', state: 'SUCCESS' }] });
    const run = merge(sandbox, repo, head);
    assert.equal(run.rc, DENIED, run.stderr);
    assert.ok(run.stderr.includes('checks not green: ci=IN_PROGRESS'), run.stderr);
  });

  for (const [label, name] of [['number', 5], ['list', ['ci']], ['object', { k: 'v' }], ['true', true]] as const) {
    test(`merge_namesAFailingCheckWithAQuestionMark_whenItsNameIs_${label}`, (t) => {
      const sandbox = new Sandbox(t);
      const [repo, head] = readyToMerge(sandbox);
      answer(sandbox, head, { statusCheckRollup: [{ name, conclusion: 'FAILURE' }] });
      const run = merge(sandbox, repo, head);
      assert.equal(run.rc, DENIED, run.stderr);
      assert.ok(run.stderr.includes('checks not green: ?=FAILURE'), run.stderr);
    });
  }

  test('merge_fallsBackToTheContextOfACheck_whenItsNameIsNotText', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = readyToMerge(sandbox);
    answer(sandbox, head, { statusCheckRollup: [{ name: 5, context: 'legacy/ci', state: 'FAILURE' }] });
    const run = merge(sandbox, repo, head);
    assert.equal(run.rc, DENIED, run.stderr);
    assert.ok(run.stderr.includes('checks not green: legacy/ci=FAILURE'), run.stderr);
  });
});

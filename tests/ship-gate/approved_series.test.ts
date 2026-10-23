import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const PUSH_FEATURE = 'git push origin feature';

interface StageOptions {
  approveFirst?: boolean;
  gap?: boolean;
}

function stages(t: TestContext, options: StageOptions = {}): [Sandbox, Repo] {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  const base = repo.head();
  repo.commit({ ...LOGIC_WITH_TEST, 'src/first.py': 'first = 1\n' });
  sandbox.review(repo, { runId: 'rv-series-0001', reviewBase: base });
  if (options.approveFirst ?? true) sandbox.approve('rv-series-0001');
  if (options.gap) repo.commit({ 'src/gap.py': 'unreviewed = True\n' });
  const boundary = repo.head();
  repo.commit({ 'src/a.py': 'print(2)\n', 'src/second.py': 'second = 2\n' });
  sandbox.review(repo, { runId: 'rv-series-0002', reviewBase: boundary });
  sandbox.approve('rv-series-0002');
  sandbox.testsEvidence(repo);
  return [sandbox, repo];
}

function addThirdReview(sandbox: Sandbox, repo: Repo, files: Record<string, string | null>): void {
  const boundary = repo.head();
  repo.commit(files);
  sandbox.review(repo, { runId: 'rv-series-0003', reviewBase: boundary });
  sandbox.approve('rv-series-0003');
}

describe('ApprovedSeriesTest', () => {
  test('pythonCommentDeletion_requiresFreshEvidence_afterLastReview_thatPythonReused', (t) => {
    const [sandbox, repo] = stages(t);
    addThirdReview(sandbox, repo, { 'src/second.py': '# Ordinary explanation.\nsecond = 3\n', 'tests/test_second.py': 'assert 3 == 3\n' });
    sandbox.testsEvidence(repo);
    repo.commit({ 'src/second.py': 'second = 3\n' });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2, result.stderr);
    assert.ok(result.stderr.includes('src/second.py'), result.stderr);
  });

  test('commentDeletion_reusesApprovedSeries_afterLastReview_in_ts', (t) => {
    const [sandbox, repo] = stages(t);
    addThirdReview(sandbox, repo, { 'src/second.ts': '// Ordinary explanation.\nconst second = 3;\n', 'tests/second.test.ts': 'assert(3 === 3);\n' });
    sandbox.testsEvidence(repo);
    repo.commit({ 'src/second.ts': 'const second = 3;\n' });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('adjacent_approved_changes_reuse_both_reviews', (t) => {
    const [sandbox, repo] = stages(t);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('missing_approval_does_not_compose', (t) => {
    const [sandbox, repo] = stages(t, { approveFirst: false });
    assert.equal(sandbox.push(repo, PUSH_FEATURE).rc, 2);
  });

  test('unreviewed_gap_does_not_compose', (t) => {
    const [sandbox, repo] = stages(t, { gap: true });
    assert.equal(sandbox.push(repo, PUSH_FEATURE).rc, 2);
  });

  test('changes_after_review_do_not_compose', (t) => {
    const [sandbox, repo] = stages(t);
    repo.commit({ 'src/a.py': 'print(3)\n' });
    sandbox.testsEvidence(repo);
    assert.equal(sandbox.push(repo, PUSH_FEATURE).rc, 2);
  });

  test('three_adjacent_reviews_compose', (t) => {
    const [sandbox, repo] = stages(t);
    addThirdReview(sandbox, repo, { 'src/third.py': 'third = 3\n' });
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('final_tests_must_cover_latest_content', (t) => {
    const [sandbox, repo] = stages(t);
    addThirdReview(sandbox, repo, { 'src/third.py': 'third = 3\n' });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('no tests evidence'), result.stderr);
  });

  test('reviewed_deletion_composes', (t) => {
    const [sandbox, repo] = stages(t);
    addThirdReview(sandbox, repo, { 'src/first.py': null });
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('unreviewed_mode_change_does_not_compose', (t) => {
    const [sandbox, repo] = stages(t);
    repo.write('src/a.py', 'print(2)\n', true);
    repo.commit({});
    sandbox.testsEvidence(repo);
    assert.equal(sandbox.push(repo, PUSH_FEATURE).rc, 2);
  });

  test('invalid_newer_chain_does_not_hide_valid_series', (t) => {
    const [sandbox, repo] = stages(t);
    sandbox.review(repo, { runId: 'rv-decoy-0001', reviewBase: repo.head() });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('disconnected_history_cannot_supply_predecessor', (t) => {
    const [sandbox, repo] = stages(t);
    repo.git('checkout', '-b', 'other', 'origin/main');
    repo.commit({ 'src/unrelated.py': 'unrelated = True\n' });
    const unrelated = repo.head();
    repo.git('checkout', 'feature');
    const boundary = repo.head();
    repo.commit({ 'src/third.py': 'third = 3\n' });
    sandbox.review(repo, { runId: 'rv-other-0001', reviewBase: unrelated });
    sandbox.approve('rv-other-0001');
    sandbox.testsEvidence(repo);
    assert.notEqual(boundary, unrelated);
    assert.equal(sandbox.push(repo, PUSH_FEATURE).rc, 2);
  });
});

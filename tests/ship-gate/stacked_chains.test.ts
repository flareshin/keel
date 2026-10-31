import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import { LOGIC_WITH_TEST, Sandbox, shipGateTimeout } from './helpers.ts';
import type { Repo } from './helpers.ts';

type Files = Record<string, string | null>;

const SEED = { 'README.md': 'top\n\n\n\n\nbottom\n' };
const SECOND: Files[] = [{ 'src/second.py': 'second = 2\n' }];
const TOP_CHANGED = { 'README.md': 'top changed\n\n\n\n\nbottom\n' };
const BOTTOM_CHANGED: Files[] = [{ 'README.md': 'top\n\n\n\n\nbottom changed\n' }];
const TOP_REWORDED: Files[] = [{ 'README.md': 'top reworded\n\n\n\n\nbottom\n' }];
const OVERLAP_STACKED = { 'README.md': 'top changed and reworded\n\n\n\n\nbottom\n' };
const SECOND_LINE_ADDED: Files[] = [{ 'README.md': 'top\nsecond\n\n\n\nbottom\n' }];
const ADJACENT_STACKED = { 'README.md': 'top changed\nsecond\n\n\n\nbottom\n' };
const OVERLAP: StackOptions = { firstFiles: TOP_CHANGED, secondCommits: TOP_REWORDED, stackedFiles: OVERLAP_STACKED };
const PUSH_FEATURE = 'git push origin feature';
const STACKED_HINT = 'no review saw the stacked content';

function reviewedBranch(sandbox: Sandbox, repo: Repo, name: string, start: string, commits: Files[], runId: string, approve = true): string {
  repo.git('checkout', '-b', name, start);
  for (const files of commits) repo.commit(files);
  sandbox.review(repo, { runId, reviewBase: start });
  if (approve) sandbox.approve(runId);
  return repo.head();
}

interface StackOptions {
  approveSecond?: boolean;
  firstFiles?: Files;
  secondCommits?: Files[];
  stackedFiles?: Files;
}

function stack(t: TestContext, options: StackOptions = {}): [Sandbox, Repo] {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app', undefined, SEED);
  const base = repo.head();
  repo.branch('first');
  repo.commit({ ...LOGIC_WITH_TEST, ...(options.firstFiles ?? { 'src/first.py': 'first = 1\n' }) });
  sandbox.review(repo, { runId: 'rv-stack-0001', reviewBase: base });
  sandbox.approve('rv-stack-0001');
  const second = reviewedBranch(sandbox, repo, 'second', base, options.secondCommits ?? SECOND, 'rv-stack-0002', options.approveSecond ?? true);
  repo.git('checkout', '-b', 'feature', 'first');
  if (options.stackedFiles) repo.commit(options.stackedFiles);
  else repo.git('cherry-pick', `${base}..${second}`);
  sandbox.testsEvidence(repo);
  return [sandbox, repo];
}

describe('StackedChainsTest', () => {
  test('parallel_approved_chains_stacked_by_rebase_pass', (t) => {
    const [sandbox, repo] = stack(t);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('stacked_chain_of_several_commits_on_one_path_passes', (t) => {
    const [sandbox, repo] = stack(t, { secondCommits: [{ 'src/second.py': 'second = 2\n' }, { 'src/second.py': 'second = 3\n' }] });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('stacked_chain_that_edits_and_restores_a_path_passes', (t) => {
    const [sandbox, repo] = stack(t, {
      secondCommits: [{ 'src/second.py': 'second = 2\n' }, { 'README.md': 'top edited\n\n\n\n\nbottom\n' }, { 'README.md': SEED['README.md'] }],
    });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('stacked_chain_that_adds_and_deletes_a_path_passes', (t) => {
    const [sandbox, repo] = stack(t, {
      secondCommits: [{ 'src/second.py': 'second = 2\n' }, { 'src/scratch.py': 'scratch = 1\n' }, { 'src/scratch.py': null }],
    });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('stacked_series_reached_through_a_second_parent_passes', (t) => {
    const [sandbox, repo] = stack(t);
    const stacked = repo.head();
    const base = repo.git('rev-parse', 'origin/main');
    repo.git('checkout', '-b', 'merged', base);
    repo.commit({ 'src/merged.py': 'merged = 1\n' });
    repo.git('merge', '--no-ff', '-q', '-m', 'merge stacked', 'feature');
    sandbox.review(repo, { runId: 'rv-stack-0004', reviewBase: stacked });
    sandbox.approve('rv-stack-0004');
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, 'git push origin merged');
    assert.equal(result.rc, 0, result.stderr);
  });

  test('unapproved_stacked_chain_denies', (t) => {
    const [sandbox, repo] = stack(t, { approveSecond: false });
    assert.equal(sandbox.push(repo, PUSH_FEATURE).rc, 2);
  });

  test('stacked_chains_editing_one_file_deny', (t) => {
    const [sandbox, repo] = stack(t, OVERLAP);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('README.md (content or mode changed after review)'), result.stderr);
  });

  test('stacked_chains_editing_disjoint_hunks_of_one_file_pass', (t) => {
    const [sandbox, repo] = stack(t, { firstFiles: TOP_CHANGED, secondCommits: BOTTOM_CHANGED });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('stacked_chains_editing_adjacent_lines_of_one_file_deny', (t) => {
    const [sandbox, repo] = stack(t, { firstFiles: TOP_CHANGED, secondCommits: SECOND_LINE_ADDED, stackedFiles: ADJACENT_STACKED });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('stacked_disjoint_hunks_with_an_unreviewed_edit_deny', (t) => {
    const [sandbox, repo] = stack(t, {
      firstFiles: TOP_CHANGED, secondCommits: BOTTOM_CHANGED, stackedFiles: { 'README.md': 'top changed\n\n\nextra\n\nbottom changed\n' },
    });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('stacked_disjoint_hunks_give_no_hint_when_an_unrelated_commit_is_unreviewed', (t) => {
    const [sandbox, repo] = stack(t, { firstFiles: TOP_CHANGED, secondCommits: BOTTOM_CHANGED });
    repo.commit({ 'src/gap.py': 'unreviewed = True\n' });
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('src/gap.py'), result.stderr);
    assert.ok(!result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('stacked_disjoint_hunks_with_an_unreviewed_mode_change_deny', (t) => {
    const [sandbox, repo] = stack(t, { firstFiles: TOP_CHANGED, secondCommits: BOTTOM_CHANGED });
    repo.git('update-index', '--chmod=+x', 'README.md');
    repo.git('commit', '-q', '--amend', '-m', 'change');
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('README.md (content or mode changed after review)'), result.stderr);
  });

  test('disjoint_hunks_squashed_into_one_commit_deny_with_the_hint', (t) => {
    const [sandbox, repo] = stack(t, { firstFiles: TOP_CHANGED, secondCommits: BOTTOM_CHANGED });
    repo.git('reset', '--soft', 'origin/main');
    repo.git('commit', '-q', '-m', 'squash');
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('stacked_overlap_deny_names_the_commit_to_review_again', (t) => {
    const [sandbox, repo] = stack(t, OVERLAP);
    const overlapping = repo.head();
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    const parent = repo.git('rev-parse', 'HEAD^');
    const expected = 'README.md: chains rv-stack-0001, rv-stack-0002 each reviewed it, but no review saw the stacked content; ' +
      `review commit ${overlapping.slice(0, 10)} from its parent ${parent.slice(0, 10)}, then approve that review`;
    assert.ok(result.stderr.includes(expected), result.stderr);
  });

  test('stacked_overlap_with_a_review_of_the_stacked_content_gives_no_hint', (t) => {
    const [sandbox, repo] = stack(t, OVERLAP);
    reviewedBranch(sandbox, repo, 'combined', repo.git('rev-parse', 'origin/main'),
      [OVERLAP_STACKED], 'rv-stack-0006');
    repo.git('checkout', 'feature');
    repo.commit({ 'src/gap.py': 'unreviewed = True\n' });
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(!result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('reviewed_overlap_gives_no_hint_when_an_unrelated_commit_is_unreviewed', (t) => {
    const [sandbox, repo] = stack(t, OVERLAP);
    sandbox.review(repo, { runId: 'rv-stack-0005', reviewBase: repo.git('rev-parse', 'HEAD^'), head: repo.head() });
    sandbox.approve('rv-stack-0005');
    repo.commit({ 'src/gap.py': 'unreviewed = True\n' });
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('src/gap.py'), result.stderr);
    assert.ok(!result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('unapproved_review_of_stacked_content_does_not_suppress_the_hint', (t) => {
    const [sandbox, repo] = stack(t, OVERLAP);
    sandbox.review(repo, { runId: 'rv-stack-0005', reviewBase: repo.git('rev-parse', 'HEAD^'), head: repo.head() });
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('stacked_overlap_passes_after_the_named_commit_is_reviewed_from_its_parent', (t) => {
    const [sandbox, repo] = stack(t, OVERLAP);
    sandbox.review(repo, { runId: 'rv-stack-0005', reviewBase: repo.git('rev-parse', 'HEAD^'), head: repo.head() });
    sandbox.approve('rv-stack-0005');
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 0, result.stderr);
  });

  test('unreviewed_commit_in_stack_denies', (t) => {
    const [sandbox, repo] = stack(t);
    repo.commit({ 'src/gap.py': 'unreviewed = True\n' });
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('src/gap.py'), result.stderr);
  });

  test('stacked_commit_changed_after_review_denies', (t) => {
    const [sandbox, repo] = stack(t);
    repo.write('src/second.py', 'second = 3\n');
    repo.git('commit', '-a', '--amend', '-m', 'change');
    sandbox.testsEvidence(repo);
    const result = sandbox.push(repo, PUSH_FEATURE);
    assert.equal(result.rc, 2);
    assert.ok(result.stderr.includes('src/second.py'), result.stderr);
    assert.ok(!result.stderr.includes(STACKED_HINT), result.stderr);
  });

  test('stacked_chain_reviewed_from_above_the_merge_base_denies', (t) => {
    const [sandbox, repo] = stack(t);
    const first = repo.git('rev-parse', 'first');
    const narrow = reviewedBranch(sandbox, repo, 'narrow', first, [{ 'src/narrow.py': 'narrow = 1\n' }], 'rv-stack-0003');
    repo.git('checkout', 'feature');
    repo.git('cherry-pick', narrow);
    sandbox.testsEvidence(repo);
    assert.equal(sandbox.push(repo, PUSH_FEATURE).rc, 2);
  });

  test('long_stack_among_many_live_chains_passes_well_inside_the_hook_timeout', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app', undefined, SEED);
    const base = repo.head();
    for (let index = 0; index < 30; index++) {
      reviewedBranch(sandbox, repo, `noise${index}`, base, [{ [`noise/n${index}.py`]: 'n = 1\n' }], `rv-noise-${String(index).padStart(4, '0')}`);
    }
    const heads: string[] = [];
    for (let index = 0; index < 4; index++) {
      const commits: Files[] = index === 0 ? [LOGIC_WITH_TEST] : [];
      for (let step = 0; step < 15; step++) commits.push({ [`src/c${index}.py`]: `v = ${step}\n` });
      heads.push(reviewedBranch(sandbox, repo, `chain${index}`, base, commits, `rv-chain-${String(index).padStart(4, '0')}`));
    }
    repo.git('checkout', '-b', 'feature', heads[0]!);
    for (const head of heads.slice(1)) repo.git('cherry-pick', `${base}..${head}`);
    sandbox.testsEvidence(repo);

    const started = performance.now();
    const result = sandbox.push(repo, PUSH_FEATURE);
    const elapsedSeconds = (performance.now() - started) / 1000;

    assert.equal(result.rc, 0, result.stderr);
    assert.ok(elapsedSeconds < shipGateTimeout() / 3, `${elapsedSeconds}s`);
  });
});

describe('MergedBlobTest', () => {
  function blobs(repo: Repo, ...contents: string[]): string[] {
    return contents.map((content) => {
      repo.write('blob.txt', content);
      return repo.git('hash-object', '-w', 'blob.txt');
    });
  }

  test('merged_blob_joins_changes_with_an_unchanged_line_between', (t) => {
    const repo = new Sandbox(t).clone('acme', 'app', undefined, SEED);
    const [base, ours, theirs, joined] = blobs(repo, 'a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n', 'A\nb\nC\n');
    assert.equal(gitcmd.mergedBlob(repo.path, ours!, base!, theirs!), joined);
  });

  test('merged_blob_is_null_when_changes_touch', (t) => {
    const repo = new Sandbox(t).clone('acme', 'app', undefined, SEED);
    const [base, ours, theirs] = blobs(repo, 'a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n');
    assert.equal(gitcmd.mergedBlob(repo.path, ours!, base!, theirs!), null);
  });

  test('merged_blob_is_null_when_changes_overlap', (t) => {
    const repo = new Sandbox(t).clone('acme', 'app', undefined, SEED);
    const [base, ours, theirs] = blobs(repo, 'a\nb\nc\n', 'A\nb\nc\n', 'X\nb\nc\n');
    assert.equal(gitcmd.mergedBlob(repo.path, ours!, base!, theirs!), null);
  });
});

describe('FirstParentAncestorsTest', () => {
  test('first_parent_ancestors_lists_the_line_down_to_stop', (t) => {
    const repo = new Sandbox(t).clone('acme', 'app', undefined, SEED);
    const stop = repo.head();
    const middle = repo.commit({ 'src/m.py': 'm = 1\n' });
    const head = repo.commit({ 'src/h.py': 'h = 1\n' });
    assert.deepEqual(gitcmd.firstParentAncestors(repo.path, head, stop), [middle, stop]);
  });

  test('first_parent_ancestors_is_empty_when_stop_arrives_only_through_a_second_parent', (t) => {
    const repo = new Sandbox(t).clone('acme', 'app', undefined, SEED);
    repo.branch('side');
    const stop = repo.commit({ 'src/side.py': 'side = 1\n' });
    repo.git('checkout', 'main');
    repo.commit({ 'src/main.py': 'main = 1\n' });
    repo.git('merge', '--no-ff', '-q', '-m', 'merge', 'side');
    const head = repo.commit({ 'src/after.py': 'after = 1\n' });
    assert.deepEqual(gitcmd.firstParentAncestors(repo.path, head, stop), []);
  });
});

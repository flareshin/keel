import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { splitlines } from '../../hooks/lib/hookkit/text.ts';
import { LOGIC_WITH_TEST, PUSH_APPROVAL_REGISTRY, Sandbox, expireEvidence } from './helpers.ts';
import type { Repo, Run } from './helpers.ts';

const TEST_FILE = 'tests/test_a.py';
const HEAVY_FILE = 'src/core/billing/a.py';
const TWO_LINE_TEST = 'def test_a():\n    assert True\n';
const ONE_LINE_TEST = 'def test_a(): assert True\n';
const PUSH_FEATURE = 'git push origin feature';

function feature(sandbox: Sandbox, files: Record<string, string | Buffer> = LOGIC_WITH_TEST): Repo {
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(files);
  return repo;
}

function assertDenied(run: Run, ruleId: string, text = ''): void {
  assert.equal(run.rc, 2, run.stderr + run.stdout);
  assert.ok(run.stderr.includes(`- [${ruleId}]`), run.stderr);
  assert.ok(run.stderr.includes(text), run.stderr);
  assert.ok((splitlines(run.stderr).at(-1) ?? '').includes('Run it yourself in your terminal: cd '), run.stderr);
}

function assertPassed(sandbox: Sandbox, run: Run, repoKey = 'acme/app'): any {
  assert.equal(run.rc, 0, run.stderr);
  const passes = sandbox.fires('risk', 'pass');
  assert.ok(passes.length > 0, JSON.stringify(sandbox.fires()));
  assert.equal(passes.at(-1).repo, repoKey);
  return passes.at(-1);
}

function snapshotTree(sandbox: Sandbox, repo: Repo): string {
  return sandbox.keel(['snapshot', repo.path]).json.tree;
}

function sandboxAndFeature(t: TestContext, registry?: string[], files?: Record<string, string | Buffer>): [Sandbox, Repo] {
  const sandbox = new Sandbox(t, registry);
  return [sandbox, feature(sandbox, files)];
}

describe('PushScenarioTest', () => {
  test('push_passes_whenReviewTestsAndApprovalCoverTheChange', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.equal(line.risk, 'standard');
    assert.equal(line.root_run_id, 'rv-root-0001');
    assert.equal(line.head, repo.head());
  });

  test('push_deniesK3_whenTestsEvidenceMissing', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.review(repo);
    sandbox.approve('rv-root-0001');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K3', 'no tests evidence');
    assert.equal(sandbox.fires('K3', 'deny')[0].risk, 'standard');
  });

  test('push_passesWithoutApproval_whenReviewAndTestsCoverTheChange', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.pushBundle(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.equal(line.root_run_id, 'rv-root-0001');
  });

  test('push_deniesK1_whenApprovalMissingAndRegistryMakesPushesDeploy', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, PUSH_APPROVAL_REGISTRY);
    sandbox.pushBundle(repo);
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'no approval bound to chain head');
    assert.equal(sandbox.fires('risk', 'pass').length, 0);
    sandbox.approve('rv-root-0001');
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_deniesK1_whenNoReviewExists', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'no review evidence for acme/app');
  });

  test('push_deniesK3_whenLogicChangesWithoutATestInTheRange', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, undefined, { 'src/a.py': 'print(1)\n' });
    sandbox.pushBundle(repo);
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K3', 'logic changed with no test in the same range: src/a.py');
    assert.equal(sandbox.fires('K3', 'deny')[0].risk, 'standard');
  });

  test('push_passesWithWaiver_whenReviewerStatesNoTestReason', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, undefined, { 'src/a.py': 'print(1)\n' });
    sandbox.review(repo, { noTestReason: 'log line wording only' });
    sandbox.testsEvidence(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.equal(line.detail, 'K3 waived: log line wording only');
  });

  test('push_deniesK3_whenOnlyAnEarlierLinkCarriesTheWaiver', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, undefined, { 'src/a.py': 'print(1)\n' });
    const rootTree = snapshotTree(sandbox, repo);
    sandbox.review(repo, { noTestReason: 'log line wording only' });
    repo.commit({ 'src/a.py': 'print(2)\n' }, 'more logic');
    sandbox.review(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: rootTree });
    sandbox.testsEvidence(repo);
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K3', 'logic changed with no test in the same range: src/a.py');
  });

  test('push_keepsBaseTier_whenATestLosesLines', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app', undefined, { 'README.md': 'seed\n', 'src/app.py': 'x\n', [TEST_FILE]: TWO_LINE_TEST });
    repo.branch('feature');
    repo.commit({ 'src/app.py': 'y\n', [TEST_FILE]: ONE_LINE_TEST });
    sandbox.pushBundle(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.equal(line.risk, 'standard');
  });

  test('push_keepsBaseTier_whenATestOnlyGainsLines', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app', undefined, { 'README.md': 'seed\n', 'src/app.py': 'x\n', [TEST_FILE]: ONE_LINE_TEST });
    repo.branch('feature');
    repo.commit({ 'src/app.py': 'y\n', [TEST_FILE]: ONE_LINE_TEST + 'def test_b(): assert True\n' });
    sandbox.pushBundle(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.equal(line.risk, 'standard');
  });

  test('push_passes_whenNeedsFixesRootIsFollowedByPassingDelta', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    const rootTree = snapshotTree(sandbox, repo);
    sandbox.review(repo, { verdict: 'NEEDS_FIXES' });
    repo.commit({ 'src/a.py': 'print(2)\n' }, 'fix');
    sandbox.review(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: rootTree });
    sandbox.testsEvidence(repo);
    sandbox.approve('rv-root-0001');
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_denies_whenChainHeadIsNeedsFixes', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.review(repo, { verdict: 'NEEDS_FIXES' });
    sandbox.testsEvidence(repo);
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'ends in NEEDS_FIXES');
  });

  test('push_denies_whenDeltaMovedHeadAfterApproval_andPassesAfterNewApproval', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, PUSH_APPROVAL_REGISTRY);
    const rootTree = snapshotTree(sandbox, repo);
    sandbox.fullBundle(repo);
    repo.commit({ 'src/a.py': 'print(3)\n' }, 'more');
    sandbox.review(repo, { runId: 'rv-delta-0002', rootRunId: 'rv-root-0001', since: rootTree });
    sandbox.testsEvidence(repo);
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'no approval bound to chain head');
    sandbox.approve('rv-root-0001');
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_passes_afterConflictFreeRebaseOntoAdvancedMain', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    const other = sandbox.clone('acme', 'app', 'other');
    other.commit({ 'docs/notes.md': 'colleague\n' }, 'upstream');
    other.git('push', '-q', 'origin', 'main');
    repo.git('fetch', '-q', 'origin');
    repo.git('rebase', '-q', 'origin/main');
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_denies_namingThePath_whenFileEditedAfterReview', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    repo.commit({ 'src/a.py': "print('edited')\n" }, 'edit after review');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'src/a.py (content or mode changed after review)');
  });

  test('push_denies_whenReviewBaseIsNarrowerThanMergeBase', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    repo.commit({ 'src/b.py': "print('second')\n" }, 'second commit');
    sandbox.review(repo, { reviewBase: repo.git('rev-parse', 'HEAD~1') });
    sandbox.testsEvidence(repo);
    sandbox.approve('rv-root-0001');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'not from the merge base');
  });

  test('push_denies_whenReviewedFileRevertedToOlderNonBaseValue', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, undefined, { 'src/a.py': 'v1\n' });
    repo.commit({ 'src/a.py': 'v2\n' }, 'v2');
    sandbox.fullBundle(repo);
    repo.commit({ 'src/a.py': 'v1\n' }, 'back to v1');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'src/a.py (content or mode changed after review)');
  });

  test('push_passes_whenDeletionWasReviewed', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit({ 'README.md': null }, 'delete readme');
    sandbox.fullBundle(repo);
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_denies_whenDeletionWasNotReviewed', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    repo.commit({ 'README.md': null }, 'delete readme');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'README.md (not in any reviewed diff)');
  });

  test('push_denies_whenModeChangedAfterReview', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    repo.write('src/a.py', 'print(1)\n', true);
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'chmod +x');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'src/a.py (content or mode changed after review)');
  });

  test('push_classesABinaryLikeAnyPath_whenNoRuleNamesIt', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, undefined, {
      'assets/logo.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('binary'), Buffer.from([0])]), [TEST_FILE]: ONE_LINE_TEST,
    });
    sandbox.pushBundle(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.deepEqual([line.risk, line.files, line.lines], ['standard', 2, 1]);
  });

  test('push_passesOnApprovalAlone_whenHeavyAndPushesDeploy', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, PUSH_APPROVAL_REGISTRY, { [HEAVY_FILE]: 'x\n', [TEST_FILE]: ONE_LINE_TEST });
    sandbox.fullBundle(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.equal(line.risk, 'heavy');
  });

  test('push_denies_whenFileRenamedAfterReview', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    repo.git('mv', 'src/a.py', 'src/renamed.py');
    repo.git('commit', '-q', '-m', 'rename');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'src/renamed.py (not in any reviewed diff)');
  });

  test('push_passes_afterMergingMain_whenUpstreamTouchedDisjointFile', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    const other = sandbox.clone('acme', 'app', 'other');
    other.commit({ 'docs/other.md': 'disjoint\n' }, 'upstream');
    other.git('push', '-q', 'origin', 'main');
    repo.git('fetch', '-q', 'origin');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_denies_afterMergingMain_whenUpstreamTouchedTheSameFile', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app', undefined, { 'README.md': 'seed\n', 'src/app.py': 'l1\nl2\nl3\nl4\nl5\n' });
    repo.branch('feature');
    repo.commit({ 'src/app.py': 'L1\nl2\nl3\nl4\nl5\n', [TEST_FILE]: ONE_LINE_TEST }, 'top edit');
    sandbox.fullBundle(repo);
    const other = sandbox.clone('acme', 'app', 'other');
    other.commit({ 'src/app.py': 'l1\nl2\nl3\nl4\nL5\n' }, 'bottom edit');
    other.git('push', '-q', 'origin', 'main');
    repo.git('fetch', '-q', 'origin');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'src/app.py (content or mode changed after review)');
  });

  test('push_denies_whenApprovalBelongsToAnotherRoot', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, PUSH_APPROVAL_REGISTRY);
    sandbox.fullBundle(repo, 'rv-root-0001');
    repo.commit({ 'src/a.py': "print('v2')\n" }, 'v2');
    sandbox.review(repo, { runId: 'rv-root-0002' });
    sandbox.testsEvidence(repo);
    const run = sandbox.push(repo, PUSH_FEATURE);
    assertDenied(run, 'K1', 'no approval bound to chain head');
    assert.ok(run.stderr.includes('rv-root-0002'), run.stderr);
  });

  test('push_passes_whenAHeavyChangeIsLarge', (t) => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 11; index++) files[`src/core/billing/f${index}.py`] = 'x\n';
    files[TEST_FILE] = ONE_LINE_TEST;
    const [sandbox, repo] = sandboxAndFeature(t, undefined, files);
    sandbox.pushBundle(repo);
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.deepEqual([line.risk, line.files], ['heavy', 12]);
  });

  test('push_denies_whenGateIsCodeAndEvidenceIsCorrupt', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    writeFileSync(join(dirname(sandbox.evidenceFiles('review')[0]!), 'review-broken.json'), '{not json');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'failing closed');
    assert.equal(sandbox.fires('K1', 'error')[0].repo, 'acme/app');
  });

  test('push_failsClosed_whenGateIsSmokeAndEvidenceIsCorrupt', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, ['acme/app\tsmoke\tmain\t-\tnone']);
    const directory = join(sandbox.data, 'state', 'keel', 'evidence', 'smoke', 'acme__app');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'smoke-broken.json'), '{not json');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'failing closed');
    assert.equal(sandbox.fires('K1', 'error').length, 1);
  });

  test('push_passes_whenRepoGateIsOff', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, ['acme/app\toff\tmain\t-\tnone']);
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_passes_whenRepoIsUnlisted', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, ['acme/other\tcode\tmain\tacme\trequired']);
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
  });

  test('push_passes_whenOutgoingChangeIsEmpty', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const line = assertPassed(sandbox, sandbox.push(repo, 'git push origin main'));
    assert.equal('risk' in line, false);
  });

  test('push_deniesK3_whenRegistryHasNoTestsAndChangeIsStandard', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, ['acme/app\tcode\tmain\tacme\tnone']);
    sandbox.review(repo);
    sandbox.approve('rv-root-0001');
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K3', 'add test infrastructure first');
  });

  test('push_passesWithoutTests_whenRegistryHasNoTestsAndChangeIsLight', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, ['acme/app\tcode\tmain\tacme\tnone'], { 'docs/guide.md': 'light\n' });
    sandbox.review(repo);
    sandbox.approve('rv-root-0001');
    const line = assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE));
    assert.equal(line.risk, 'light');
  });

  test('push_deniesRisk_whenEvenALightChangeHasOnlySingleLensReview', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t, ['acme/app\tcode\tmain\tacme\tnone'], { 'docs/guide.md': 'light\n' });
    sandbox.review(repo, { kind: 'single-lens' });
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'risk', 'every change needs a lens-review chain');
    assert.equal(sandbox.fires('risk', 'deny')[0].risk, 'light');
  });

  test('push_passes_whenAnotherAgentPushes', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    assertPassed(sandbox, sandbox.push(repo, PUSH_FEATURE, { agentId: 'ag-main' }));
  });

  test('push_ignoresExpiredReview_whenTtlPassed', (t) => {
    const [sandbox, repo] = sandboxAndFeature(t);
    sandbox.fullBundle(repo);
    const path = sandbox.evidenceFiles('review')[0]!;
    expireEvidence(path);
    assertDenied(sandbox.push(repo, PUSH_FEATURE), 'K1', 'no review evidence');
  });
});

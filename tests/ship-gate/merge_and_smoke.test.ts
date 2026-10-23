import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { splitlines } from '../../hooks/lib/hookkit/pycompat.ts';
import { KEEL_HOME, LOGIC_WITH_TEST, Repo, Sandbox } from './helpers.ts';

const OVERLAY_REGISTRY = ['acme/overlay\tcode\tmain\toverlay\trequired'];
const OFF_NOTES_REGISTRY = ['acme/app\tcode\tmain\tacme\trequired', 'acme/notes\toff\tmain\t-\tnone'];
const MEASURE_SMOKE = join(KEEL_HOME, 'measure', 'smoke');
const LINK_TOOL = join(KEEL_HOME, 'bin', 'link');
const LEDGER_HEADER = 'id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\tincidents\tmetric\treview_by\tgrace_until\tstatus';
const DAY_MS = 24 * 3600 * 1000;
const DEMO_HOOK = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "if (JSON.parse(fs.readFileSync(0, 'utf8')).tool_input.command.startsWith('bad ')) {",
  "  const logs = path.join(process.env.KEEL_DATA_DIR, 'logs')",
  '  fs.mkdirSync(logs, { recursive: true })',
  "  fs.appendFileSync(path.join(logs, 'keel-fires.jsonl'), JSON.stringify({ rule_id: 'C-demo', outcome: 'deny', hook: 'demo' }) + '\\n')",
  '  process.exit(2)',
  '}',
  '',
].join('\n');
const SHA_A = 'a'.repeat(40);

function isoDate(moment: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

function demoRow(): string {
  return 'C-demo\tcore\tknowledge\tA demo rule.\thook\thook:demo\t-\t-\tdocs/incidents/one.md,docs/incidents/two.md'
    + `\tfires:C-demo\t${isoDate(new Date(Date.now() + 30 * DAY_MS))}\t-\tactive`;
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function lastLine(text: string): string {
  return splitlines(text).at(-1) ?? '';
}

function pullRequest(sandbox: Sandbox, head: string, overrides: Record<string, unknown> = {}): void {
  const body = {
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
    baseRefName: 'main', headRefOid: head, ...overrides,
  };
  writeFileSync(sandbox.ghResponse, JSON.stringify(body));
}

function reviewedFeature(sandbox: Sandbox, files: Record<string, string> = LOGIC_WITH_TEST, approve = true): [Repo, string] {
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  const head = repo.commit(files);
  repo.git('push', '-q', 'origin', 'feature');
  sandbox.review(repo, { head });
  sandbox.testsEvidence(repo);
  if (approve) sandbox.approve('rv-root-0001');
  return [repo, head];
}

function merge(sandbox: Sandbox, repo: Repo, head: string) {
  return sandbox.push(repo, `gh pr merge 7 --squash --match-head-commit ${head}`);
}

describe('MergeScenarioTest', () => {
  test('merge_passes_whenMatchHeadCommitHasCommitRangeReview', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    pullRequest(sandbox, head);
    const run = merge(sandbox, repo, head);
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).head, head);
    assert.ok(readText(sandbox.ghLog).includes('pr view 7 --json statusCheckRollup,baseRefName'));
  });

  test('merge_deniesK1_whenApprovalMissing', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox, LOGIC_WITH_TEST, false);
    pullRequest(sandbox, head);
    const run = merge(sandbox, repo, head);
    assert.equal(run.rc, 2, run.stderr);
    assert.ok(run.stderr.includes('- [K1] no approval bound to chain head'), run.stderr);
    assert.ok(lastLine(run.stderr).startsWith('Run it yourself in your terminal: cd '), run.stderr);
    sandbox.approve('rv-root-0001');
    assert.equal(merge(sandbox, repo, head).rc, 0);
  });

  test('merge_passesOnApprovalAlone_whenHeavy', (t) => {
    const sandbox = new Sandbox(t);
    const files = { 'src/core/billing/a.py': 'x\n', 'tests/test_a.py': 'def test_a(): assert True\n' };
    const [repo, head] = reviewedFeature(sandbox, files);
    pullRequest(sandbox, head);
    const run = merge(sandbox, repo, head);
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).risk, 'heavy');
  });

  test('merge_denies_whenMatchHeadCommitFlagIsMissing', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    pullRequest(sandbox, head);
    const run = sandbox.push(repo, 'gh pr merge 7 --squash');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('- [F-irreversible] gh pr merge needs --match-head-commit'), run.stderr);
    assert.equal(existsSync(sandbox.ghLog), false);
  });

  test('merge_denies_whenChecksAreRed_leavingAClosedPrToGitHub', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    pullRequest(sandbox, head, { state: 'CLOSED', statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE' }] });
    const run = sandbox.push(repo, `gh pr merge 7 --match-head-commit ${head}`);
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('- [F-irreversible] checks not green: ci=FAILURE'), run.stderr);
    assert.ok(!run.stderr.includes('PR is CLOSED'), run.stderr);
  });

  test('merge_withAuto_ignoresPendingChecks_butNotFailedOnes', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    pullRequest(sandbox, head, { statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] });
    assert.equal(sandbox.push(repo, `gh pr merge 7 --auto --match-head-commit ${head}`).rc, 0);
    assert.equal(sandbox.push(repo, `gh pr merge 7 --match-head-commit ${head}`).rc, 2);
  });

  test('merge_denies_whenReviewCoversAnotherCommit', (t) => {
    const sandbox = new Sandbox(t);
    const [repo] = reviewedFeature(sandbox);
    const newer = repo.commit({ 'src/a.py': 'print(2)\n' }, 'after review');
    pullRequest(sandbox, newer);
    const run = sandbox.push(repo, `gh pr merge 7 --match-head-commit ${newer}`);
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('src/a.py (content or mode changed after review)'), run.stderr);
  });

  test('merge_failsClosed_whenGhCannotAnswer', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    writeFileSync(sandbox.ghResponse, 'not json');
    const run = sandbox.push(repo, `gh pr merge 7 --match-head-commit ${head}`);
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('failing closed'), run.stderr);
  });

  test('merge_passes_whenRepoIsOff', (t) => {
    const sandbox = new Sandbox(t, ['acme/app\toff\tmain\t-\tnone']);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.push(repo, 'gh pr merge 7');
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'acme/app');
  });

  test('merge_denies_whenRepoFlagNamesGatedRepoFromAnotherClone', (t) => {
    const sandbox = new Sandbox(t);
    const other = sandbox.clone('acme', 'other');
    const run = sandbox.push(other, 'gh pr merge 7 --repo acme/app --squash');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [F-irreversible] run gh pr merge from a clone of acme/app'), run.stderr);
    assert.equal(existsSync(sandbox.ghLog), false);
    assert.equal(sandbox.fires('F-irreversible', 'deny').at(-1).repo, 'acme/app');
    assert.equal(sandbox.fires('risk', 'pass').length, 0);
  });

  test('merge_denies_whenRepoFlagNamesGatedRepoFromAnotherClone_evenWithMatchHead', (t) => {
    const sandbox = new Sandbox(t);
    const other = sandbox.clone('acme', 'other');
    const run = sandbox.push(other, `gh pr merge 7 -R acme/app --match-head-commit ${SHA_A}`);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('run gh pr merge from a clone of acme/app'), run.stderr);
    assert.equal(existsSync(sandbox.ghLog), false);
  });

  test('merge_passes_whenRepoFlagNamesOffOrUnlistedRepoFromGatedClone', (t) => {
    const sandbox = new Sandbox(t, ['acme/app\tcode\tmain\tacme\trequired', 'acme/other\toff\tmain\t-\tnone']);
    const repo = sandbox.clone('acme', 'app');
    assert.equal(sandbox.push(repo, 'gh pr merge 7 --repo acme/other').rc, 0);
    assert.equal(sandbox.push(repo, 'gh pr merge 7 --repo=acme/unlisted').rc, 0);
    assert.deepEqual(sandbox.fires('risk', 'pass').map((line) => line.repo), ['acme/other', 'acme/unlisted']);
  });

  test('merge_gates_whenRepoFlagNamesTheCloneItself', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    pullRequest(sandbox, head);
    const run = sandbox.push(repo, `gh pr merge 7 --repo github.com/ACME/app --match-head-commit ${head}`);
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'acme/app');
    assert.ok(readText(sandbox.ghLog).includes('--repo github.com/ACME/app'));
  });

  test('merge_failsClosed_whenRepoFlagIsNotOwnerSlashRepo', (t) => {
    const sandbox = new Sandbox(t);
    const other = sandbox.clone('acme', 'other');
    const run = sandbox.push(other, `gh pr merge 7 --repo app --match-head-commit ${SHA_A}`);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('failing closed'), run.stderr);
    assert.equal(existsSync(sandbox.ghLog), false);
  });

  function assertForeignMergeDenied(sandbox: Sandbox, clone: Repo, command: string): void {
    const run = sandbox.push(clone, command);
    assert.equal(run.rc, 2, `${command}: ${run.stderr}${run.stdout}`);
    assert.ok(run.stderr.includes(`- [F-irreversible] run gh pr merge from a clone of acme/app (this clone is ${clone.key})`), run.stderr);
    assert.equal(existsSync(sandbox.ghLog), false);
    assert.equal(sandbox.fires('F-irreversible', 'deny').at(-1).repo, 'acme/app');
    assert.equal(sandbox.fires('risk', 'pass').length, 0);
  }

  test('merge_denies_whenPullUrlNamesGatedRepoFromOffClone', (t) => {
    const sandbox = new Sandbox(t, OFF_NOTES_REGISTRY);
    const notes = sandbox.clone('acme', 'notes');
    assertForeignMergeDenied(sandbox, notes, `gh pr merge https://github.com/acme/app/pull/7 --squash --match-head-commit ${SHA_A}`);
  });

  test('merge_denies_whenGhRepoEnvNamesGatedRepoFromOffClone', (t) => {
    const sandbox = new Sandbox(t, OFF_NOTES_REGISTRY);
    const notes = sandbox.clone('acme', 'notes');
    assertForeignMergeDenied(sandbox, notes, 'GH_REPO=acme/app gh pr merge 7 --squash');
  });

  test('merge_denies_whenPullUrlNamesGatedRepoFromUnlistedClone', (t) => {
    const sandbox = new Sandbox(t);
    const unlisted = sandbox.clone('acme', 'zzz');
    assertForeignMergeDenied(sandbox, unlisted, 'gh pr merge https://github.com/acme/app/pull/7 --squash');
  });

  test('merge_denies_whenExportedGhRepoNamesGatedRepoFromUnlistedClone', (t) => {
    const sandbox = new Sandbox(t);
    const unlisted = sandbox.clone('acme', 'zzz');
    assertForeignMergeDenied(sandbox, unlisted, 'export GH_REPO=acme/app; gh pr merge 7 --squash');
  });

  test('merge_gates_whenPullUrlNamesTheCloneItself', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    pullRequest(sandbox, head);
    const run = sandbox.push(repo, `gh pr merge https://github.com/acme/app/pull/7 --match-head-commit ${head}`);
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'acme/app');
    assert.ok(readText(sandbox.ghLog).includes('pr view https://github.com/acme/app/pull/7 --json'));
  });

  test('merge_gates_whenGhRepoEnvNamesTheCloneItself', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    pullRequest(sandbox, head);
    const run = sandbox.push(repo, `GH_REPO=github.com/ACME/app gh pr merge 7 --match-head-commit ${head}`);
    assert.equal(run.rc, 0, run.stderr);
    assert.ok(readText(sandbox.ghLog).includes('GH_REPO=github.com/ACME/app pr view 7 --json'));
  });
});

function overlayChange(sandbox: Sandbox, files: Record<string, string>): Repo {
  const repo = sandbox.clone('acme', 'overlay', undefined, { 'ledger.tsv': 'id\n', 'settings/a.json': '{}\n', 'bin/tool': '#!/bin/sh\n' });
  repo.branch('feature');
  repo.commit(files);
  return repo;
}

describe('SmokeScenarioTest', () => {
  test('smokeOnlyPush_passes_whenSmokeEvidenceCoversTheTree', (t) => {
    const sandbox = new Sandbox(t, OVERLAY_REGISTRY);
    const repo = overlayChange(sandbox, { 'settings/a.json': '{"x": 1}\n' });
    const written = sandbox.smokeEvidence(repo);
    assert.equal(written.rc, 0, written.stderr);
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).risk, 'smoke-only');
  });

  test('smokeOnlyPush_denies_whenSmokeEvidenceIsMissing', (t) => {
    const sandbox = new Sandbox(t, OVERLAY_REGISTRY);
    const repo = overlayChange(sandbox, { 'settings/a.json': '{"x": 1}\n' });
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('- [risk] no smoke evidence covers this exact content'), run.stderr);
  });

  test('smokeOnlyPush_denies_whenSmokeEvidenceCoversAnotherTree', (t) => {
    const sandbox = new Sandbox(t, OVERLAY_REGISTRY);
    const repo = overlayChange(sandbox, { 'settings/a.json': '{"x": 1}\n' });
    sandbox.smokeEvidence(repo, true, repo.tree('origin/main'));
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('no smoke evidence covers'), run.stderr);
  });

  test('mixedPush_needsReview_whenACodePathJoinsSmokeOnlyPaths', (t) => {
    const sandbox = new Sandbox(t, OVERLAY_REGISTRY);
    const repo = overlayChange(sandbox, { 'settings/a.json': '{"x": 1}\n', 'bin/tool': '#!/bin/sh\necho hi\n' });
    sandbox.smokeEvidence(repo);
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('- [K1] no review evidence for acme/overlay'), run.stderr);
    assert.equal(sandbox.fires('K1', 'deny')[0].risk, 'standard');
  });

  test('smokeGate_needsOnlySmokeEvidence_forAnyPath', (t) => {
    const sandbox = new Sandbox(t, ['acme/overlay\tsmoke\tmain\t-\tnone']);
    const repo = overlayChange(sandbox, { 'bin/tool': '#!/bin/sh\necho hi\n' });
    assert.equal(sandbox.push(repo, 'git push origin feature').rc, 2);
    sandbox.smokeEvidence(repo);
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 0, run.stderr);
  });
});

function demoFixture(command: string, expectation = ''): string {
  const fixture: Record<string, unknown> = {
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },
  };
  if (expectation) fixture['expect'] = expectation;
  return JSON.stringify(fixture);
}

function smokeReadyKeel(sandbox: Sandbox): Repo {
  const keel = new Repo(sandbox, join(sandbox.root, 'keel-under-smoke'), 'example/keel');
  mkdirSync(keel.path);
  keel.git('init', '-q');
  keel.git('remote', 'add', 'origin', 'https://example.invalid/example/keel.git');
  const demoRegistration = { type: 'command', command: 'node {{KEEL}}/hooks/demo/demo.js' };
  keel.commit({
    'ledger.tsv': LEDGER_HEADER + '\n' + demoRow() + '\n',
    'docs/incidents/one.md': 'First incident.\n',
    'docs/incidents/two.md': 'Second incident.\n',
    'PRINCIPLES.md': '# Principles\n\n- [C-demo] A demo rule.\n',
    'skills/demo/SKILL.md': '# Demo\n\n## Rules\n\n- [C-demo] Tagged.\n',
    'hooks/demo/demo.js': DEMO_HOOK,
    'tests/hooks/fixtures/C-demo.bad.json': demoFixture('bad C-demo', 'deny'),
    'tests/hooks/fixtures/demo.good.json': demoFixture('ls'),
    'settings/core.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [demoRegistration] }] } }),
  }, 'seed keel');
  const logs = join(sandbox.data, 'logs');
  mkdirSync(logs, { recursive: true });
  const fire = { ts: isoDate(new Date()) + 'T09:00:00Z', rule_id: 'C-demo', hook: 'demo', outcome: 'deny', session: '-' };
  appendFileSync(join(logs, 'keel-fires.jsonl'), JSON.stringify(fire) + '\n');
  return keel;
}

function noPluginsClaude(sandbox: Sandbox): string {
  const path = join(sandbox.root, 'stubs', 'claude-no-plugins');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/bash\necho '[]'\n");
  chmodSync(path, 0o755);
  return path;
}

function runTool(sandbox: Sandbox, argv: string[], keel: Repo, overlay: Repo): SpawnSyncReturns<string> {
  const env = { ...sandbox.env, KEEL_HOME: keel.path, KEEL_OVERLAY_DIR: overlay.path, KEEL_LINK: LINK_TOOL, KEEL_CLAUDE: noPluginsClaude(sandbox) };
  const [program, ...args] = argv;
  return spawnSync(program!, args, { encoding: 'utf8', env });
}

describe('CandidateSmokeScenarioTest', () => {
  test('smokeOnlyPush_passes_fromAnOverlayWorktree_withCandidateSmokeEvidence', (t: TestContext) => {
    const sandbox = new Sandbox(t, OVERLAY_REGISTRY);
    const keel = smokeReadyKeel(sandbox);
    const overlay = sandbox.clone('acme', 'overlay', undefined, {
      'boundary/lexicon.txt': 'ACMECORP\n', 'settings/a.json': '{"env": {"EXAMPLE_MODE": "old"}}\n',
    });
    const linked = runTool(sandbox, [LINK_TOOL, '--write'], keel, overlay);
    assert.equal(linked.status, 0, linked.stderr);
    const worktree = new Repo(sandbox, join(sandbox.root, 'repos', 'overlay-wt'), overlay.key);
    overlay.git('worktree', 'add', '-q', '-b', 'feature', worktree.path);
    worktree.commit({ 'settings/a.json': '{"env": {"EXAMPLE_MODE": "new"}}\n' });

    const smoke = runTool(sandbox, [MEASURE_SMOKE, '--candidate'], keel, worktree);
    const written = sandbox.keel(['evidence', 'write-smoke', '--repo', worktree.path]);
    const run = sandbox.push(worktree, 'git push origin feature');

    assert.equal(smoke.status, 0, smoke.stderr);
    assert.equal(written.rc, 0, written.stderr);
    assert.equal(written.json.tree, worktree.tree());
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).risk, 'smoke-only');
  });
});

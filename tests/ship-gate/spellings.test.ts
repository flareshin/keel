import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { mayPushOrMerge, parseMerge } from '../../hooks/ship-gate/ship-gate.ts';
import { KEEL_HOME, LOGIC_WITH_TEST, Run, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const FIXTURE = join(KEEL_HOME, 'tests', 'fixtures', 'push-merge-spellings.tsv');
const GIT_GUARD = join(KEEL_HOME, 'hooks', 'git-guard', 'git-guard.ts');
const EXPECTATIONS = ['gate', 'pass', 'deny'];
const GATED_CLONE = 'gated';
const FORK_CLONE = 'fork';
const FORK_ORIGIN_CLONE = 'fork-origin';
const CLONES = [GATED_CLONE, FORK_CLONE, FORK_ORIGIN_CLONE];
const MIN_ROWS = 25;
const ATTRIBUTION_TRAILER = 'Co-Authored-By: Claude <noreply@example.invalid>';
const UNATTRIBUTABLE = '- [K1] cannot attribute this push or merge';
const RUN_YOURSELF = 'Run it yourself in your terminal: ';

interface Row {
  command: string;
  expect: string;
  note: string;
  clone: string;
}

function loadRows(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('command\t')) continue;
    const [command, expect, note, clone] = line.split('\t');
    rows.push({ command: command!.replaceAll('\\n', '\n'), expect: expect!, note: note!, clone: clone ?? GATED_CLONE });
  }
  return rows;
}

const ROWS = loadRows();

interface Fixture {
  sandbox: Sandbox;
  repo: Repo;
  head: string;
  elsewhere: string;
}

function fixtureRepo(t: TestContext, commitMessage = 'feature'): Fixture {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  const head = repo.commit(LOGIC_WITH_TEST, commitMessage);
  repo.git('tag', 'tmp');
  writeFileSync(sandbox.ghResponse, JSON.stringify({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], baseRefName: 'main', headRefOid: head,
  }));
  const elsewhere = join(sandbox.root, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  return { sandbox, repo, head, elsewhere };
}

function forkClone(sandbox: Sandbox, name: string, pushRemote: string | null): [Repo, string] {
  const fork = sandbox.clone('me', 'app', name);
  fork.git('remote', 'add', 'upstream', sandbox.remote('acme', 'app'));
  fork.branch('feature');
  const head = fork.commit(LOGIC_WITH_TEST, 'feature');
  if (pushRemote) fork.git('config', 'branch.feature.pushRemote', pushRemote);
  return [fork, head];
}

function filled(command: string, fixture: Fixture, repo: Repo, head: string): string {
  return command.replaceAll('{repo}', repo.path).replaceAll('{tmp}', fixture.elsewhere).replaceAll('{head}', head);
}

function gitGuard(sandbox: Sandbox, repo: Repo, command: string): Run {
  const completed = spawnSync(process.execPath, [GIT_GUARD], {
    input: JSON.stringify(sandbox.bashPayload(repo, command)), encoding: 'utf8', env: sandbox.env,
  });
  return new Run(completed.status ?? -1, completed.stdout, completed.stderr);
}

function assertDeniedForMissingEvidence(run: Run, label: string): void {
  assert.equal(run.rc, 2, label + run.stderr + run.stdout);
  assert.ok(run.stderr.includes('- [K1] no review evidence for acme/app'), label + run.stderr);
  assert.ok(run.stderr.includes(RUN_YOURSELF), label + run.stderr);
}

function assertDeniedAsUnattributable(run: Run, label: string): void {
  assert.equal(run.rc, 2, label + run.stderr + run.stdout);
  assert.ok(run.stderr.includes(UNATTRIBUTABLE) || run.stderr.includes('- [F-irreversible]'), label + run.stderr);
  assert.ok(!run.stderr.includes('- [K1] no review evidence'), label + run.stderr);
  assert.ok(run.stderr.includes(RUN_YOURSELF), label + run.stderr);
}

describe('SpellingTableTest', () => {
  test('table_hasEnoughRows_withKnownExpectations', () => {
    assert.ok(ROWS.length >= MIN_ROWS);
    assert.ok(ROWS.every((row) => EXPECTATIONS.includes(row.expect)), ROWS.map((row) => row.expect).join());
    assert.ok(ROWS.every((row) => CLONES.includes(row.clone)), ROWS.map((row) => row.clone).join());
    assert.equal(new Set(ROWS.map((row) => `${row.command}\u0000${row.clone}`)).size, ROWS.length, 'duplicate commands');
  });

  test('everySpelling_getsItsExpectedVerdict', (t) => {
    const fixture = fixtureRepo(t);
    const { sandbox } = fixture;
    const clones: Record<string, [Repo, string]> = {
      [GATED_CLONE]: [fixture.repo, fixture.head],
      [FORK_CLONE]: forkClone(sandbox, 'fork', 'upstream'),
      [FORK_ORIGIN_CLONE]: forkClone(sandbox, 'fork-origin', null),
    };
    for (const row of ROWS) {
      const label = `${row.command} (${row.note}, ${row.clone}): `;
      const passes = sandbox.fires('risk', 'pass').length;
      const denies = sandbox.fires(undefined, 'deny').length;
      const [clone, cloneHead] = clones[row.clone]!;
      const run = sandbox.push(clone, filled(row.command, fixture, clone, cloneHead));
      assert.ok(!run.stderr.includes('Traceback'), label + run.stderr);
      if (row.expect === 'gate') {
        assertDeniedForMissingEvidence(run, label);
      } else if (row.expect === 'deny') {
        assertDeniedAsUnattributable(run, label);
      } else {
        assert.equal(run.rc, 0, label + run.stderr + run.stdout);
        assert.equal(sandbox.fires(undefined, 'deny').length, denies, label + 'a pass spelling logged a deny');
      }
      if (row.expect !== 'pass') assert.equal(sandbox.fires('risk', 'pass').length, passes, label + 'a denied spelling logged a pass');
    }
  });

  test('gateSpellings_pass_whenABundleCoversTheBranch', (t) => {
    const fixture = fixtureRepo(t);
    const { sandbox, repo, head } = fixture;
    sandbox.fullBundle(repo);
    for (const row of ROWS) {
      if (row.expect !== 'gate' || row.clone !== GATED_CLONE) continue;
      const run = sandbox.push(repo, filled(row.command, fixture, repo, head));
      assert.equal(run.rc, 0, `${row.command}: ${run.stderr}${run.stdout}`);
      const line = sandbox.fires('risk', 'pass').at(-1);
      assert.deepEqual([line.repo, line.head, line.risk], ['acme/app', head, 'standard'], row.command);
    }
  });

  test('gateSpellings_areScannedByGitGuard_whenTheRangeCarriesAttribution', (t) => {
    const fixture = fixtureRepo(t, 'Add feature\n\n' + ATTRIBUTION_TRAILER);
    const { sandbox, repo, head } = fixture;
    for (const row of ROWS) {
      if (row.expect !== 'gate' || row.clone !== GATED_CLONE || !row.command.includes('push')) continue;
      const run = gitGuard(sandbox, repo, filled(row.command, fixture, repo, head));
      assert.equal(run.rc, 2, `${row.command}: ${run.stderr}${run.stdout}`);
      assert.ok(run.stderr.includes('[F-attribution]'), `${row.command}: ${run.stderr}`);
    }
  });

  test('parseMerge_readsTheRepo_whenTheFlagValueIsAttached', () => {
    for (const flag of ['-Racme/app', '-R=acme/app', '--repo=acme/app']) {
      const merge = parseMerge(['gh', 'pr', 'merge', '7', flag], '/nowhere', null);
      assert.equal(merge.repoFlag, 'acme/app', flag);
    }
  });

  test('crashFallback_readsEveryGateAndDenySpelling_asAPushOrMerge', () => {
    for (const row of ROWS) {
      if (row.expect === 'pass') continue;
      assert.equal(mayPushOrMerge(row.command), true, `${row.command} (${row.note})`);
    }
  });
});

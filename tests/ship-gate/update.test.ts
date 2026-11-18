import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { describeUpdate, updateCheckout } from '../../lib/evidence/update.ts';
import { Refused } from '../../lib/evidence/writers.ts';
import { KEEL_HOME, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const manifest = (version: string): Record<string, string> => ({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'keel', version }) + '\n' });

function publish(publisher: Repo, version: string): string {
  const head = publisher.commit(manifest(version), `release ${version}`);
  publisher.git('push', '-q', 'origin', 'main');
  return head;
}

function runKeelFrom(sandbox: Sandbox, install: Repo): void {
  for (const folder of ['lib', 'measure']) symlinkSync(join(KEEL_HOME, folder), join(install.path, folder));
  sandbox.env['KEEL_HOME'] = install.path;
}

function publisherAndInstall(t: TestContext): { sandbox: Sandbox; publisher: Repo; install: Repo; installedHead: string } {
  const sandbox = new Sandbox(t);
  const publisher = sandbox.clone('flareshin', 'keel', 'publisher');
  const installedHead = publish(publisher, '1.0.0');
  const install = sandbox.clone('flareshin', 'keel', 'install');
  return { sandbox, publisher, install, installedHead };
}

test('updateCheckout_fastForwardsToTheRemoteRelease_andReportsBothVersions', (t) => {
  const { publisher, install, installedHead } = publisherAndInstall(t);
  const releasedHead = publish(publisher, '1.1.2');

  const result = updateCheckout(install.path);

  assert.deepEqual(result, {
    home: install.path, updated: true,
    before: { version: '1.0.0', head: installedHead }, after: { version: '1.1.2', head: releasedHead },
  });
  assert.equal(install.head(), releasedHead);
});

test('updateCheckout_changesNothing_whenTheCheckoutAlreadyHoldsTheRemoteHead', (t) => {
  const { install, installedHead } = publisherAndInstall(t);

  const result = updateCheckout(install.path);

  assert.equal(result.updated, false);
  assert.deepEqual(result.after, { version: '1.0.0', head: installedHead });
  assert.equal(install.head(), installedHead);
});

test('updateCheckout_refusesAndKeepsTheCheckout_whenLocalCommitsDiverge', (t) => {
  const { publisher, install } = publisherAndInstall(t);
  publish(publisher, '1.1.2');
  const localHead = install.commit({ 'local.txt': 'mine\n' });

  assert.throws(() => updateCheckout(install.path), Refused);
  assert.equal(install.head(), localHead);
});

test('updateCheckout_refuses_whenTheCheckoutIsOnNoBranch', (t) => {
  const { publisher, install, installedHead } = publisherAndInstall(t);
  publish(publisher, '1.1.2');
  install.git('checkout', '-q', '--detach', installedHead);

  assert.throws(() => updateCheckout(install.path), Refused);
  assert.equal(install.head(), installedHead);
});

test('updateCheckout_refusesAndKeepsTheCheckout_whenThePullOutlivesItsTimeout', (t) => {
  const { install, installedHead } = publisherAndInstall(t);
  install.git('config', 'protocol.ext.allow', 'always');
  install.git('remote', 'set-url', 'origin', 'ext::sleep 30');

  assert.throws(() => updateCheckout(install.path, 0.5), (error: unknown) => error instanceof Refused && /did not finish within 0\.5 s/.test(error.message));
  assert.equal(install.head(), installedHead);
});

test('updateCheckout_refuses_whenTheFolderIsNoGitCheckout', () => {
  const folder = mkdtempSync(join(tmpdir(), 'keel-update-'));

  assert.throws(() => updateCheckout(folder), /is not the root of a git checkout/);
});

test('updateCheckout_refuses_whenGivenAFolderInsideTheCheckout', (t) => {
  const { install } = publisherAndInstall(t);

  assert.throws(() => updateCheckout(join(install.path, '.claude-plugin')), /is not the root of a git checkout/);
});

test('describeUpdate_namesBothVersionsAndTheNextStep_whenTheCheckoutMoved', () => {
  const line = describeUpdate({
    home: '/x', updated: true,
    before: { version: '1.0.0', head: 'a'.repeat(40) }, after: { version: '1.1.2', head: 'b'.repeat(40) },
  });

  assert.equal(line, 'keel moved from 1.0.0 (aaaaaaaaaa) to 1.1.2 (bbbbbbbbbb); '
    + 'start a new Claude Code session or run /reload-plugins to load it, then run bin/link --check');
});

test('describeUpdate_saysAlreadyLatest_whenNothingMoved', () => {
  const state = { version: null, head: 'c'.repeat(40) };

  assert.equal(describeUpdate({ home: '/x', updated: false, before: state, after: state }),
    'keel is already at the latest version, no version (cccccccccc)');
});

test('keelUpdate_isAUsageError_whenGivenAnArgument', (t) => {
  const run = new Sandbox(t).keel(['update', 'now']);

  assert.equal(run.rc, 2, run.stderr);
  assert.match(run.stderr, /keel update takes no arguments/);
});

test('keelUpdate_printsTheResultAndItsDescription_andExitsZero_whenTheCheckoutMoves', (t) => {
  const { sandbox, publisher, install, installedHead } = publisherAndInstall(t);
  const releasedHead = publish(publisher, '1.1.2');
  runKeelFrom(sandbox, install);

  const run = sandbox.keel(['update']);

  assert.equal(run.rc, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    home: install.path, updated: true,
    before: { version: '1.0.0', head: installedHead }, after: { version: '1.1.2', head: releasedHead },
  });
  assert.equal(run.stderr, `keel moved from 1.0.0 (${installedHead.slice(0, 10)}) to 1.1.2 (${releasedHead.slice(0, 10)}); `
    + 'start a new Claude Code session or run /reload-plugins to load it, then run bin/link --check\n');
});

test('keelUpdate_exitsThreeWithTheRefusal_whenLocalCommitsDiverge', (t) => {
  const { sandbox, publisher, install } = publisherAndInstall(t);
  publish(publisher, '1.1.2');
  install.commit({ 'local.txt': 'mine\n' });
  runKeelFrom(sandbox, install);

  const run = sandbox.keel(['update']);

  assert.equal(run.rc, 3, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^keel: refused: git pull --ff-only in .+ failed and left the checkout as it was: /);
});

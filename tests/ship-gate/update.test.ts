import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { describeUpdate, updateCheckout } from '../../lib/evidence/update.ts';
import { Refused } from '../../lib/evidence/writers.ts';
import { Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const manifest = (version: string): Record<string, string> => ({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'keel', version }) + '\n' });

function publish(publisher: Repo, version: string): string {
  const head = publisher.commit(manifest(version), `release ${version}`);
  publisher.git('push', '-q', 'origin', 'main');
  return head;
}

function publisherAndInstall(t: TestContext): { publisher: Repo; install: Repo; installedHead: string } {
  const sandbox = new Sandbox(t);
  const publisher = sandbox.clone('flareshin', 'keel', 'publisher');
  const installedHead = publish(publisher, '1.0.0');
  const install = sandbox.clone('flareshin', 'keel', 'install');
  return { publisher, install, installedHead };
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

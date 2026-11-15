import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { RETIRED_PREFIX, trim } from '../../lib/evidence/compile-cache.ts';

const LIMIT_BYTES = 1000;
const CURRENT_VERSION = `${process.version}-${process.arch}-310b2ce3-399993245`;
const OLDER_NODE_VERSION = 'v20.11.0-arm64-0a1b2c3d-11223344';
const REMOVAL_DEADLINE_MS = 10_000;
const POLL_MS = 20;
const OTHER_ARCH_VERSION = `${process.version}-x64-310b2ce3-399993245`;

function cacheRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'keel-compile-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'node-compile-cache');
}

function fill(root: string, version: string, sizes: Record<string, number>): void {
  mkdirSync(join(root, version), { recursive: true });
  for (const [name, size] of Object.entries(sizes)) writeFileSync(join(root, version, name), Buffer.alloc(size, 1));
}

async function listingAfterRemoval(root: string): Promise<string[]> {
  const deadline = Date.now() + REMOVAL_DEADLINE_MS;
  let listing = readdirSync(root);
  while (listing.some((name) => name.startsWith(RETIRED_PREFIX)) && Date.now() < deadline) {
    await sleep(POLL_MS);
    listing = readdirSync(root);
  }
  return listing;
}

describe('CompileCacheTrimTest', () => {
  test('trim_removesOtherNodeVersions_keepsCurrentVersion', async (t) => {
    const root = cacheRoot(t);
    fill(root, OLDER_NODE_VERSION, { a: 100, b: 50 });
    fill(root, OTHER_ARCH_VERSION, { c: 7 });
    fill(root, CURRENT_VERSION, { d: 40 });
    const removed = trim(root, LIMIT_BYTES);
    assert.deepEqual(removed, { files: 3, bytes: 157 });
    assert.deepEqual(await listingAfterRemoval(root), [CURRENT_VERSION]);
    assert.deepEqual(readdirSync(join(root, CURRENT_VERSION)), ['d']);
  });

  test('trim_keepsCurrentVersion_whenSizeEqualsLimit', (t) => {
    const root = cacheRoot(t);
    fill(root, CURRENT_VERSION, { a: 600, b: 400 });
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 0, bytes: 0 });
    assert.deepEqual(readdirSync(join(root, CURRENT_VERSION)).sort(), ['a', 'b']);
  });

  test('trim_removesCurrentVersion_whenSizeExceedsLimit', async (t) => {
    const root = cacheRoot(t);
    fill(root, CURRENT_VERSION, { a: 600, b: 401 });
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 2, bytes: 1001 });
    assert.deepEqual(await listingAfterRemoval(root), []);
  });

  test('trim_addsOtherVersionsToOverflow_whenBothApply', async (t) => {
    const root = cacheRoot(t);
    fill(root, OLDER_NODE_VERSION, { a: 100 });
    fill(root, CURRENT_VERSION, { b: 600, c: 401 });
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 3, bytes: 1101 });
    assert.deepEqual(await listingAfterRemoval(root), []);
  });

  test('trim_countsFilesInNestedFolders', async (t) => {
    const root = cacheRoot(t);
    fill(root, join(OLDER_NODE_VERSION, 'deep'), { a: 10 });
    fill(root, OLDER_NODE_VERSION, { b: 5 });
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 2, bytes: 15 });
    assert.deepEqual(await listingAfterRemoval(root), []);
  });

  test('trim_leavesAFileThatIsNotAVersionFolder', async (t) => {
    const root = cacheRoot(t);
    fill(root, OLDER_NODE_VERSION, { a: 10 });
    writeFileSync(join(root, 'notes.txt'), 'keep');
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 1, bytes: 10 });
    assert.deepEqual(await listingAfterRemoval(root), ['notes.txt']);
  });

  test('trim_finishesAnEarlierRemoval_whenARetiredFolderWasLeftBehind', async (t) => {
    const root = cacheRoot(t);
    fill(root, `${RETIRED_PREFIX}1-${OLDER_NODE_VERSION}`, { a: 9 });
    fill(root, CURRENT_VERSION, { b: 40 });
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 1, bytes: 9 });
    assert.deepEqual(await listingAfterRemoval(root), [CURRENT_VERSION]);
  });

  test('trim_removesNothing_whenCacheFolderIsMissing', (t) => {
    const root = cacheRoot(t);
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 0, bytes: 0 });
    assert.equal(existsSync(root), false);
  });
});

describe('CompileCacheConcurrentTrimTest', () => {
  function replaceRename(t: TestContext, replacement: (from: string, to: string) => void): void {
    const mocked = t.mock.method(fs, 'renameSync', replacement);
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
  }

  test('trim_skipsAFolderAnotherRunRetired_andRemovesTheRest', (t) => {
    const root = cacheRoot(t);
    fill(root, OLDER_NODE_VERSION, { a: 100, b: 50 });
    fill(root, OTHER_ARCH_VERSION, { c: 7 });
    fill(root, CURRENT_VERSION, { d: 40 });
    const victim = join(root, OLDER_NODE_VERSION);
    const renameSync = fs.renameSync;
    replaceRename(t, (from, to) => {
      if (from === victim) renameSync(from, join(root, `${RETIRED_PREFIX}other-run`));
      renameSync(from, to);
    });
    assert.deepEqual(trim(root, LIMIT_BYTES), { files: 1, bytes: 7 });
    const listing = readdirSync(root);
    assert.ok(listing.includes(`${RETIRED_PREFIX}other-run`), listing.join(' | '));
    assert.ok(listing.includes(CURRENT_VERSION), listing.join(' | '));
  });

  test('trim_throws_whenRetiringFailsForAnotherReason', (t) => {
    const root = cacheRoot(t);
    fill(root, OLDER_NODE_VERSION, { a: 100 });
    replaceRename(t, () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    assert.throws(() => trim(root, LIMIT_BYTES), /denied/);
  });
});

describe('NodeCacheRemovalTest', () => {
  test('node_finishesCleanly_whenCacheFolderIsRemovedWhileItRuns', (t) => {
    const root = cacheRoot(t);
    const modules = join(root, '..', 'modules');
    mkdirSync(modules);
    writeFileSync(join(modules, 'first.mjs'), 'export const first = 1;\n');
    writeFileSync(join(modules, 'second.mjs'), 'export const second = 2;\n');
    const script = [
      "import { rmSync } from 'node:fs';",
      "await import('./first.mjs');",
      `rmSync(${JSON.stringify(root)}, { recursive: true, force: true });`,
      "const { second } = await import('./second.mjs');",
      'process.stdout.write(String(second));',
    ].join('\n');
    writeFileSync(join(modules, 'main.mjs'), script);
    const run = spawnSync(process.execPath, [join(modules, 'main.mjs')], {
      env: { ...process.env, NODE_COMPILE_CACHE: root }, encoding: 'utf8',
    });
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '2', '']);
  });

  test('node_recreatesCacheFolder_onTheNextStart_afterTrimRemovedIt', async (t) => {
    const root = cacheRoot(t);
    const module = join(root, '..', 'hello.mjs');
    writeFileSync(module, 'console.log("hello");\n');
    fill(root, CURRENT_VERSION, { a: LIMIT_BYTES + 1 });
    trim(root, LIMIT_BYTES);
    await listingAfterRemoval(root);
    const run = spawnSync(process.execPath, [module], { env: { ...process.env, NODE_COMPILE_CACHE: root }, encoding: 'utf8' });
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, 'hello\n', '']);
    assert.equal(readdirSync(root).length, 1);
  });
});

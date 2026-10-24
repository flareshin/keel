import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { splitAtEveryLineBreak } from '../../measure/lib/measurekit/files.ts';
import { splitlines } from '../../hooks/lib/hookkit/pycompat.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import { Sandbox } from './helpers.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'keel-git-data-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const NEXT_LINE = String.fromCharCode(0x85);
const INFORMATION_SEPARATOR_FOUR = String.fromCharCode(0x1c);
const NO_BREAK_SPACE = String.fromCharCode(0xa0);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const EDGE_CHARACTERS = [NEXT_LINE, INFORMATION_SEPARATOR_FOUR, BYTE_ORDER_MARK, NO_BREAK_SPACE];

function newRepo(): string {
  const repo = mkdtempSync(join(scratch, 'repo-'));
  assert.equal(spawnSync('git', ['-C', repo, 'init', '-q']).status, 0);
  return repo;
}

function git(repo: string, ...args: string[]): void {
  assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0, args.join(' '));
}

describe('git output is data: only its final newline is removed', () => {
  for (const edge of EDGE_CHARACTERS) {
    test('a remote url, a config value and a toplevel path ending in ' + JSON.stringify(edge) + ' are read exactly', () => {
      const repo = newRepo();
      const url = 'https://example.com/acme/app' + edge;
      git(repo, 'remote', 'add', 'origin', url);
      assert.equal(gitcmd.originUrl(repo), url);
      git(repo, 'config', 'remote.origin.gh-resolved', 'acme/app' + edge);
      assert.deepEqual(gitcmd.ghDefaultRemote(repo), { remote: 'origin', resolved: 'acme/app' + edge });
      git(repo, 'config', 'remote.pushDefault', 'mirror' + edge);
      assert.equal(gitcmd.pushRemote(repo), 'mirror' + edge);
      git(repo, 'config', 'custom.note', 'kept' + edge);
      assert.equal(gitcmd.text(repo, ['config', '--get', 'custom.note']), 'kept' + edge);
    });
  }

  for (const edge of [NEXT_LINE, INFORMATION_SEPARATOR_FOUR]) {
    test('the toplevel of a directory whose name ends in ' + JSON.stringify(edge) + ' keeps that name', () => {
      const directory = join(scratch, 'dir-' + Math.random().toString(16).slice(2) + edge);
      mkdirSync(directory);
      git(directory, 'init', '-q');
      assert.equal(gitcmd.toplevel(directory), realpathSync(directory));
    });
  }

  test('a remote name holding U+FEFF stays one name', () => {
    const repo = newRepo();
    git(repo, 'remote', 'add', 'origin', 'https://example.com/me/app');
    git(repo, 'remote', 'add', 'up' + BYTE_ORDER_MARK + 'stream', 'https://example.com/acme/app');
    assert.deepEqual(gitcmd.remotes(repo), ['origin', 'up' + BYTE_ORDER_MARK + 'stream']);
  });

  test('a gated repo behind a remote named with U+FEFF still stops a merge that names no repo', (t) => {
    const sandbox = new Sandbox(t);
    sandbox.clone('acme', 'app');
    const fork = sandbox.clone('me', 'app', 'fork');
    fork.git('remote', 'add', 'up' + BYTE_ORDER_MARK + 'stream', sandbox.remote('acme', 'app'));
    fork.branch('feature');
    const head = fork.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' }, 'fork work');
    const command = 'gh pr merge 7 --squash --match-head-commit ' + head;
    const run = sandbox.push(fork, command);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [K1] cannot attribute this push or merge'), run.stderr);
    assert.ok(run.stderr.includes('acme/app, me/app'), run.stderr);
  });
});

describe('the line splitter for push urls', () => {
  const breaks = ['\n', '\r', '\r\n', '\v', '\f', '\x1c', '\x1d', '\x1e', NEXT_LINE, LINE_SEPARATOR, PARAGRAPH_SEPARATOR];

  test('splits exactly where the hook splitlines does, at every line break character', () => {
    for (const lineBreak of breaks) {
      for (const text of ['a' + lineBreak + 'b', 'a' + lineBreak, lineBreak, 'a' + lineBreak + lineBreak + 'b', '']) {
        assert.deepEqual(splitAtEveryLineBreak(text), splitlines(text), JSON.stringify(text));
      }
    }
    assert.deepEqual(splitAtEveryLineBreak('a\x1fb'), ['a\x1fb']);
  });
});

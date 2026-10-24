import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import { Sandbox } from './helpers.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'keel-git-data-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const NEXT_LINE = String.fromCharCode(0x85);
const INFORMATION_SEPARATOR_FOUR = String.fromCharCode(0x1c);
const NO_BREAK_SPACE = String.fromCharCode(0xa0);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const INFORMATION_SEPARATOR_THREE = String.fromCharCode(0x1d);
const INFORMATION_SEPARATOR_TWO = String.fromCharCode(0x1e);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const CARRIAGE_RETURN = String.fromCharCode(0x0d);
const NOT_A_LINE_BREAK = [BYTE_ORDER_MARK, NO_BREAK_SPACE];
const OTHER_LINE_BREAKS = [NEXT_LINE, INFORMATION_SEPARATOR_FOUR, INFORMATION_SEPARATOR_THREE, INFORMATION_SEPARATOR_TWO, LINE_SEPARATOR, PARAGRAPH_SEPARATOR, CARRIAGE_RETURN, '\v', '\f'];
const LINE_BREAK_REFUSAL = 'the output holds a line break other than \\n';
const EMPTY_LINE_REFUSAL = 'the output holds an empty line';
const SEVERAL_LINES_REFUSAL = 'the output holds more than one line';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

function newRepo(): string {
  const repo = mkdtempSync(join(scratch, 'repo-'));
  git(repo, 'init', '-q');
  return repo;
}

function git(repo: string, ...args: string[]): void {
  const completed = spawnSync('git', ['-C', repo, ...args], { env: GIT_ENV });
  assert.equal(completed.status, 0, args.join(' ') + ': ' + completed.stderr.toString());
}

function refuses(refusal: string, read: () => unknown): void {
  assert.throws(read, (error: Error) => error instanceof gitcmd.GitError && error.message.includes(refusal), String(read));
}

function refusesLineBreak(read: () => unknown): void {
  refuses(LINE_BREAK_REFUSAL, read);
}

describe('git output is data: only its final newline is removed', () => {
  for (const edge of NOT_A_LINE_BREAK) {
    test('a remote url, a config value and a push remote ending in ' + JSON.stringify(edge) + ' are read exactly', () => {
      const repo = newRepo();
      const url = 'https://example.com/acme/app' + edge;
      git(repo, 'remote', 'add', 'origin', url);
      assert.equal(gitcmd.originUrl(repo), url);
      assert.deepEqual(gitcmd.pushUrls(repo, 'origin'), [url]);
      git(repo, 'config', 'remote.origin.gh-resolved', 'acme/app' + edge);
      assert.deepEqual(gitcmd.ghDefaultRemote(repo), { remote: 'origin', resolved: 'acme/app' + edge });
      git(repo, 'config', 'remote.pushDefault', 'mirror' + edge);
      assert.equal(gitcmd.pushRemote(repo), 'mirror' + edge);
    });
  }

  for (const edge of [...NOT_A_LINE_BREAK, ...OTHER_LINE_BREAKS]) {
    test('text() returns a config value ending in ' + JSON.stringify(edge) + ' exactly', () => {
      const repo = newRepo();
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
    const run = sandbox.push(fork, 'gh pr merge 7 --squash --match-head-commit ' + head);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [K1] cannot attribute this push or merge'), run.stderr);
    assert.ok(run.stderr.includes('acme/app, me/app'), run.stderr);
  });
});

describe('git output that feeds a gate decision and holds a line break other than \\n refuses', () => {
  for (const lineBreak of OTHER_LINE_BREAKS) {
    test('a gh-resolved value, an origin url and a push url holding ' + JSON.stringify(lineBreak) + ' refuse', () => {
      const repo = newRepo();
      git(repo, 'remote', 'add', 'origin', 'https://example.com/acme/app' + lineBreak + 'junk');
      refusesLineBreak(() => gitcmd.originUrl(repo));
      refusesLineBreak(() => gitcmd.remoteUrl(repo, 'origin'));
      refusesLineBreak(() => gitcmd.pushUrls(repo, 'origin'));
      git(repo, 'remote', 'set-url', 'origin', 'https://example.com/acme/app');
      git(repo, 'config', 'remote.origin.gh-resolved', 'acme/app' + lineBreak + 'junk');
      refusesLineBreak(() => gitcmd.ghDefaultRemote(repo));
    });

    test('a push url ending in ' + JSON.stringify(lineBreak) + ' refuses instead of resolving to a shortened url', () => {
      const repo = newRepo();
      git(repo, 'remote', 'add', 'origin', 'https://example.com/acme/app');
      git(repo, 'config', 'remote.origin.pushurl', 'https://example.com/acme/app' + lineBreak);
      refusesLineBreak(() => gitcmd.pushUrls(repo, 'origin'));
    });

  }

  for (const lineBreak of [NEXT_LINE, LINE_SEPARATOR]) {
    test('a remote name holding ' + JSON.stringify(lineBreak) + ' refuses', () => {
      const repo = newRepo();
      git(repo, 'remote', 'add', 'up' + lineBreak + 'stream', 'https://example.com/acme/app');
      refusesLineBreak(() => gitcmd.remotes(repo));
    });
  }

  test('lines are the output split at \\n after its single final newline, and an empty line refuses', () => {
    assert.deepEqual(gitcmd.gateLines(['x'], ''), []);
    assert.deepEqual(gitcmd.gateLines(['x'], 'a\n'), ['a']);
    assert.deepEqual(gitcmd.gateLines(['x'], 'a\nb'), ['a', 'b']);
    for (const output of ['\n', 'a\n\nb\n', '\na\n', 'a\n\n']) {
      assert.throws(() => gitcmd.gateLines(['x'], output), (error: Error) => error instanceof gitcmd.GitError && error.message.includes(EMPTY_LINE_REFUSAL), JSON.stringify(output));
    }
  });

  test('a remote url holding a \\n makes a single-value read refuse instead of returning several lines', () => {
    const repo = newRepo();
    git(repo, 'remote', 'add', 'origin', 'https://example.com/me/app');
    git(repo, 'config', 'remote.origin.url', 'https://example.com/me/app\nhttps://example.com/acme/app');
    refuses(SEVERAL_LINES_REFUSAL, () => gitcmd.remoteUrl(repo, 'origin'));
    git(repo, 'config', 'remote.origin.url', 'https://example.com/me/app\n\nhttps://example.com/acme/app');
    refuses(EMPTY_LINE_REFUSAL, () => gitcmd.remoteUrl(repo, 'origin'));
    refuses(EMPTY_LINE_REFUSAL, () => gitcmd.originUrl(repo));
  });

  test('a push remote holding a carriage return refuses', () => {
    const repo = newRepo();
    git(repo, 'config', 'remote.pushDefault', 'mirror' + CARRIAGE_RETURN + 'junk');
    refusesLineBreak(() => gitcmd.pushRemote(repo));
  });

  test('an empty push remote refuses instead of falling through to the next key', () => {
    const repo = newRepo();
    git(repo, 'config', 'remote.pushDefault', '');
    refuses(EMPTY_LINE_REFUSAL, () => gitcmd.pushRemote(repo));
  });

  for (const lineBreak of [NEXT_LINE, LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
    test('a branch name holding ' + JSON.stringify(lineBreak) + ' refuses', () => {
      const repo = newRepo();
      git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feat' + lineBreak + 'ure');
      refusesLineBreak(() => gitcmd.currentBranch(repo));
    });
  }

  test('a merge is refused when the stored gh default repo holds a carriage return', (t) => {
    const sandbox = new Sandbox(t);
    sandbox.clone('acme', 'app');
    const fork = sandbox.clone('me', 'app', 'solo');
    fork.git('config', 'remote.origin.gh-resolved', 'acme/app' + CARRIAGE_RETURN + 'junk');
    const run = sandbox.push(fork, 'gh pr merge 7 --squash');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes(LINE_BREAK_REFUSAL), run.stderr);
  });

  function repoWithSubmoduleUnder(parentName: string): string {
    const library = newRepo();
    writeFileSync(join(library, 'lib.txt'), 'x\n');
    git(library, 'add', '-A');
    git(library, 'commit', '-q', '-m', 'lib');
    const parent = join(scratch, parentName);
    mkdirSync(parent);
    git(parent, 'init', '-q');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'sub');
    return parent;
  }

  test('a submodule root is listed as its path, and a path holding a carriage return refuses', () => {
    const plain = repoWithSubmoduleUnder('plain-parent');
    assert.deepEqual(gitcmd.submoduleRoots(plain), [realpathSync(join(plain, 'sub'))]);
    const broken = repoWithSubmoduleUnder('broken' + CARRIAGE_RETURN + 'parent');
    refusesLineBreak(() => gitcmd.submoduleRoots(broken));
  });
});

import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { matchesContent } from '../../lib/evidence/comment_cleanup.ts';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import { covers } from '../../lib/evidence/verify.ts';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';

const FILES = ['a.ts', 'b.ts', 'c.md', 'docs/d.json', 'e.sh'];
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function gitCalls(t: TestContext): string[][] {
  const calls: string[][] = [];
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (program: string, args: string[], options: object) => {
    if (program === 'git') calls.push(args.slice(2));
    return spawnSync(program, args, options);
  });
  return calls;
}

function count(calls: string[][], ...subcommand: string[]): number {
  return calls.filter((args) => subcommand.every((word, index) => args[index] === word)).length;
}

function setUp(t: TestContext) {
  const repo = new Sandbox(t).clone('acme', 'app');
  const base = repo.commit(Object.fromEntries(FILES.map((path) => [path, `// ${path} first\nexport const x = 1;\n`])));
  const firstTree = repo.tree();
  repo.commit(Object.fromEntries(FILES.map((path) => [path, `// ${path} second\nexport const x = 2;\n`])));
  const secondTree = repo.tree();
  const head = repo.commit(Object.fromEntries(FILES.map((path) => [path, `export const x = 3;\n`])));
  const entries = gitcmd.diffEntries(repo.path, base, head);
  return { repo, base, head, firstTree, secondTree, headTree: repo.tree(), entries };
}

test('covers_listsEachTreeOnce_howeverManyPathsItChecks', (t) => {
  const { repo, firstTree, secondTree, headTree, entries } = setUp(t);
  const calls = gitCalls(t);

  const verdicts = [headTree, firstTree, secondTree, headTree].map((tree) => covers(repo.path, tree, entries));

  assert.deepEqual(verdicts, [true, false, false, true]);
  assert.equal(entries.length, FILES.length);
  assert.equal(count(calls, 'ls-tree'), 3);
});

test('treeEntry_answersAsAPathQueryWould_forFilesDirectoriesAndMissingPaths', (t) => {
  const { repo, headTree } = setUp(t);

  for (const path of [...FILES, 'docs', 'missing.ts', 'docs/missing.json']) {
    const listed = repo.git('ls-tree', headTree, '--', path);
    const expected = listed === '' ? null : [listed.split(' ')[0], listed.split(' ')[2]!.split('\t')[0]];
    assert.deepEqual(gitcmd.treeEntry(repo.path, headTree, path), expected, path);
  }
});

test('treeEntry_findsEachPathItself_forColonPrefixedNfdAndNonUtf8Names', (t) => {
  const repo = new Sandbox(t).clone('acme', 'app');
  repo.git('config', 'core.precomposeunicode', 'true');
  const blobs = ['colon', 'decomposed', 'plain', 'latin1'].map((content) =>
    spawnSync('git', ['-C', repo.path, 'hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8' }).stdout.trim());
  const names = [Buffer.from(':memo.ts'), Buffer.from('cafe\u0301.ts'), Buffer.from('memo.ts'), Buffer.from([0xff, ...Buffer.from('.ts')])];
  const listing = Buffer.concat(names.map((name, index) => Buffer.concat([Buffer.from(`100644 blob ${blobs[index]}\t`), name, Buffer.from([0])])));
  const tree = spawnSync('git', ['-C', repo.path, 'mktree', '-z'], { input: listing, encoding: 'utf8' }).stdout.trim();
  const entries = gitcmd.diffEntries(repo.path, EMPTY_TREE, tree);

  assert.deepEqual(entries.map((entry) => gitcmd.treeEntry(repo.path, tree, entry.path)), blobs.map((blob) => ['100644', blob]));
});

test('treeEntry_listsAgain_whenTheTreeIsNamedByARef', (t) => {
  const { repo } = setUp(t);
  const calls = gitCalls(t);

  const before = gitcmd.treeEntry(repo.path, 'HEAD', 'a.ts');
  const expectedBefore = repo.git('rev-parse', 'HEAD:a.ts');
  repo.commit({ 'a.ts': 'export const x = 4;\n' });
  const after = gitcmd.treeEntry(repo.path, 'HEAD', 'a.ts');

  assert.deepEqual([before, after], [['100644', expectedBefore], ['100644', repo.git('rev-parse', 'HEAD:a.ts')]]);
  assert.notEqual(before![1], after![1]);
  assert.equal(count(calls, 'ls-tree'), 2);
});

test('isAncestor_asksGitOncePerCommitPair_butEveryTimeForRefNames', (t) => {
  const { repo, base, head } = setUp(t);
  const calls = gitCalls(t);

  const answers = [
    gitcmd.isAncestor(repo.path, base, head), gitcmd.isAncestor(repo.path, base, head), gitcmd.isAncestor(repo.path, head, base),
    gitcmd.isAncestor(repo.path, base, 'HEAD'), gitcmd.isAncestor(repo.path, base, 'HEAD'),
  ];

  assert.deepEqual(answers, [true, true, false, true, true]);
  assert.equal(count(calls, 'merge-base', '--is-ancestor'), 4);
});

test('matchesContent_readsNoBlob_forPathsCommentCleanupCannotJudge', (t) => {
  const { repo, firstTree, headTree } = setUp(t);
  const calls = gitCalls(t);

  for (const path of ['c.md', 'docs/d.json', 'e.sh']) {
    const reviewed = gitcmd.treeEntry(repo.path, firstTree, path);
    assert.equal(matchesContent(repo.path, path, reviewed, gitcmd.treeEntry(repo.path, headTree, path)), false, path);
  }

  assert.equal(count(calls, 'cat-file'), 0);
});

test('matchesContent_sizesEachBlobOnce_acrossReviewedVersions', (t) => {
  const { repo, firstTree, secondTree, headTree } = setUp(t);
  const current = gitcmd.treeEntry(repo.path, headTree, 'a.ts');
  const calls = gitCalls(t);

  const verdicts = [firstTree, secondTree].map((tree) => matchesContent(repo.path, 'a.ts', gitcmd.treeEntry(repo.path, tree, 'a.ts'), current));

  assert.deepEqual(verdicts, [false, false]);
  assert.equal(count(calls, 'cat-file', '-s'), 3);
});

function gitLogShim(sandbox: Sandbox): { env: Record<string, string>; calls: () => string[] } {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const directory = join(sandbox.root, 'git-shim');
  const log = join(sandbox.root, 'git-calls.log');
  mkdirSync(directory);
  writeFileSync(join(directory, 'git'), `#!/bin/bash\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  return {
    env: { PATH: `${directory}:${sandbox.env['PATH']}` },
    calls: () => readFileSync(log, 'utf8').split('\n').filter((line) => line !== ''),
  };
}

function waitForNextSecond(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
}

test('push_listsNoOlderTestsTree_whenTheNewestTestsEvidenceCoversTheChange', (t) => {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  const olderTrees: string[] = [];
  for (const version of [1, 2]) {
    repo.commit({ 'src/a.py': `print(${version})\n`, 'tests/test_a.py': `def test_a():\n    assert ${version}\n` });
    sandbox.testsEvidence(repo);
    olderTrees.push(repo.tree());
    waitForNextSecond();
  }
  repo.commit(LOGIC_WITH_TEST);
  sandbox.fullBundle(repo);
  const shim = gitLogShim(sandbox);

  const run = sandbox.hook(sandbox.bashPayload(repo, 'git push origin feature'), shim.env);

  assert.equal(run.rc, 0, run.stderr);
  const listed = shim.calls().filter((line) => line.includes(' ls-tree '));
  assert.ok(listed.length > 0, shim.calls().join('\n'));
  assert.deepEqual(listed.filter((line) => olderTrees.some((tree) => line.includes(tree))), []);
});

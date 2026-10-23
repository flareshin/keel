import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import { Sandbox } from './helpers.ts';

function setUp(t: TestContext) {
  const sandbox = new Sandbox(t);
  const [parent, child] = sandbox.cloneWithSubmodule();
  parent.git('config', '--file', '.gitmodules', 'submodule.lib.ignore', 'all');
  parent.git('add', '.gitmodules');
  parent.git('commit', '-q', '-m', 'ignore local submodule changes');
  const base = parent.head();
  const oldChild = child.head();
  const newChild = child.commit({ 'lib.py': 'LIB = 2\n' }, 'update library');
  parent.git('update-index', '--cacheinfo', '160000,' + newChild + ',lib');
  parent.git('commit', '-q', '-m', 'advance library');
  sandbox.patchProcessEnv(t);
  return { parent, base, oldChild, newChild, tree: parent.tree() };
}

test('diff_entries_includes_ignored_gitlink_for_review_coverage', (t) => {
  const { parent, base, oldChild, newChild, tree } = setUp(t);

  const entries = gitcmd.diffEntries(parent.path, base, tree);

  assert.deepEqual(entries, [{ path: 'lib', blob: newChild, mode: '160000', oldMode: '160000', oldBlob: oldChild }]);
  assert.ok(gitcmd.isGitlink(entries[0]!));
});

test('diff_stats_counts_ignored_gitlink_for_risk_classification', (t) => {
  const { parent, base, tree } = setUp(t);

  const stats = gitcmd.diffStats(parent.path, base, tree);

  assert.deepEqual(stats, new Map([['lib', { added: 1, deleted: 1 }]]));
});

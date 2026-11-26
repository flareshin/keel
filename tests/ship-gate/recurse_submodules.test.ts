import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const BOTH_GATED = ['acme/lib\tcode\tmain\tacme\trequired', 'acme/platform\tcode\tmain\tacme\trequired'];
const ONLY_LIB_GATED = ['acme/lib\tcode\tmain\tacme\trequired'];
const ONLY_PLATFORM_GATED = ['acme/platform\tcode\tmain\tacme\trequired'];
const NEITHER_GATED = ['acme/other\tcode\tmain\tacme\trequired'];
const TEST = 'def test_it(): assert True\n';
const SUBMODULE_PUSH_DENY = '- [F-irreversible] git push --recurse-submodules=on-demand/only';

function parentWithUnpushedSubmoduleCommit(sandbox: Sandbox): Repo {
  const [parent, submodule] = sandbox.cloneWithSubmodule();
  submodule.git('checkout', '-q', '-b', 'feature');
  submodule.commit({ 'lib.py': 'LIB = 2\n', 'tests/test_lib.py': TEST }, 'unreviewed lib change');
  parent.git('checkout', '-q', '-b', 'feature');
  parent.git('add', 'lib');
  parent.git('commit', '-q', '-m', 'bump lib');
  return parent;
}

function assertSubmodulePushDenied(sandbox: Sandbox, parent: Repo, command: string): void {
  const run = sandbox.push(parent, command);
  assert.equal(run.rc, 2, `${command}\n${run.stderr}`);
  assert.ok(run.stderr.includes(SUBMODULE_PUSH_DENY), `${command}\n${run.stderr}`);
}

function assertNotASubmodulePushDeny(sandbox: Sandbox, parent: Repo, command: string): void {
  const run = sandbox.push(parent, command);
  assert.ok(!run.stderr.includes(SUBMODULE_PUSH_DENY), `${command}\n${run.stderr}`);
}

describe('RecurseSubmodulesPushTest', () => {
  test('recurseOption_onDemandOrOnly_deniesBecauseItPushesTheSubmoduleUnjudged', (t) => {
    const sandbox = new Sandbox(t, BOTH_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    for (const value of ['on-demand', 'only']) {
      assertSubmodulePushDenied(sandbox, parent, `git push --recurse-submodules=${value} origin feature`);
    }
  });

  test('recurseOption_lastOneWins', (t) => {
    const sandbox = new Sandbox(t, BOTH_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    assertNotASubmodulePushDeny(sandbox, parent, 'git push --recurse-submodules=on-demand --no-recurse-submodules origin feature');
    assertNotASubmodulePushDeny(sandbox, parent, 'git push --recurse-submodules=on-demand --recurse-submodules=check origin feature');
    assertSubmodulePushDenied(sandbox, parent, 'git push --no-recurse-submodules --recurse-submodules=on-demand origin feature');
  });

  test('storedConfig_pushRecurseSubmodulesOrSubmoduleRecurse_denies', (t) => {
    const sandbox = new Sandbox(t, BOTH_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    parent.git('config', 'push.recurseSubmodules', 'on-demand');
    assertSubmodulePushDenied(sandbox, parent, 'git push origin feature');
    assertNotASubmodulePushDeny(sandbox, parent, 'git push --recurse-submodules=check origin feature');
    parent.git('config', 'push.recurseSubmodules', 'check');
    assertNotASubmodulePushDeny(sandbox, parent, 'git push origin feature');
    parent.git('config', 'submodule.recurse', 'true');
    assertSubmodulePushDenied(sandbox, parent, 'git push origin feature');
    parent.git('config', '--unset', 'push.recurseSubmodules');
    assertSubmodulePushDenied(sandbox, parent, 'git push origin feature');
    assertNotASubmodulePushDeny(sandbox, parent, 'git push --no-recurse-submodules origin feature');
  });

  test('repoWithoutSubmodules_recurseOption_isJudgedAsAPlainPush', (t) => {
    const sandbox = new Sandbox(t, BOTH_GATED);
    const platform = sandbox.clone('acme', 'platform');
    platform.branch('feature');
    platform.commit({ 'src/a.py': 'a\n' }, 'work');
    const run = sandbox.push(platform, 'git push --recurse-submodules=on-demand origin feature');
    assert.equal(run.rc, 2, run.stderr);
    assert.ok(!run.stderr.includes(SUBMODULE_PUSH_DENY), run.stderr);
    assert.ok(run.stderr.includes('no review evidence'), run.stderr);
  });

  test('inCallConfig_submoduleRecurse_deniesAsRunTimeConfig', (t) => {
    const sandbox = new Sandbox(t, BOTH_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    for (const command of [
      'git -c submodule.recurse=true push origin feature',
      'git config submodule.recurse true && git push origin feature',
    ]) {
      const run = sandbox.push(parent, command);
      assert.equal(run.rc, 2, `${command}\n${run.stderr}`);
      assert.ok(run.stderr.includes('changes git config the gate reads from the clone'), `${command}\n${run.stderr}`);
    }
  });

  test('ungatedParent_stillDenies_whenASubmoduleIsGated', (t) => {
    const sandbox = new Sandbox(t, ONLY_LIB_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    assertSubmodulePushDenied(sandbox, parent, 'git push --recurse-submodules=on-demand origin feature');
    assert.equal(sandbox.push(parent, 'git push origin feature').rc, 0);
  });

  test('gatedParent_deniesAndNamesItself_whenNoSubmoduleIsGated', (t) => {
    const sandbox = new Sandbox(t, ONLY_PLATFORM_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    const run = sandbox.push(parent, 'git push --recurse-submodules=on-demand origin feature');
    assert.equal(run.rc, 2, run.stderr);
    assert.ok(run.stderr.includes('push into submodules of acme/platform denied'), run.stderr);
  });

  test('neitherParentNorSubmoduleGated_recursivePushPasses', (t) => {
    const sandbox = new Sandbox(t, NEITHER_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    const run = sandbox.push(parent, 'git push --recurse-submodules=on-demand origin feature');
    assert.equal(run.rc, 0, run.stderr);
  });

  test('noRegistry_recursivePushPasses', (t) => {
    const sandbox = new Sandbox(t, BOTH_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    unlinkSync(join(sandbox.overlay, 'gated-repos.tsv'));
    const run = sandbox.push(parent, 'git push --recurse-submodules=on-demand origin feature');
    assert.equal(run.rc, 0, run.stderr);
  });

  test('dryRun_passes', (t) => {
    const sandbox = new Sandbox(t, BOTH_GATED);
    const parent = parentWithUnpushedSubmoduleCommit(sandbox);
    const run = sandbox.push(parent, 'git push --dry-run --recurse-submodules=on-demand origin feature');
    assert.equal(run.rc, 0, run.stderr);
  });
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { splitlines } from '../../hooks/lib/hookkit/text.ts';
import { Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const MULTI_REGISTRY = ['acme/app\tcode\tmain\tacme\trequired', 'acme/lib\tcode\tmain\tacme\trequired',
  'acme/platform\tcode\tmain\tacme\trequired', 'acme/tool\tcode\tmain\tacme\trequired'];
const MULTI_REGISTRY_DEPLOYING_APP = ['acme/app\tcode\tmain\tacme\trequired\ttrue', ...MULTI_REGISTRY.slice(1)];
const TEST = 'def test_it(): assert True\n';
const APP_OFF_REGISTRY = ['acme/app\toff\tmain\t-\tnone'];
const APP_URL_FORMS = ['https://example.invalid/acme/app.git', 'git@example.invalid:acme/app.git', 'ssh://git@example.invalid/acme/app.git'];
const FOREIGN_FROM_FORK = '- [F-irreversible] run git push from a clone of acme/app (this clone is me/app)';

function snapshotTree(sandbox: Sandbox, repo: Repo): string {
  return sandbox.keel(['snapshot', repo.path]).json.tree;
}

function lastLine(text: string): string {
  return splitlines(text).at(-1) ?? '';
}

describe('MultiRepoScenarioTest', () => {
  function submoduleChange(sandbox: Sandbox): [Repo, Repo] {
    const [parent, submodule] = sandbox.cloneWithSubmodule();
    submodule.git('checkout', '-q', '-b', 'feature');
    submodule.commit({ 'lib.py': 'LIB = 2\n', 'tests/test_lib.py': TEST }, 'lib change');
    parent.git('checkout', '-q', '-b', 'feature');
    parent.git('add', 'lib');
    parent.git('commit', '-q', '-m', 'bump lib');
    return [parent, submodule];
  }

  test('pushes_pass_whenOneRunReviewsSubmoduleAndParentWithOneApproval', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const [parent, submodule] = submoduleChange(sandbox);
    sandbox.review(submodule, { runId: 'rv-run-0001' });
    sandbox.review(parent, { runId: 'rv-run-0001' });
    sandbox.testsEvidence(submodule);
    sandbox.testsEvidence(parent);
    const approval = sandbox.approve('rv-run-0001').json;
    assert.deepEqual(Object.keys(approval.heads).sort(), ['acme/lib', 'acme/platform']);
    assert.equal(sandbox.push(submodule, 'git push origin feature').rc, 0);
    submodule.git('push', '-q', 'origin', 'feature');
    const run = sandbox.push(parent, 'git push origin feature');
    assert.equal(run.rc, 0, run.stderr);
    assert.deepEqual(sandbox.fires('risk', 'pass').map((line) => line.repo), ['acme/lib', 'acme/platform']);
  });

  test('submodulePush_passes_whenTestsRanOnlyFromTheParent', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const [parent, submodule] = submoduleChange(sandbox);
    sandbox.review(submodule, { runId: 'rv-run-0001' });
    sandbox.testsEvidence(parent);
    sandbox.approve('rv-run-0001');
    const run = sandbox.push(submodule, 'git push origin feature');
    assert.equal(run.rc, 0, run.stderr);
  });

  test('parentPointerPush_passes_whenTestsRanOnlyInTheSubmodule', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const [parent, submodule] = submoduleChange(sandbox);
    sandbox.review(submodule, { runId: 'rv-run-0001' });
    sandbox.review(parent, { runId: 'rv-run-0001' });
    sandbox.testsEvidence(submodule);
    sandbox.approve('rv-run-0001');
    assert.equal(sandbox.push(submodule, 'git push origin feature').rc, 0);
    submodule.git('push', '-q', 'origin', 'feature');
    const run = sandbox.push(parent, 'git push origin feature');
    assert.equal(run.rc, 0, run.stderr);
  });

  test('parentPointerPush_denies_whenSubmoduleTestsRanOnAnotherCommit', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const [parent, submodule] = submoduleChange(sandbox);
    sandbox.testsEvidence(submodule);
    submodule.commit({ 'lib.py': 'LIB = 3\n' }, 'untested lib change');
    parent.git('add', 'lib');
    parent.git('commit', '-q', '-m', 'bump lib again');
    sandbox.review(submodule, { runId: 'rv-run-0001' });
    sandbox.review(parent, { runId: 'rv-run-0001' });
    sandbox.approve('rv-run-0001');
    const run = sandbox.push(parent, 'git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('no tests evidence covers this exact content'), run.stderr);
  });

  test('parentPush_denies_whenItChangesAFileBesideThePointerAndOnlyTheSubmoduleRanTests', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const [parent, submodule] = submoduleChange(sandbox);
    parent.commit({ 'app.py': 'APP = 2\n', 'tests/test_app.py': TEST }, 'app change');
    sandbox.testsEvidence(submodule);
    sandbox.review(submodule, { runId: 'rv-run-0001' });
    sandbox.review(parent, { runId: 'rv-run-0001' });
    sandbox.approve('rv-run-0001');
    const run = sandbox.push(parent, 'git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('no tests evidence covers this exact content'), run.stderr);
  });

  test('parentPointerPush_denies_whenSubmoduleTestsRanOnUncommittedEdits', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const [parent, submodule] = submoduleChange(sandbox);
    submodule.write('lib.py', 'LIB = 3\n');
    sandbox.testsEvidence(submodule);
    submodule.git('checkout', '-q', '--', 'lib.py');
    sandbox.review(submodule, { runId: 'rv-run-0001' });
    sandbox.review(parent, { runId: 'rv-run-0001' });
    sandbox.approve('rv-run-0001');
    const run = sandbox.push(parent, 'git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('no tests evidence covers this exact content'), run.stderr);
  });

  test('pushes_pass_whenRootCoversTwoReposAndOneGetsADelta', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const app = sandbox.clone('acme', 'app');
    const tool = sandbox.clone('acme', 'tool', undefined, { 'tool.py': 'T = 1\n' });
    for (const repo of [app, tool]) repo.branch('feature');
    app.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'app work');
    tool.commit({ 'tool.py': 'T = 2\n', 'tests/test_tool.py': TEST }, 'tool work');
    const appRootTree = snapshotTree(sandbox, app);
    sandbox.review(app, { runId: 'rv-run-0001' });
    sandbox.review(tool, { runId: 'rv-run-0001' });
    app.commit({ 'src/a.py': 'a2\n' }, 'app follow-up');
    sandbox.review(app, { runId: 'rv-run-0002', rootRunId: 'rv-run-0001', since: appRootTree });
    sandbox.testsEvidence(app);
    sandbox.testsEvidence(tool);
    const approval = sandbox.approve('rv-run-0001').json;
    assert.ok(approval.heads['acme/app'].startsWith('review-'));
    assert.equal(sandbox.push(app, 'git push origin feature').rc, 0);
    assert.equal(sandbox.push(tool, 'git push origin feature').rc, 0);
    assert.equal(sandbox.fires('risk', 'pass').length, 2);
  });

  test('push_denies_whenDeltaOfOtherRepoIsMissingFromApproval', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY_DEPLOYING_APP);
    const app = sandbox.clone('acme', 'app');
    app.branch('feature');
    app.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'app work');
    const appRootTree = snapshotTree(sandbox, app);
    sandbox.review(app, { runId: 'rv-run-0001' });
    sandbox.testsEvidence(app);
    sandbox.approve('rv-run-0001');
    app.commit({ 'src/a.py': 'a2\n' }, 'app follow-up');
    sandbox.review(app, { runId: 'rv-run-0002', rootRunId: 'rv-run-0001', since: appRootTree });
    sandbox.testsEvidence(app);
    const run = sandbox.push(app, 'git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('no approval bound to chain head'), run.stderr);
  });
});

describe('RemoteTargetTest', () => {
  function forkClone(sandbox: Sandbox): [Repo, string] {
    sandbox.clone('acme', 'app');
    const fork = sandbox.clone('me', 'app', 'fork');
    fork.git('remote', 'add', 'upstream', sandbox.remote('acme', 'app'));
    fork.branch('feature');
    const head = fork.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'fork work');
    return [fork, head];
  }

  function featureClone(sandbox: Sandbox): Repo {
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'work');
    return repo;
  }

  function addOriginPushUrls(repo: Repo, ...urls: string[]): void {
    for (const url of urls) repo.git('config', '--add', 'remote.origin.pushurl', url);
  }

  test('barePush_deniedAsForeignClone_whenThePushRemoteIsTheGatedUpstream', (t) => {
    for (const setting of ['branch.feature.pushRemote', 'remote.pushDefault', 'branch.feature.remote']) {
      const sandbox = new Sandbox(t);
      const [fork] = forkClone(sandbox);
      fork.git('config', setting, 'upstream');
      const run = sandbox.push(fork, 'git push');
      assert.equal(run.rc, 2, setting + run.stderr + run.stdout);
      assert.ok(run.stderr.includes(FOREIGN_FROM_FORK), run.stderr);
    }
  });

  test('barePush_followsRemotePushDefault_overTheBranchRemote', (t) => {
    const sandbox = new Sandbox(t);
    const [fork] = forkClone(sandbox);
    fork.git('config', 'branch.feature.remote', 'origin');
    fork.git('config', 'remote.pushDefault', 'upstream');
    const run = sandbox.push(fork, 'git push');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes(FOREIGN_FROM_FORK), run.stderr);
  });

  test('barePush_followsTheBranchPushRemote_overRemotePushDefault', (t) => {
    const sandbox = new Sandbox(t);
    const [fork] = forkClone(sandbox);
    fork.git('config', 'remote.pushDefault', 'upstream');
    fork.git('config', 'branch.feature.pushRemote', 'origin');
    const run = sandbox.push(fork, 'git push');
    assert.equal(run.rc, 0, run.stderr + run.stdout);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'me/app');
  });

  test('push_isJudgedOnTheUrlRepo_whenOriginIsAUrlFormOfTheGatedRepo', (t) => {
    for (const url of APP_URL_FORMS) {
      const sandbox = new Sandbox(t);
      const repo = featureClone(sandbox);
      repo.git('remote', 'set-url', 'origin', url);
      const run = sandbox.push(repo, 'git push origin feature');
      assert.equal(run.rc, 2, url + run.stderr + run.stdout);
      assert.ok(run.stderr.includes('- [K1] no review evidence for acme/app'), run.stderr);
      assert.ok(!run.stderr.includes('cannot attribute'), run.stderr);
    }
  });

  test('push_passes_whenOriginIsAUrlFormOfAnUngatedRepo', (t) => {
    for (const url of APP_URL_FORMS) {
      const sandbox = new Sandbox(t, APP_OFF_REGISTRY);
      const repo = featureClone(sandbox);
      repo.git('remote', 'set-url', 'origin', url);
      const run = sandbox.push(repo, 'git push origin feature');
      assert.equal(run.rc, 0, url + run.stderr + run.stdout);
      assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'acme/app');
    }
  });

  test('push_deniedAsForeignClone_whenThePushUrlsReachTheClonesGatedRepoAndAnotherGatedRepo', (t) => {
    const sandbox = new Sandbox(t, MULTI_REGISTRY);
    const repo = featureClone(sandbox);
    addOriginPushUrls(repo, sandbox.remote('acme', 'app'), sandbox.remote('acme', 'lib'));
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [F-irreversible] run git push from a clone of acme/lib (this clone is acme/app)'), run.stderr);
  });

  test('push_passes_whenTheRemoteIsAnUngatedMirror', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.git('remote', 'add', 'mirror', sandbox.remote('me', 'mirror'));
    repo.branch('feature');
    repo.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'work');
    const run = sandbox.push(repo, 'git push mirror feature');
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'me/mirror');
  });

  test('push_isJudged_whenTheRemoteIsGivenAsTheGatedRepoUrl', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'work');
    const run = sandbox.push(repo, `git push ${sandbox.remote('acme', 'app')} feature`);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [K1] no review evidence for acme/app'), run.stderr);
  });

  test('push_isJudgedOnTheClonesOwnRepo_whenALaterPushUrlOfTheRemoteIsIt', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    addOriginPushUrls(repo, sandbox.remote('me', 'mirror'), sandbox.remote('acme', 'app'));
    repo.branch('feature');
    repo.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'work');
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [K1] no review evidence for acme/app'), run.stderr);
  });

  test('push_deniedAsForeignClone_whenAPushUrlOfTheRemoteIsAnotherGatedRepo', (t) => {
    const sandbox = new Sandbox(t);
    const [fork] = forkClone(sandbox);
    addOriginPushUrls(fork, sandbox.remote('me', 'app'), sandbox.remote('acme', 'app'));
    const run = sandbox.push(fork, 'git push origin feature');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes(FOREIGN_FROM_FORK), run.stderr);
  });

  test('push_passes_whenNoPushUrlOfTheRemoteIsGated', (t) => {
    const sandbox = new Sandbox(t);
    const [fork] = forkClone(sandbox);
    addOriginPushUrls(fork, sandbox.remote('me', 'app'), sandbox.remote('me', 'mirror'));
    const run = sandbox.push(fork, 'git push origin feature');
    assert.equal(run.rc, 0, run.stderr + run.stdout);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'me/app');
  });

  test('merge_deniedWithTheRepoFlagToAdd_whenRemotesNameSeveralReposAndOneIsGated', (t) => {
    const sandbox = new Sandbox(t);
    const [fork, head] = forkClone(sandbox);
    const command = `gh pr merge 7 --squash --match-head-commit ${head}`;
    const run = sandbox.push(fork, command);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [K1] cannot attribute this push or merge'), run.stderr);
    assert.ok(run.stderr.includes('acme/app, me/app'), run.stderr);
    assert.equal(lastLine(run.stderr), `Run it yourself in your terminal: cd ${fork.path} && ${command} --repo acme/app`);
    assert.equal(existsSync(sandbox.ghLog), false);
  });

  test('merge_followsTheGhDefaultRemote_whenOneIsSet', (t) => {
    const sandbox = new Sandbox(t);
    const [fork, head] = forkClone(sandbox);
    const command = `gh pr merge 7 --squash --match-head-commit ${head}`;
    fork.git('config', 'remote.upstream.gh-resolved', 'base');
    const run = sandbox.push(fork, command);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [F-irreversible] run gh pr merge from a clone of acme/app (this clone is me/app)'), run.stderr);
    fork.git('config', '--unset', 'remote.upstream.gh-resolved');
    fork.git('config', 'remote.origin.gh-resolved', 'base');
    assert.equal(sandbox.push(fork, command).rc, 0);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'me/app');
  });

  test('merge_deniedAsForeignClone_whenGhStoredTheGatedRepoAsTheDefault', (t) => {
    const sandbox = new Sandbox(t);
    const [fork, head] = forkClone(sandbox);
    fork.git('config', 'remote.origin.gh-resolved', 'acme/app');
    const run = sandbox.push(fork, `gh pr merge 7 --squash --match-head-commit ${head}`);
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [F-irreversible] run gh pr merge from a clone of acme/app (this clone is me/app)'), run.stderr);
  });

  test('merge_isUnattributable_whenTheCallChangesGhsDefaultRepoFirst', (t) => {
    const sandbox = new Sandbox(t);
    sandbox.clone('acme', 'app');
    const fork = sandbox.clone('me', 'app', 'solo');
    fork.branch('feature');
    const head = fork.commit({ 'src/a.py': 'a\n', 'tests/test_a.py': TEST }, 'fork work');
    for (const change of ['gh repo set-default acme/app', '/usr/local/bin/gh repo set-default acme/app',
      'git config remote.origin.gh-resolved acme/app']) {
      const run = sandbox.push(fork, `${change} && gh pr merge 7 --squash --match-head-commit ${head}`);
      assert.equal(run.rc, 2, change + run.stderr + run.stdout);
      assert.ok(run.stderr.includes('cannot attribute this push or merge'), run.stderr);
    }
  });

  test('merge_isJudgedOnItsOwnRepo_whenItNamesOne_evenAfterTheCallChangesGhsDefault', (t) => {
    const sandbox = new Sandbox(t);
    const fork = sandbox.clone('me', 'app', 'solo');
    for (const command of ['gh repo set-default acme/app && gh pr merge 7 --squash --repo me/app',
      'gh repo set-default acme/app && GH_REPO=me/app gh pr merge 7 --squash',
      'gh repo set-default acme/app && gh pr merge https://github.com/me/app/pull/7 --squash']) {
      const run = sandbox.push(fork, command);
      assert.equal(run.rc, 0, command + run.stderr + run.stdout);
      assert.ok(!run.stderr.includes('cannot attribute'), run.stderr);
    }
  });

  test('merge_passes_whenTheRepoFlagNamesNoRepoAndNothingIsGated', (t) => {
    const sandbox = new Sandbox(t, []);
    const fork = sandbox.clone('me', 'app', 'solo');
    const run = sandbox.push(fork, 'gh repo set-default acme/app && gh pr merge 7 --squash --repo not-a-repo');
    assert.equal(run.rc, 0, run.stderr + run.stdout);
  });

  test('merge_passes_whenTheCallOnlyViewsGhsDefaultRepo', (t) => {
    const sandbox = new Sandbox(t);
    const fork = sandbox.clone('me', 'app', 'solo');
    const run = sandbox.push(fork, 'gh repo set-default --view && gh pr merge 7 --squash');
    assert.equal(run.rc, 0, run.stderr + run.stdout);
  });

  test('merge_failsClosed_whenGhsStoredDefaultNamesNoRepo', (t) => {
    const sandbox = new Sandbox(t);
    sandbox.clone('acme', 'app');
    const fork = sandbox.clone('me', 'app', 'solo');
    fork.git('config', 'remote.origin.gh-resolved', 'garbage');
    const run = sandbox.push(fork, 'gh pr merge 7 --squash');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('names no owner/repo'), run.stderr);
  });

  test('merge_passes_whenSeveralRemotesNameNoGatedRepo', (t) => {
    const sandbox = new Sandbox(t);
    const clone = sandbox.clone('me', 'app');
    clone.git('remote', 'add', 'upstream', sandbox.remote('other', 'app'));
    const run = sandbox.push(clone, 'gh pr merge 7 --squash');
    assert.equal(run.rc, 0, run.stderr + run.stdout);
  });
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import * as gitcmd from '../../lib/evidence/gitcmd.ts';
import {
  ARGV_FORWARDERS, callActions, GH_TIMEOUT_SECONDS, mayPushOrMerge, mergeTargetKey, pushSources,
} from '../../hooks/ship-gate/ship-gate.ts';
import type { Action, Merge, Push, Unattributable } from '../../hooks/ship-gate/ship-gate.ts';
import { splitlines } from '../../hooks/lib/hookkit/pycompat.ts';
import { shlexQuote } from '../../hooks/lib/hookkit/pypath.ts';
import { LOGIC_WITH_TEST, Sandbox, shipGateTimeout } from './helpers.ts';

const DECISION_MARGIN_SECONDS = 5;
const NOT_GATED_REGISTRY = ['acme/app\toff\tmain\t-\tnone'];
const NO_REVIEW = '- [K1] no review evidence';
const UNATTRIBUTABLE = '- [K1] cannot attribute this push or merge';

function actions(command: string, cwd = '/work'): Action[] {
  return callActions(command, cwd);
}

function only(command: string): Action {
  const found = actions(command);
  assert.equal(found.length, 1, `${command}: ${JSON.stringify(found)}`);
  return found[0]!;
}

function onlyPush(command: string): Push {
  const action = only(command);
  assert.equal(action.kind, 'push', command);
  return action as Push;
}

function onlyMerge(command: string): Merge {
  const action = only(command);
  assert.equal(action.kind, 'merge', command);
  return action as Merge;
}

function onlyUnattributable(command: string): Unattributable {
  const action = only(command);
  assert.equal(action.kind, 'unattributable', command);
  return action as Unattributable;
}

function firstPush(command: string): Push {
  const action = actions(command)[0];
  assert.equal(action?.kind, 'push', command);
  return action as Push;
}

function assertNoActions(commands: string[]): void {
  for (const command of commands) assert.deepEqual(actions(command), [], command);
}

function assertOnlyUnattributable(commands: string[]): void {
  for (const command of commands) assert.equal(onlyUnattributable(command).kind, 'unattributable', command);
}

function lastLine(text: string): string {
  return splitlines(text).at(-1) ?? '';
}

function withHome<T>(home: string, body: () => T): T {
  const previous = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previous;
  }
}

describe('CommandParsingTest', () => {
  test('parsePush_readsRefspecs_whenSeveralRefspecsGiven', () => {
    const push = onlyPush('git push origin feature:refs/heads/feature +hotfix');
    assert.deepEqual(push.refspecs, [{ source: 'feature', destination: 'refs/heads/feature' }, { source: 'hotfix', destination: null }]);
    assert.deepEqual(pushSources(push), ['feature', 'hotfix']);
    assert.equal(push.deletesOnly || push.tagsOnly || push.wholeRepo || push.dryRun, false);
  });

  test('parsePush_defaultsToHead_whenNoRefspecGiven', () => {
    assert.deepEqual(onlyPush('git push -u origin').refspecs, []);
  });

  test('parsePush_marksDeletesOnly_whenDeleteFlagOrColonRefspec', () => {
    assert.equal(firstPush('git push --delete origin old').deletesOnly, true);
    assert.equal(firstPush('git push -d origin old').deletesOnly, true);
    assert.equal(firstPush('git push origin :old').deletesOnly, true);
    assert.equal(firstPush('git push origin new :old').deletesOnly, false);
  });

  test('parsePush_marksTagsOnly_whenTagsFlagWithoutRefspec', () => {
    assert.equal(firstPush('git push --tags origin').tagsOnly, true);
    assert.equal(firstPush('git push --tags origin main').tagsOnly, false);
  });

  test('parsePush_marksWholeRepo_whenAllOrMirror', () => {
    assert.equal(firstPush('git push --all origin').wholeRepo, true);
    assert.equal(firstPush('git push --mirror').wholeRepo, true);
  });

  test('parsePush_marksDryRun_whenShortOrLongFlag', () => {
    assert.equal(firstPush('git push -n origin feature').dryRun, true);
    assert.equal(firstPush('git push --dry-run origin feature').dryRun, true);
    assert.equal(firstPush('git push -un origin feature').dryRun, true);
    assert.equal(firstPush('git push -u origin feature').dryRun, false);
  });

  test('parsePush_skipsValueFlags_whenPushOptionGiven', () => {
    assert.deepEqual(pushSources(onlyPush('git push -o ci.skip origin feature')), ['feature']);
  });

  test('workdir_followsDashC_whenGitRunsElsewhere', () => {
    assert.equal(onlyPush('git -C /repo/sub push origin main').workdir, '/repo/sub');
  });

  test('workdir_followsCd_acrossChainsAndNewlines', () => {
    const pushes = actions('cd /a && git push origin x; cd ../b\ngit push origin y || true');
    assert.deepEqual(pushes.map((push) => push.workdir), ['/a', '/b']);
  });

  test('workdir_followsPushd_untilPopd', () => {
    const pushes = actions('pushd /a && git push origin x; popd; git push origin y');
    assert.deepEqual(pushes.map((push) => push.workdir), ['/a', '/work']);
  });

  test('heredocBody_isNotAnInvocation_whenItMentionsPush', () => {
    assert.deepEqual(actions("cat <<'EOF' > notes.txt\ngit push origin main\nEOF\nls"), []);
  });

  test('inlineShell_isRead_whenPushHidesInBashDashC', () => {
    const push = onlyPush("bash -c 'cd /inner && git push origin feature'");
    assert.deepEqual([push.workdir, pushSources(push)], ['/inner', ['feature']]);
  });

  test('unbalancedQuote_isReadToTheEnd_andStillGated', () => {
    assert.deepEqual(pushSources(onlyPush('git push origin "feature')), ['feature']);
  });

  test('envPrefixAndRedirection_areIgnored_whenPushHasThem', () => {
    assert.deepEqual(pushSources(onlyPush('GIT_TRACE=1 git push origin feature 2>&1 | tail -n 5')), ['feature']);
  });

  test('wrappers_areStripped_whenPushRunsUnderEnvTimeoutNiceSudo', () => {
    for (const command of ['env GIT_TRACE=1 git push origin feature', 'env git push origin feature',
      'timeout 60 git push origin feature', 'timeout -s KILL 60 git push origin feature',
      'timeout --signal TERM --kill-after 5 60 git push origin feature',
      'nice git push origin feature', 'sudo git push origin feature', 'sudo -E git push origin feature']) {
      assert.deepEqual(pushSources(onlyPush(command)), ['feature'], command);
    }
  });

  test('evalArguments_areReadAsAScript_whenPushHidesInEval', () => {
    const push = onlyPush("eval 'cd /inner && git push origin feature'");
    assert.deepEqual([push.workdir, pushSources(push)], ['/inner', ['feature']]);
  });

  test('heredocBody_isReadAsAScript_whenItFeedsAShell', () => {
    const push = onlyPush("cd /inner && bash <<'EOF' | tail -n 1\ngit push origin feature\nEOF\nls");
    assert.deepEqual([push.workdir, pushSources(push)], ['/inner', ['feature']]);
  });

  test('hereStringAndBackticks_areRead_whenTheySpellAPush', () => {
    for (const command of ["bash <<< 'git push origin feature'", 'echo `git push origin feature`']) {
      assert.deepEqual(pushSources(onlyPush(command)), ['feature'], command);
    }
  });

  test('opaqueWrappers_areUnattributable_whenTheirArgumentsSpellAPushOrMerge', () => {
    assertOnlyUnattributable(['xargs git push origin feature < /dev/null', 'echo feature | xargs git push origin',
      'xargs -0 git push origin feature < /dev/null', 'env --chdir=/elsewhere git push origin feature',
      'parallel -j1 gh pr merge 7 ::: x', 'xargs git pu\\\nsh origin feature < /dev/null']);
  });

  test('opaqueWrappers_areUnattributable_whenTheyRunADashedGitProgramOrARunTimeName', () => {
    for (const command of ['xargs git-push origin feature < /dev/null', 'xargs $CORE/git-push origin feature < /dev/null',
      'xargs /usr/libexec/git-core/git-push origin feature < /dev/null',
      'xargs git send-pack ../app.git feature < /dev/null',
      'xargs gh api -X PATCH repos/acme/app/git/refs/heads/main -f sha=abc < /dev/null',
      'GP="$(git --exec-path)/git-push"; xargs $GP origin feature < /dev/null',
      'S=push; xargs git $S origin feature < /dev/null',
      'R=acme/app; echo x | xargs gh api -X PATCH repos/$R/git/refs/heads/main -f sha=abc',
      'env --chdir=$D true; echo push']) {
      const unattributable = actions(command).filter((action): action is Unattributable => action.kind === 'unattributable');
      assert.equal(unattributable.length, 1, command);
      assert.match(unattributable[0]!.why, /wraps it/, command);
      assert.equal(unattributable[0]!.userCommand, 'cd /work && ' + command);
    }
    assertNoActions(['git log --format=%H | xargs echo push', "find . -name '*.orig' | xargs rm",
      'xargs grep -l merge < files.txt', 'ls .git/refs/heads | xargs -n1 git log -1']);
  });

  test('everyArgvForwarder_isUnattributable_whenItCarriesAnOptionTheParserDoesNotRead', () => {
    for (const name of [...ARGV_FORWARDERS].sort()) {
      const action = actions(name + ' --no-such-option git push origin feature')[0];
      assert.equal(action?.kind, 'unattributable', name);
      assert.ok((action as Unattributable).why.includes(`\`${name}\` wraps it`), name);
    }
  });

  test('scriptAWrapperRunsElsewhere_isUnattributable_notAPushFromTheCallsDirectory', () => {
    assertOnlyUnattributable(["sudo --chdir /tmp sh -c 'git push origin feature'", "sudo -D /tmp bash -c 'gh pr merge 7'",
      'sudo -D /tmp sh -c "sh -c \'git push origin feature\'"']);
  });

  test('substitutionUnderAnAttributableCommand_isStillJudged', () => {
    const pushes = actions('gh pr create --title "$(git push origin feature)"').filter((action) => action.kind === 'push');
    assert.deepEqual(pushes.map((push) => push.words), [['git', 'push', 'origin', 'feature']]);
    const kinds = new Set(actions('gh pr merge 7 $(git push origin feature)').map((action) => action.kind));
    assert.ok(kinds.has('merge') && kinds.has('push'), [...kinds].join());
  });

  test('wrapperClusterOfKnownOptions_isReadAsTheCommandItRuns', () => {
    for (const command of ['sudo -nE git push origin feature', 'exec -la foo git push origin feature',
      "exec -la git sh -c 'git push origin feature'"]) {
      assert.equal(only(command).kind, 'push', command);
    }
    assert.equal(only('exec -la foo $GIT push origin feature').kind, 'unattributable');
  });

  test('wrapperWithAnOptionTheParserDoesNotRead_isUnattributable_whenItRunsGitAShellOrARunTimeName', () => {
    for (const command of ['sudo --chdir /tmp git push origin feature', 'sudo -D /tmp git push origin feature',
      'sudo -iu bob git push origin feature',
      'sudo -iu git git push origin feature', 'sudo --chdir /srv/git git push origin feature',
      'sudo -D /srv/gh gh pr merge 7 --squash', "sudo --chdir /tmp sh -c 'git push origin feature'",
      'sudo -i git push origin feature',
      'env --chdir=/tmp git push origin feature']) {
      const action = actions(command)[0];
      assert.equal(action?.kind, 'unattributable', command);
      assert.match((action as Unattributable).why, /wraps it/, command);
    }
  });

  test('unwrappedProgram_staysAttributable_besideAPushOrMergeSpelling', () => {
    assertNoActions(['git merge-base main HEAD && timeout 60 cat "$F"',
      'base=$(git merge-base main HEAD) && nice -n 5 make -C "$DIR"',
      'git merge-base main HEAD; env FOO=1 python3 "$SCRIPT"', 'git merge-base main HEAD; command -v git',
      'cd /x/sg-push-spellings && timeout 120 ls hooks/git-guard',
      'git merge-base main HEAD && timeout 60 grep git README',
      'env LC_ALL=C grep -rn gh docs; git merge-base --is-ancestor main HEAD']);
    for (const command of ['command -v git && git push origin feature', 'timeout 30 which git && git push origin feature']) {
      assert.equal(only(command).kind, 'push', command);
    }
  });

  test('runtimeCommandName_isUnattributable_onlyWhenTheCallSpellsAPushOrMerge', () => {
    assertOnlyUnattributable(['GIT=git; $GIT push origin feature', 'CMD=\'git push origin feature\'; eval "$CMD"',
      '$(which git) push origin feature', 'GIT=git; S=push; $GIT $S origin feature',
      "sh -c 'GIT=git; S=push; $GIT $S origin feature'", 'GIT=git; $GIT $(echo push) origin feature']);
    assertNoActions(['$EDITOR notes.md && git status', 'GIT=git; S=status; $GIT $S', 'GH=gh; $GH api repos/acme/app/pulls/7']);
  });

  test('runtimeProgramWord_isUnattributable_whenThePushOrMergeWordSitsElsewhereInTheCall', () => {
    for (const command of ['GP="$(git --exec-path)/git-push"; $GP origin main',
      'P=push; GP="$(git --exec-path)/git-$P"; $GP origin main',
      'for GP in "$(git --exec-path)/git-push"; do $GP origin main; done',
      'GH=gh; $GH api -X PATCH repos/acme/app/git/refs/heads/main -f sha=abc',
      'GH=gh; X=refs/heads/main; $GH api -X PATCH repos/acme/app/git/$X -f sha=abc',
      'eval "$(ssh-agent -s)" && git log --oneline | grep push']) {
      assert.ok(actions(command).some((action) => action.kind === 'unattributable'), command);
    }
  });

  test('runtimeProgramWord_isUnattributable_whenItsOwnTextHoldsAPushOrMergeWord', () => {
    for (const command of ['$CORE/git-push origin main', '"$(git --exec-path)"/git-push origin main', '$X/git-merge feature']) {
      const action = onlyUnattributable(command);
      assert.match(action.why, /run time/, command);
    }
    assertNoActions(['$EDITOR notes.md', 'KEEL=k; $KEEL snapshot .', '$EDITOR notes.md && cat .git/refs/heads/main',
      '$EDITOR x && cat docs/merges.md', '$EDITOR x && git log --merges']);
  });

  test('runtimeSubcommand_isUnattributable_evenWhenTheCallNeverSpellsPush', () => {
    for (const command of ['S=push; git $S origin feature', 'git $(echo push) origin feature',
      'SUB=push\ngit "$SUB" origin feature', 'git ${SUB:-push} origin feature',
      'S=$(echo cHVzaA== | base64 -d); git $S origin feature', 'P=pus; git ${P}h origin feature',
      'S=status; git $S']) {
      assert.match(onlyUnattributable(command).why, /run time/, command);
    }
  });

  test('gitPushPlumbing_isUnattributable_whenItPushesWithoutGitPush', () => {
    for (const command of ['git send-pack ../app.git feature', 'git http-push https://example.invalid/app.git feature',
      'git subtree push --prefix=lib origin feature', 'git subtree -P lib push origin feature',
      'git-send-pack ../app.git feature']) {
      assert.match(onlyUnattributable(command).why, /outside the gate/, command);
    }
    assertNoActions(['git subtree split --prefix=lib', 'git send-email x.patch']);
  });

  test('push_isUnattributable_whenGitIsPointedAtAnotherRepository', () => {
    for (const command of ['git --git-dir=/x/.git --work-tree=/x push origin feature',
      'git --git-dir /x/.git --work-tree /x push origin feature',
      'GIT_DIR=/x/.git GIT_WORK_TREE=/x git push origin feature',
      'export GIT_WORK_TREE=/x; git push origin feature']) {
      assert.match(onlyUnattributable(command).why, /another repository/, command);
    }
    assertNoActions(['GIT_DIR=/x/.git git status']);
    assert.equal(actions('git -C /x push origin feature')[0]?.kind, 'push');
  });

  test('ghApiMerge_isUnattributable_whenEndpointMergesAPull', () => {
    assertOnlyUnattributable(['gh api -X PUT repos/acme/app/pulls/7/merge',
      'gh api --method PUT /repos/acme/app/pulls/7/merge -f sha=abc']);
    assertNoActions(['gh api repos/acme/app/pulls/7']);
  });

  test('ghApi_isUnattributable_whenItMergesABranchOrWritesARef', () => {
    const mutation = (name: string) => `gh api graphql -f query='mutation { ${name}(input: {}) { clientMutationId } }'`;
    assertOnlyUnattributable(['gh api -X POST repos/acme/app/merges -f base=main -f head=feature',
      'gh api repos/{owner}/{repo}/merges -f base=main -f head=feature',
      'gh api -X PATCH repos/acme/app/git/refs/heads/main -f sha=abc',
      'gh api --method=PATCH https://api.github.com/repos/acme/app/git/refs/heads/main -F force=true',
      'gh api repos/acme/app/git/refs -f ref=refs/heads/x -f sha=abc',
      'gh api -XDELETE repos/acme/app/git/refs/heads/x', 'gh api --method=DELETE repos/acme/app/git/refs/heads/x',
      'gh api -X GET -X PATCH repos/acme/app/git/refs/heads/main --input body.json',
      'R=acme/app; gh api -X PATCH repos/$R/git/refs/heads/main -f sha=abc',
      'R=acme/app; gh api repos/$R/merges -f base=main -f head=feature',
      'N=7; gh api -X PUT repos/acme/app/pulls/$N/merge',
      'GH=gh; X=git/refs/heads/main; $GH api -X PATCH repos/acme/app/$X -f sha=abc',
      'GH=gh; X=merges; $GH api repos/acme/app/$X -f base=main -f head=feature',
      'X=git/refs/heads/main; gh api -X PATCH repos/acme/app/$X -f sha=abc',
      'gh api -X PATCH "$E" -f sha=abc', 'M=merge; gh api -X PUT repos/acme/app/pulls/7/$M',
      'X=merges; gh api repos/acme/app/$X -f base=main -f head=feature',
      'Q=\'mutation { updateRefs(input: {}) { clientMutationId } }\'; gh api graphql -f query="$Q"',
      'KV=\'query=mutation { mergeBranch(input: {}) { clientMutationId } }\'; gh api graphql -f "$KV"',
      'gh api graphql -F "$KV"', 'gh api graphql --raw-field="$KV"', 'gh api graphql -f"$K=$V"',
      "gh api -H 'Accept: application/json' -X PATCH \"$E\" -f sha=abc",
      'gh api -f sha=abc -X PATCH "$E"', 'gh api --jq .sha repos/acme/app/$X -f base=main -f head=feature',
      'gh api graphql -F="$KV"', 'gh api graphql -if "$KV"', 'gh api graphql $F', 'gh api $F graphql',
      'gh api $F repos/acme/app/git/refs/heads/main', 'gh api -$O repos/acme/app/git/refs/heads/main',
      'gh api --$O repos/acme/app/git/refs/heads/main', 'gh api graphql -$O', 'gh api -i$O repos/acme/app/pulls/7',
      'gh api graphql "${ARGS[@]}"', 'gh api -iX PATCH repos/acme/app/git/refs/heads/main -f sha=abc',
      'gh api -iXPATCH repos/acme/app/git/refs/heads/main',
      mutation('updateRefs'), mutation('createRef'), mutation('mergeBranch'), mutation('enablePullRequestAutoMerge')]);
    assertNoActions(['gh api repos/acme/app/git/refs/heads/main', 'gh api -X GET repos/acme/app/git/refs -f per_page=1',
      'gh api repos/acme/app/git/refs/heads/main --jq .object.sha',
      'gh api -X HEAD repos/acme/app/git/refs/heads/main', 'gh api -X get repos/acme/app/git/refs/heads/main',
      'gh api "$E"', 'gh api graphql -f query=\'query { viewer { login } }\' -F owner="$O"',
      'T=x; gh api -f title="$T" -X POST repos/acme/app/issues',
      'gh api -i repos/acme/app/git/refs/heads/main', 'gh api -X=GET repos/acme/app/git/refs -f per_page=1',
      'gh api --jq .object.sha "$E"', 'gh api -q .sha "$E"', "gh api -H 'Accept: application/json' \"$E\"",
      "gh api --header 'Accept: application/json' \"$E\"", 'gh api -H"$H" repos/acme/app/pulls/7',
      'gh api --jq="$J" repos/acme/app/pulls/7', 'gh api -H"$H" "$E"']);
  });

  test('otherCommands_produceNoAction_whenPushIsOnlyAWordOrInsideOneWord', () => {
    assertNoActions(["grep -n 'git push' notes.md; git stash push; git config push.default simple",
      "echo 'git push' > notes.md && git log --oneline | grep merge"]);
  });

  test('assignments_reachTheCommand_whenPrefixedExportedOrInherited', () => {
    const merges = actions('GH_REPO=acme/app gh pr merge 7; export GH_REPO=acme/lib; gh pr merge 8; ' +
      "env GH_REPO=acme/x bash -c 'gh pr merge 9'") as Merge[];
    assert.deepEqual(merges.map((merge) => merge.repoEnv), ['acme/app', 'acme/lib', 'acme/x']);
  });

  test('parseMerge_readsMatchHeadAndRepo_whenGiven', () => {
    const merge = onlyMerge("gh pr merge 12 --repo acme/app --auto --match-head-commit abc123 --body 'merge it'");
    assert.deepEqual([merge.selector, merge.repoFlag, merge.auto, merge.matchHead], ['12', 'acme/app', true, 'abc123']);
  });

  test('mergeTargetKey_prefersAnyNamedRepo_overTheCwdClone', () => {
    const byUrl = onlyMerge('gh pr merge https://github.com/ACME/app/pull/7 --squash');
    const byEnv = onlyMerge('GH_REPO=github.com/acme/app gh pr merge 7');
    const byNumber = onlyMerge('gh pr merge 7');
    assert.equal(mergeTargetKey(byUrl), 'acme/app');
    assert.equal(mergeTargetKey(byEnv), 'acme/app');
    assert.equal(mergeTargetKey(byNumber), null);
  });

  test('parseMerge_readsEqualsForm_whenMatchHeadUsesEquals', () => {
    const merge = onlyMerge('gh pr merge --match-head-commit=abc123');
    assert.deepEqual([merge.selector, merge.matchHead], [null, 'abc123']);
  });

  test('parseMerge_readsTheRepoFlag_beforeOrBetweenTheSubcommandWords', () => {
    for (const command of ['gh -R acme/app pr merge 7 --squash', 'gh pr -R acme/app merge 7 --squash',
      'gh --repo=acme/app pr merge 7 --squash', 'gh pr --repo acme/app merge 7 --squash']) {
      const merge = onlyMerge(command);
      assert.deepEqual([merge.selector, merge.repoFlag], ['7', 'acme/app'], command);
    }
  });

  test('parsePush_readsTheRemote_whenOneIsGiven', () => {
    assert.equal(firstPush('git push upstream feature').remote, 'upstream');
    assert.equal(firstPush('git push --all origin').remote, 'origin');
    assert.equal(firstPush('git push -u').remote, null);
  });

  test('workdir_followsDashC_throughHomeFormsAndExportedVariables', () => {
    withHome('/home/u', () => {
      for (const command of ['git -C $HOME/app push origin x', 'git -C ${HOME}/app push origin x',
        'git -C ~/app push origin x', 'export APP=/home/u/app; git -C $APP push origin x']) {
        const push = onlyPush(command);
        assert.deepEqual([push.workdir, push.words], ['/home/u/app', ['git', 'push', 'origin', 'x']], command);
      }
    });
  });

  test('mayPushOrMerge_isFalse_whenTheCallHasNoPushOrMergeWordAndNoRunTimeGit', () => {
    for (const call of ['gh pr create --title t --body b', 'git status && git log --oneline', 'echo $HOME', '',
      'cat .git/refs/heads/main', 'cat docs/merges.md']) {
      assert.equal(mayPushOrMerge(call), false, call);
    }
  });

  test('otherGitCommands_produceNoAction_whenNotDecisionPoints', () => {
    assert.deepEqual(actions('git checkout main && git merge feature && git status'), []);
  });
});

function featureRepo(t: TestContext, files: Record<string, string> = { 'src/a.py': 'x\n' }, registry?: string[]) {
  const sandbox = new Sandbox(t, registry);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(files);
  return { sandbox, repo };
}

describe('HookBehaviorTest', () => {
  test('hook_passesQuietly_whenCommandIsNotADecisionPoint', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.push(repo, 'git status && ls -la');
    assert.deepEqual([run.rc, run.stdout, run.stderr], [0, '', '']);
    assert.deepEqual(sandbox.fires(), []);
  });

  test('hook_passesSilently_whenTheEventIsNotPreToolUseBash', (t) => {
    const { sandbox, repo } = featureRepo(t, LOGIC_WITH_TEST);
    const afterPush = sandbox.bashPayload(repo, 'git push origin feature');
    afterPush.hook_event_name = 'PostToolUse';
    const read = sandbox.bashPayload(repo, '');
    Object.assign(read, { tool_name: 'Read', tool_input: { file_path: 'README.md' } });
    for (const payload of [afterPush, read]) {
      const run = sandbox.hook(payload);
      assert.deepEqual([run.rc, run.stdout, run.stderr], [0, '', ''], `${payload.hook_event_name} ${payload.tool_name}`);
    }
    assert.deepEqual(sandbox.fires(), []);
  });

  test('push_isJudgedAsThatClone_whenDashCNamesItThroughHome', (t) => {
    const { sandbox, repo } = featureRepo(t, LOGIC_WITH_TEST);
    sandbox.env['HOME'] = dirname(repo.path);
    for (const target of ['$HOME/app', '${HOME}/app', '~/app']) {
      const payload = sandbox.bashPayload(repo, `git -C ${target} push origin feature`);
      payload.cwd = sandbox.root;
      const run = sandbox.hook(payload);
      assert.equal(run.rc, 2, target + run.stderr + run.stdout);
      assert.ok(run.stderr.includes('- [K1] no review evidence for acme/app'), run.stderr);
      assert.equal(lastLine(run.stderr), `Run it yourself in your terminal: cd ${repo.path} && git push origin feature`);
    }
  });

  test('runtimeSpellings_endWithTheWholeCallAsTheUserCommand', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    for (const command of ['R=origin; git push $R feature', 'R=origin; git push "$R" feature',
      'S=push; git $S origin feature', 'GIT=git; $GIT push origin feature']) {
      const run = sandbox.push(repo, command);
      assert.equal(run.rc, 2, command + run.stderr + run.stdout);
      assert.equal(lastLine(run.stderr), `Run it yourself in your terminal: cd ${shlexQuote(repo.path)} && ${command}`);
    }
  });

  test('configOverrideSpellings_endWithTheWholeCallAsTheUserCommand', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    for (const command of ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.pushDefault GIT_CONFIG_VALUE_0=origin git push',
      'git config remote.pushDefault origin && git push']) {
      const run = sandbox.push(repo, command);
      assert.equal(run.rc, 2, command + run.stderr + run.stdout);
      assert.ok(run.stderr.includes('changes git config the gate reads from the clone'), run.stderr);
      assert.equal(lastLine(run.stderr), `Run it yourself in your terminal: cd ${shlexQuote(repo.path)} && ${command}`);
    }
  });

  test('push_passesWithAnErrorLine_whenDashCCannotBeResolvedAndNoRepoIsGated', (t) => {
    for (const registry of [NOT_GATED_REGISTRY, null]) {
      const sandbox = new Sandbox(t, registry ?? undefined);
      if (registry === null) sandbox.removeRegistry();
      const repo = sandbox.clone('acme', 'app');
      const run = sandbox.push(repo, 'git -C $NO_SUCH_VARIABLE/app push origin main');
      assert.equal(run.rc, 0, run.stderr + run.stdout);
      assert.ok(sandbox.fires('K1', 'error')[0].detail.includes('not a git repository'));
    }
  });

  test('push_failsClosed_whenDashCCannotBeResolvedAndARepoIsGated', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.push(repo, 'git -C $NO_SUCH_VARIABLE/app push origin main');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('failing closed'), run.stderr);
  });

  test('push_passesTagsDeletesAndDryRuns_butGatesATagPushedAsABranch', (t) => {
    const { sandbox, repo } = featureRepo(t, { 'src/a.py': 'x\n' });
    const head = repo.head();
    repo.git('tag', 'v1');
    for (const command of ['git push --delete origin feature', 'git push origin :feature', 'git push origin v1',
      'git push origin refs/tags/v1', 'git push origin v1:refs/tags/v1', 'git push --tags origin', 'git push -n origin feature']) {
      assert.equal(sandbox.push(repo, command).rc, 0, command);
    }
    assert.equal(sandbox.fires('risk', 'pass').length, 7);
    assert.equal(sandbox.fires('risk', 'pass')[2].head, head);
    for (const command of ['git push origin v1:feature', 'git push origin refs/tags/v1:refs/heads/feature']) {
      const run = sandbox.push(repo, command);
      assert.equal(run.rc, 2, command + run.stderr);
      assert.ok(run.stderr.includes(NO_REVIEW), run.stderr);
    }
    assert.equal(sandbox.fires('risk', 'pass').length, 7);
  });

  test('push_deniesWholeRepoPush_whenRepoIsGated', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.push(repo, 'git push --all origin');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('- [F-irreversible] git push --all/--mirror'), run.stderr);
  });

  test('push_isStillGated_whenQuotesAreUnbalanced', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    for (const command of ['git push origin "feature', 'git pu\'\'sh origin "feature']) {
      const run = sandbox.push(repo, command);
      assert.equal(run.rc, 2, command + run.stderr + run.stdout);
      assert.ok(!run.stderr.includes('Traceback'), run.stderr);
    }
  });

  function assertPushDenied(t: TestContext, command: string, reason: string, registry?: string[]) {
    const { sandbox, repo } = featureRepo(t, { 'src/a.py': 'x\n' }, registry);
    const run = sandbox.push(repo, command);
    assert.equal(run.rc, 2, `${command}: ${run.stderr}${run.stdout}`);
    assert.ok(run.stderr.includes(reason), run.stderr);
    assert.equal(sandbox.fires(undefined, 'deny')[0].rule_id, 'K1');
    assert.equal(sandbox.fires('risk', 'pass').length, 0);
    return run;
  }

  test('push_denies_whenWrappedInEnv', (t) => {
    assertPushDenied(t, 'env GIT_TRACE=1 git push origin feature', NO_REVIEW);
  });

  test('push_denies_whenWrappedInTimeout', (t) => {
    assertPushDenied(t, 'timeout 60 git push origin feature', NO_REVIEW);
  });

  test('push_denies_whenWrappedInNice', (t) => {
    assertPushDenied(t, 'nice git push origin feature', NO_REVIEW);
  });

  test('push_denies_whenWrappedInSudo', (t) => {
    assertPushDenied(t, 'sudo git push origin feature', NO_REVIEW);
  });

  test('push_denies_whenWrappedInEval', (t) => {
    assertPushDenied(t, "eval 'git push origin feature'", NO_REVIEW);
  });

  test('push_denies_whenFedToBashByHeredoc', (t) => {
    assertPushDenied(t, "bash <<'EOF'\ngit push origin feature\nEOF", NO_REVIEW);
  });

  test('push_denies_whenSubcommandIsQuoted', (t) => {
    assertPushDenied(t, "git pu''sh origin feature", NO_REVIEW);
  });

  test('push_denies_whenXargsRunsIt', (t) => {
    assertPushDenied(t, 'xargs -0 git push origin feature < /dev/null', UNATTRIBUTABLE);
    assertPushDenied(t, 'echo feature | xargs git push origin', UNATTRIBUTABLE);
  });

  test('merge_denies_whenGhApiMergesThePull', (t) => {
    const run = assertPushDenied(t, 'gh api -X PUT repos/acme/app/pulls/7/merge', UNATTRIBUTABLE);
    assert.ok(run.stderr.includes('gh api'), run.stderr);
  });

  test('unattributablePush_denies_evenWhenCwdRepoIsOff', (t) => {
    assertPushDenied(t, 'xargs git push origin feature < /dev/null', UNATTRIBUTABLE, ['acme/app\toff\tmain\t-\tnone']);
  });

  test('push_passes_whenWrappedInEnvAndBundleIsComplete', (t) => {
    const { sandbox, repo } = featureRepo(t, LOGIC_WITH_TEST);
    sandbox.fullBundle(repo);
    const run = sandbox.push(repo, 'env GIT_TRACE=1 timeout 60 git push origin feature');
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(sandbox.fires('risk', 'pass').at(-1).repo, 'acme/app');
  });

  test('push_logsFilesAndLines_onPassAndOnDeny', (t) => {
    const { sandbox, repo } = featureRepo(t, LOGIC_WITH_TEST);
    const denied = sandbox.push(repo, 'git push origin feature');
    assert.equal(denied.rc, 2);
    sandbox.pushBundle(repo);
    const passed = sandbox.push(repo, 'git push origin feature');
    assert.equal(passed.rc, 0, passed.stderr);
    const denyLine = sandbox.fires('K1', 'deny')[0];
    const passLine = sandbox.fires('risk', 'pass').at(-1);
    assert.deepEqual([denyLine.files, denyLine.lines], [2, 3]);
    assert.deepEqual([passLine.files, passLine.lines], [2, 3]);
  });

  test('push_failsClosed_whenRefspecSourceNamesNoCommit', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.push(repo, 'git push origin no-such-branch');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('failing closed'), run.stderr);
    assert.ok(run.stderr.includes('refspec source no-such-branch does not name a commit'), run.stderr);
    assert.equal(sandbox.fires('K1', 'error')[0].repo, 'acme/app');
  });

  test('push_failsClosed_whenWorkdirIsNotARepo', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.push(repo, 'cd /nonexistent-dir && git push origin feature');
    assert.equal(run.rc, 2);
    assert.ok(run.stderr.includes('not a git repository'), run.stderr);
  });

  test('push_failsClosed_whenFiresLogIsUnwritableInGatedRepo', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    sandbox.makeLogsUnwritable();
    const run = sandbox.push(repo, 'git push origin main');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('failing closed'), run.stderr);
    assert.ok(run.stderr.includes('keel-fires.jsonl'), run.stderr);
    assert.ok(!run.stderr.includes('Traceback'), run.stderr);
    assert.ok(run.stderr.includes('Run it yourself in your terminal: git push origin main'), run.stderr);
  });

  test('mergeSpellings_failClosed_whenFiresLogIsUnwritableInGatedRepo', (t) => {
    for (const command of ['gh pr merge 7 --squash', 'gh api -X PUT repos/acme/app/pulls/7/merge',
      'S=push; git $S origin main', 'git -c remote.pushDefault=origin push',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.pushDefault GIT_CONFIG_VALUE_0=origin git push']) {
      const sandbox = new Sandbox(t);
      const repo = sandbox.clone('acme', 'app');
      sandbox.makeLogsUnwritable();
      const run = sandbox.push(repo, command);
      assert.equal(run.rc, 2, command + run.stderr + run.stdout);
      assert.ok(run.stderr.includes('failing closed'), run.stderr);
      assert.ok(!run.stderr.includes('Traceback'), run.stderr);
    }
  });

  test('push_failsClosed_whenFiresLogIsUnwritableEvenIfRepoIsOff', (t) => {
    const sandbox = new Sandbox(t, ['acme/app\toff\tmain\t-\tnone']);
    const repo = sandbox.clone('acme', 'app');
    sandbox.makeLogsUnwritable();
    const run = sandbox.push(repo, 'git push origin main');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('keel-fires.jsonl'), run.stderr);
    assert.ok(!run.stderr.includes('Traceback'), run.stderr);
  });

  test('nonPushCommand_passes_whenFiresLogIsUnwritable', (t) => {
    const { sandbox, repo } = featureRepo(t, { 'src/a.py': 'print(1)\n' });
    sandbox.makeLogsUnwritable();
    const run = sandbox.push(repo, 'gh pr create --title t --body b');
    assert.equal(run.rc, 0, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('internal error on a command that is not a push or merge'), run.stderr);
  });

  test('hook_failsClosed_whenPayloadIsUnreadableAndNamesAPush', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.hookRaw('{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin main"');
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.startsWith('[K1] ship-gate: internal error'), run.stderr);
    assert.ok(!run.stderr.includes('Traceback'), run.stderr);
  });

  test('hook_logsContractMissAndPasses_whenToolInputIsNotAnObject', (t) => {
    const sandbox = new Sandbox(t);
    sandbox.stubClaude();
    const run = sandbox.hookRaw(JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: 'gh pr merge 7 --squash',
    }));
    assert.deepEqual([run.rc, run.stderr], [0, '']);
    assert.ok(sandbox.fires(undefined, 'contract-miss')[0].detail.includes('missing tool_input.command'));
  });

  test('hook_passes_whenPayloadIsUnreadableAndHarmless', (t) => {
    const sandbox = new Sandbox(t);
    const run = sandbox.hookRaw('not json');
    assert.equal(run.rc, 0, run.stderr + run.stdout);
    assert.ok(!run.stderr.includes('Traceback'), run.stderr);
  });

  test('hook_logsContractMiss_whenBashPayloadLacksCommand', (t) => {
    const sandbox = new Sandbox(t);
    sandbox.stubClaude();
    const repo = sandbox.clone('acme', 'app');
    const payload = sandbox.bashPayload(repo, 'git status');
    delete payload.tool_input.command;
    const run = sandbox.hook(payload);
    assert.deepEqual([run.rc, run.stderr], [0, '']);
    const lines = sandbox.fires(undefined, 'contract-miss');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].rule_id, 'K1');
    assert.ok(lines[0].detail.includes('missing tool_input.command;'), lines[0].detail);
    assert.ok(lines[0].detail.includes('cc_version=9.9.9'), lines[0].detail);
  });

  test('hook_logsNoContractMiss_whenOnlyCwdIsMissing', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const payload = sandbox.bashPayload(repo, 'git status');
    delete payload.cwd;
    const run = sandbox.hook(payload);
    assert.deepEqual([run.rc, run.stderr], [0, '']);
    assert.deepEqual(sandbox.fires(undefined, 'contract-miss'), []);
  });

  test('hook_logsNoContractMiss_whenPayloadIsComplete', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    sandbox.push(repo, 'git status');
    assert.deepEqual(sandbox.fires(undefined, 'contract-miss'), []);
  });

  test('push_warnsOncePerSession_whenRegistryIsAbsent', (t) => {
    const sandbox = new Sandbox(t);
    sandbox.removeRegistry();
    const repo = sandbox.clone('acme', 'app');
    const first = sandbox.push(repo, 'git push origin main');
    const second = sandbox.push(repo, 'git push origin main');
    assert.ok(first.context.includes('every repo is off'), first.context);
    assert.equal(second.context, '');
    assert.equal(sandbox.fires('K1', 'warn').length, 1);
    assert.equal(sandbox.fires('risk', 'pass').length, 2);
  });

  test('prCreate_warnsWhatIsMissing_whenBranchLacksEvidence', (t) => {
    const { sandbox, repo } = featureRepo(t, { 'src/a.py': 'x\n' });
    const run = sandbox.push(repo, 'gh pr create --title t --body b');
    assert.equal(run.rc, 0, run.stderr);
    assert.ok(run.context.includes('not ready to ship feature of acme/app (risk standard)'), run.context);
    assert.ok(run.context.includes(NO_REVIEW), run.context);
    assert.ok(run.context.includes('- [K3] no tests evidence'), run.context);
    assert.deepEqual(new Set(sandbox.fires(undefined, 'warn').map((line) => line.rule_id)), new Set(['K1', 'K3']));
  });

  test('gc_runsOncePerDay_whenAPushIsJudged', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    sandbox.push(repo, 'git push origin main');
    sandbox.push(repo, 'git push origin main');
    assert.equal(sandbox.fires('K1', 'record').filter((line) => line.detail.includes('gc')).length, 1);
    assert.ok(existsSync(join(sandbox.data, 'state', 'keel', 'gc.stamp')));
  });
});

describe('EarlyWarningTest', () => {
  test('prCreate_saysReady_whenBundleIsComplete', (t) => {
    const { sandbox, repo } = featureRepo(t, LOGIC_WITH_TEST);
    sandbox.fullBundle(repo);
    const run = sandbox.push(repo, 'gh pr create --title t --body b');
    assert.ok(run.context.includes('ready to ship feature of acme/app (risk standard)'), run.context);
    assert.equal(sandbox.fires('K1', 'warn')[0].root_run_id, 'rv-root-0001');
  });

  test('prCreate_namesTheApproval_whenOnlyTheMergeApprovalIsMissing', (t) => {
    const { sandbox, repo } = featureRepo(t, LOGIC_WITH_TEST);
    sandbox.pushBundle(repo);
    const run = sandbox.push(repo, 'gh pr create --title t --body b');
    assert.ok(run.context.includes('- [K1] no approval bound to chain head'), run.context);
  });
});

describe('SubprocessBudgetTest', () => {
  test('subprocessTimeouts_fitUnderTheRegisteredTimeout', () => {
    const registered = shipGateTimeout();
    assert.ok(gitcmd.GIT_TIMEOUT_SECONDS + DECISION_MARGIN_SECONDS < registered);
    const mergeNetwork = 2 * gitcmd.FETCH_TIMEOUT_SECONDS + GH_TIMEOUT_SECONDS;
    assert.ok(mergeNetwork + DECISION_MARGIN_SECONDS < registered);
  });
});

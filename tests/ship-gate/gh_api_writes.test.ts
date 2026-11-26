import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { callActions, mayPushOrMerge } from '../../hooks/ship-gate/ship-gate.ts';
import type { GhApiWrite } from '../../hooks/ship-gate/ship-gate.ts';
import { Sandbox } from './helpers.ts';

const GATED_AND_LIB = ['acme/app\tcode\tmain\tacme\trequired', 'acme/lib\toff\tmain\t-\tnone'];
const OUTSIDE_ALLOW_LIST = '`gh api` writes to acme/app outside the allow-list';
const UNKNOWN_REPO = '`gh api` writes to a repo the gate cannot name';
const CONTENTS_WRITE = 'gh api -X PUT repos/{owner}/{repo}/contents/a.py -f branch=main';

function onlyWrite(command: string): GhApiWrite {
  const found = callActions(command, '/work');
  assert.equal(found.length, 1, `${command}: ${JSON.stringify(found)}`);
  assert.equal(found[0]!.kind, 'ghApiWrite', command);
  return found[0] as GhApiWrite;
}

describe('GhApiWriteParseTest', () => {
  test('literalRepo_isNamed_afterTheEndpointIsNormalized', () => {
    for (const command of ['gh api -X PUT repos/acme/app/contents/a.py -f branch=main',
      'gh api -X PUT /repos/ACME/App/contents/a.py', "gh api -X PUT 'repos/acme/app/contents/a.py?ref=x#y'",
      'gh api --method=PUT https://api.github.com/repos/acme/app/contents/a.py',
      'gh api -X PUT https://ghe.example.invalid/api/v3/repos/acme/app/contents/a.py',
      'gh api -X PATCH repos/acme/app/ -f default_branch=x']) {
      assert.deepEqual(onlyWrite(command).target, { kind: 'named', key: 'acme/app' }, command);
    }
  });

  test('placeholders_areResolvedLikeGh_fromGhRepoOrTheClone', () => {
    assert.deepEqual(onlyWrite(CONTENTS_WRITE).target, { kind: 'ghDefault', ghRepoEnv: null });
    assert.deepEqual(onlyWrite('gh api -X PUT repos/:owner/:repo/contents/a.py').target, { kind: 'ghDefault', ghRepoEnv: null });
    assert.deepEqual(onlyWrite(`GH_REPO=acme/lib ${CONTENTS_WRITE}`).target, { kind: 'ghDefault', ghRepoEnv: 'acme/lib' });
  });

  test('unnamedRepo_isUnknown_forAnIdAPartialPlaceholderOrAMutation', () => {
    for (const command of ['gh api -X POST repositories/123/merge-upstream',
      'gh api -X PUT repos/{owner}/app/contents/a.py', 'gh api -X PUT repos/acme/{repo}/contents/a.py',
      'gh api -X PATCH repos/acme -f a=b',
      "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'",
      "gh api graphql -f query='mutation M { a: addComment(input: {subjectId: 1}) { clientMutationId } x: createCommitOnBranch(input: {}) { clientMutationId } }'",
      "gh api https://api.github.com/graphql -f query='mutation { createCommitOnBranch(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { ...F } fragment F on Mutation { addComment(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { addComment(input: {subjectId: \"\"\"A\\\"\"\"B\"\"\"}) { clientMutationId } createCommitOnBranch(input: {}) { clientMutationId } addReaction(input: {content: \"\"\"C\"\"\"}) { clientMutationId } }'",
      "gh api graphql -f query='mutation query { createCommitOnBranch(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { addComment(input: {body: \"x}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } #\r createCommitOnBranch(input: {}) { clientMutationId }\n}'",
      "gh api https://ghe.example.invalid/api/graphql -f query='mutation { createCommitOnBranch(input: {}) { clientMutationId } }'",
      'gh api graphql -F query=@mutation.graphql', 'gh api graphql -F query=@-', 'gh api graphql --input body.json']) {
      assert.equal(onlyWrite(command).target.kind, 'unknown', command);
    }
  });

  test('allowListedWritesReadsAndNonRepoEndpoints_produceNoAction', () => {
    for (const command of ['gh api -X POST repos/acme/app/issues -f title=x',
      'gh api -X PATCH repos/acme/app/issues/7 -f state=closed',
      'gh api -X POST repos/acme/app/issues/7/comments -f body=x',
      'gh api -X PATCH repos/acme/app/issues/comments/9 -f body=x',
      'gh api -X DELETE repos/acme/app/issues/comments/9',
      'gh api -X POST repos/acme/app/issues/7/labels -f "labels[]=bug"',
      'gh api -X DELETE repos/acme/app/issues/7/labels/bug',
      'gh api -X POST repos/acme/app/issues/7/assignees -f "assignees[]=me"',
      'gh api -X POST repos/acme/app/labels -f name=bug',
      'gh api -X POST repos/acme/app/pulls/7/comments -f body=x',
      'gh api -X POST repos/acme/app/pulls/7/comments/3/replies -f body=x',
      'gh api -X POST repos/acme/app/issues/comments/9/reactions -f content=+1',
      'gh api -X POST repos/{owner}/{repo}/issues/7/comments -f body=x',
      'gh api -X POST repositories/123/issues/7/comments -f body=x',
      'gh api repos/acme/app/contents/a.py', 'gh api -X GET repos/acme/app/contents/a.py -f ref=main',
      'gh api -X POST gists -f description=x', 'gh api -X PUT user/starred/acme/app',
      'A=pr; gh $A view 7', 'A=api; gh $A repos/acme/app/contents/a.py',
      "gh api graphql -f query='query { viewer { login } }'",
      "gh api graphql -f query='{ viewer { login } }'",
      "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } addReaction(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { a: addLabelsToLabelable(input: {}) { clientMutationId } }'",
      "gh api graphql -F owner=@vars.txt -f query='mutation { addComment(input: {}) { clientMutationId } }'",
      "gh api graphql -H 'query=mutation { createCommitOnBranch }' -f query='mutation { addComment(input: {}) { clientMutationId } }'"]) {
      assert.deepEqual(callActions(command, '/work'), [], command);
    }
  });

  test('dotOrEncodedSegment_isUnknown_soAWildcardCannotSwallowIt', () => {
    for (const command of ['gh api -X DELETE repos/acme/app/issues/..',
      'gh api -X PATCH repos/acme/app/labels/.. -f default_branch=x',
      'gh api -X PUT repos/acme/other/../app/contents/a.py',
      'gh api -X PUT gists/../repos/acme/app/contents/a.py',
      'gh api -X PUT repos/acme/app/./contents/a.py',
      'gh api -X PUT repos/acme/app/issues/%2e%2e/contents/a.py',
      "gh api ./graphql -f query='mutation { createCommitOnBranch(input: {}) { clientMutationId } }'"]) {
      assert.equal(onlyWrite(command).target.kind, 'unknown', command);
    }
  });

  test('forwardedOrWrappedWrite_isUnattributable', () => {
    for (const command of ['xargs gh api -X PUT repos/acme/app/contents/a.py -f branch=main < /dev/null',
      "echo '-X PUT repos/acme/app/contents/a.py' | xargs gh api",
      'A=api; gh $A -X PUT repos/acme/app/contents/a.py',
      'A=pr; gh $A merge 7',
      'gh repo set-default acme/app; gh api -X PUT repos/{owner}/{repo}/contents/a.py',
      'env --chdir=/ gh api -X PUT repos/acme/app/contents/a.py -f branch=main',
      'GH=gh; $GH api -X PUT repos/acme/app/contents/a.py -f branch=main']) {
      const found = callActions(command, '/work');
      assert.deepEqual(found.map((action) => action.kind), ['unattributable'], command);
    }
  });

  test('crashFallback_readsAGhApiWrite_asAPushOrMerge', () => {
    assert.equal(mayPushOrMerge('gh api -X PUT repos/acme/app/contents/a.py -f branch=main'), true);
    assert.equal(mayPushOrMerge("gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'"), true);
  });
});

describe('GhApiWriteJudgeTest', () => {
  test('placeholderWrite_inAGatedClone_isDeniedAndNamesTheRepo', (t) => {
    const sandbox = new Sandbox(t, GATED_AND_LIB);
    const app = sandbox.clone('acme', 'app');
    const run = sandbox.push(app, CONTENTS_WRITE);
    assert.equal(run.rc, 2, run.stderr);
    assert.ok(run.stderr.includes(OUTSIDE_ALLOW_LIST), run.stderr);
    assert.ok(run.stderr.includes('Run it yourself in your terminal: '), run.stderr);
    assert.equal(sandbox.fires('F-irreversible', 'deny').at(-1)?.repo, 'acme/app');
  });

  test('placeholderWrite_followsGhRepo_overTheClone', (t) => {
    const sandbox = new Sandbox(t, GATED_AND_LIB);
    const app = sandbox.clone('acme', 'app');
    assert.equal(sandbox.push(app, `GH_REPO=acme/lib ${CONTENTS_WRITE}`).rc, 0);
    const lib = sandbox.clone('acme', 'lib');
    const run = sandbox.push(lib, `GH_REPO=acme/app ${CONTENTS_WRITE}`);
    assert.equal(run.rc, 2, run.stderr);
    assert.ok(run.stderr.includes(OUTSIDE_ALLOW_LIST), run.stderr);
    assert.equal(sandbox.push(lib, CONTENTS_WRITE).rc, 0);
  });

  test('placeholderWrite_withAnUnreadableGhRepo_isDenied', (t) => {
    const sandbox = new Sandbox(t, GATED_AND_LIB);
    const run = sandbox.push(sandbox.clone('acme', 'app'), `GH_REPO=bad ${CONTENTS_WRITE}`);
    assert.equal(run.rc, 2, run.stderr);
  });

  test('unknownRepoWrite_isDenied_onlyWhileARepoIsGated', (t) => {
    const command = "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'";
    const gated = new Sandbox(t, GATED_AND_LIB);
    const run = gated.push(gated.clone('acme', 'lib'), command);
    assert.equal(run.rc, 2, run.stderr);
    assert.ok(run.stderr.includes(UNKNOWN_REPO), run.stderr);
    const ungated = new Sandbox(t, ['acme/app\toff\tmain\t-\tnone']);
    assert.equal(ungated.push(ungated.clone('acme', 'app'), command).rc, 0);
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { parseJson } from '../../hooks/lib/hookkit/json.ts';
import { RecursionError as HookRecursionError, ValueError } from '../../hooks/lib/hookkit/errors.ts';
import { isRecursionError } from '../../hooks/ship-gate/ship-gate.ts';
import { EvidenceError, EvidenceTooDeepError } from '../../lib/evidence/store.ts';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const PUSH_INSIDE_QUOTES = `'; git push origin feature; echo "`;
const OVER_BOUND = 10_001;
const DENY_TAIL = 'Run it yourself in your terminal: ';

function listCommandPayload(sandbox: Sandbox, repo: Repo, depth: number): string {
  const placeholder = 'LIST_COMMAND';
  const text = JSON.stringify(sandbox.bashPayload(repo, placeholder));
  const nested = '['.repeat(depth) + JSON.stringify(PUSH_INSIDE_QUOTES) + ']'.repeat(depth);
  return text.replace(JSON.stringify(placeholder), nested);
}

function listCommandPush(sandbox: Sandbox, repo: Repo, depth: number) {
  return sandbox.hookRaw(listCommandPayload(sandbox, repo, depth));
}

function reviewedFeature(sandbox: Sandbox): [Repo, string] {
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  const head = repo.commit(LOGIC_WITH_TEST);
  repo.git('push', '-q', 'origin', 'feature');
  sandbox.review(repo, { head });
  sandbox.testsEvidence(repo);
  sandbox.approve('rv-root-0001');
  return [repo, head];
}

function featureRepo(t: TestContext): [Sandbox, Repo] {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(LOGIC_WITH_TEST);
  return [sandbox, repo];
}

describe('RecursionDenialTest', () => {
  test('isRecursionError_recognizesTheHookAndTheStoredEvidenceClassesOnly', () => {
    assert.equal(isRecursionError(new EvidenceTooDeepError('deep')), true);
    assert.equal(isRecursionError(new HookRecursionError('deep')), true);
    assert.equal(isRecursionError(new EvidenceError('deep')), false);
    assert.equal(isRecursionError(new ValueError('deep')), false);
    assert.equal(isRecursionError(new RangeError('deep')), false);
    assert.equal(isRecursionError('deep'), false);
  });

  test('merge_denies_whenGhAnswerNestsPastTheJsonBound', (t) => {
    const sandbox = new Sandbox(t);
    const [repo, head] = reviewedFeature(sandbox);
    writeFileSync(sandbox.ghResponse, `{"baseRefName": "main", "number": ${'['.repeat(OVER_BOUND)}1${']'.repeat(OVER_BOUND)}}`);
    const run = sandbox.push(repo, `gh pr merge 7 --match-head-commit ${head}`);
    assert.equal(run.rc, 2, run.stderr.slice(0, 400));
    assert.ok(run.stderr.includes('RecursionError: JSON nesting is deeper than 10000 levels'), run.stderr.slice(0, 400));
  });

  test('push_denies_whenCommandIsAListNestedPastTheJsonBound', (t) => {
    const [sandbox, repo] = featureRepo(t);
    assert.throws(() => parseJson(listCommandPayload(sandbox, repo, OVER_BOUND)), HookRecursionError);
    const run = listCommandPush(sandbox, repo, OVER_BOUND);
    assert.equal(run.rc, 2, run.stderr.slice(0, 400));
    assert.ok(run.stderr.includes(DENY_TAIL), run.stderr.slice(0, 400));
    assert.ok(!run.stderr.includes('Traceback'), run.stderr.slice(0, 400));
  });

  test('push_judgesTheRenderedCommand_whenCommandIsAListNested3000Deep', (t) => {
    const [sandbox, repo] = featureRepo(t);
    const run = listCommandPush(sandbox, repo, 3000);
    assert.equal(run.rc, 2, run.stderr.slice(0, 400));
    assert.ok(run.stderr.includes('no review evidence'), run.stderr.slice(0, 400));
    assert.equal(listCommandPush(sandbox, repo, 9998).rc, 2);
    const tooDeepForJson = listCommandPush(sandbox, repo, 9999);
    assert.equal(tooDeepForJson.rc, 2, tooDeepForJson.stderr.slice(0, 400));
  });

  test('push_passes_whenApprovedAndSessionIdIsNestedBelowTheBound', (t) => {
    const sandbox = new Sandbox(t);
    const [repo] = reviewedFeature(sandbox);
    const placeholder = 'NESTED_SESSION';
    const text = JSON.stringify(sandbox.bashPayload(repo, 'git push origin feature', { session: placeholder }));
    for (const depth of [3000, 9998]) {
      const run = sandbox.hookRaw(text.replace(JSON.stringify(placeholder), '['.repeat(depth) + '"s1"' + ']'.repeat(depth)));
      assert.equal(run.rc, 0, run.stderr.slice(0, 400));
    }
  });

  test('push_denies_whenStoredReviewEvidenceNestsPastTheJsonBound', (t) => {
    const [sandbox, repo] = featureRepo(t);
    const directory = join(sandbox.data, 'state', 'keel', 'evidence', 'review', 'acme__app');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'review-deep.json'), `{"expires_at": "2099-01-01T00:00:00Z", "n": ${'['.repeat(OVER_BOUND)}${']'.repeat(OVER_BOUND)}}`);
    const run = sandbox.push(repo, 'git push origin feature');
    assert.equal(run.rc, 2, run.stderr.slice(0, 400));
    assert.ok(run.stderr.includes('EvidenceTooDeepError: '), run.stderr.slice(0, 400));
    assert.ok(run.stderr.includes(DENY_TAIL), run.stderr.slice(0, 400));
  });

  test('hook_denies_whenStdinNestsPastTheJsonBoundEvenForAHarmlessCommand', (t) => {
    const [sandbox, repo] = featureRepo(t);
    const text = JSON.stringify(sandbox.bashPayload(repo, 'ls')).slice(0, -1) + `, "extra": ${'['.repeat(OVER_BOUND)}1${']'.repeat(OVER_BOUND)}}`;
    const run = sandbox.hookRaw(text);
    assert.equal(run.rc, 2, run.stderr.slice(0, 400));
    assert.ok(run.stderr.includes(DENY_TAIL), run.stderr.slice(0, 400));
  });
});

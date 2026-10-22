import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { RecursionError as HookRecursionError } from '../../hooks/lib/hookkit/pyruntime.ts';
import { isRecursionError } from '../../hooks/ship-gate/ship-gate.ts';
import { RecursionError as ScannerRecursionError, ValueError } from '../../lib/evidence/pycompat.ts';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const PUSH_INSIDE_QUOTES = `'; git push origin feature; echo "`;
const OVER_BOUND = 10_001;
const DENY_TAIL = 'Run it yourself in your terminal: ';

function listCommandPush(sandbox: Sandbox, repo: Repo, depth: number) {
  const placeholder = 'LIST_COMMAND';
  const text = JSON.stringify(sandbox.bashPayload(repo, placeholder));
  const nested = '['.repeat(depth) + JSON.stringify(PUSH_INSIDE_QUOTES) + ']'.repeat(depth);
  return sandbox.hookRaw(text.replace(JSON.stringify(placeholder), nested));
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
  test('isRecursionError_recognizesTheScannerAndTheStrRendererClassesOnly', () => {
    assert.equal(isRecursionError(new ScannerRecursionError('deep')), true);
    assert.equal(isRecursionError(new HookRecursionError('deep')), true);
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
    assert.ok(run.stderr.includes('RecursionError: maximum recursion depth exceeded while decoding a JSON array'), run.stderr.slice(0, 400));
  });

  test('push_denies_whenCommandIsAListNestedPastTheStrBound', (t) => {
    const [sandbox, repo] = featureRepo(t);
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

  test('hook_denies_whenStdinNestsPastTheJsonBoundEvenForAHarmlessCommand', (t) => {
    const [sandbox, repo] = featureRepo(t);
    const text = JSON.stringify(sandbox.bashPayload(repo, 'ls')).slice(0, -1) + `, "extra": ${'['.repeat(OVER_BOUND)}1${']'.repeat(OVER_BOUND)}}`;
    const run = sandbox.hookRaw(text);
    assert.equal(run.rc, 2, run.stderr.slice(0, 400));
    assert.ok(run.stderr.includes(DENY_TAIL), run.stderr.slice(0, 400));
  });
});

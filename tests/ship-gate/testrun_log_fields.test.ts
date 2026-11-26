import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Sandbox } from './helpers.ts';

const FAILURES_RECOGNIZED = 6;

function lastLogRecord(sandbox: Sandbox): any {
  return JSON.parse(readFileSync(join(sandbox.data, 'logs', 'keel-tests.jsonl'), 'utf8').trim().split('\n').at(-1)!);
}

describe('TestrunLogFieldsTest', () => {
  test('keelTest_logsTheFailingTestNamesAndAHandPickedSelection_whenTheCommandFails', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "printf 'ok 1 - a\\nnot ok 2 - b\\n1..2\\n# pass 1\\n# fail 1\\n'; exit 1"], { cwd: repo.path });
    assert.equal(run.rc, 1, run.stderr);
    assert.deepEqual([lastLogRecord(sandbox).failed_tests, lastLogRecord(sandbox).selection], [['b'], 'command']);
  });

  test('keelTest_logsTheFailingTestNames_whenTheyHideBehindAGreenExit', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "printf 'ok 1 - a\\nnot ok 2 - b\\n1..2\\n# pass 1\\n# fail 1\\n'"], { cwd: repo.path });
    assert.equal(run.rc, FAILURES_RECOGNIZED, run.stderr);
    assert.deepEqual(lastLogRecord(sandbox).failed_tests, ['b']);
  });

  test('keelTest_logsNoFailingTests_whenTheRunPasses', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 2 tests'"], { cwd: repo.path });
    assert.equal(run.rc, 0, run.stderr);
    assert.deepEqual([lastLogRecord(sandbox).failed_tests, lastLogRecord(sandbox).selection], [[], 'command']);
  });
});

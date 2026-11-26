import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Sandbox } from './helpers.ts';
import type { Run } from './helpers.ts';

const TREE_CHANGED = 7;
const OUTPUT_STAYED_OPEN = 8;
const FAILURES_RECOGNIZED = 6;

function summaryOf(run: Run): any {
  const lastLine = run.stderr.trim().split('\n').at(-1)!;
  return JSON.parse(lastLine.slice(lastLine.indexOf(' ') + 1));
}

function lastLogRecord(sandbox: Sandbox): any {
  return JSON.parse(readFileSync(join(sandbox.data, 'logs', 'keel-tests.jsonl'), 'utf8').trim().split('\n').at(-1)!);
}

describe('TestrunResultsTest', () => {
  test('keelTest_exitsTreeChangedAndSaysWhy_whenAGreenCommandChangesTheTree', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo changed > generated.txt; echo '4 passed in 0.10s'"], { cwd: repo.path });
    assert.equal(run.rc, TREE_CHANGED, run.stderr);
    assert.match(run.stderr, /keel test: the working tree changed while the command ran; no evidence written\n/);
    assert.deepEqual(sandbox.evidenceFiles('tests'), []);
    assert.deepEqual([lastLogRecord(sandbox).exit, lastLogRecord(sandbox).keel_exit], [0, TREE_CHANGED]);
  });

  test('keelTest_keepsTheCommandsFailingExit_whenAFailingCommandAlsoChangesTheTree', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo changed > generated.txt; echo 'Ran 2 tests'; exit 3"], { cwd: repo.path });
    assert.equal(run.rc, 3, run.stderr);
    assert.deepEqual([lastLogRecord(sandbox).exit, lastLogRecord(sandbox).keel_exit], [3, 3]);
  });

  test('keelTest_keepsTheCommandsExitWithoutATreeReason_whenTheCommandItselfExitsWithKeelsTreeChangedCode', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 2 tests'; exit 7"], { cwd: repo.path });
    assert.equal(run.rc, TREE_CHANGED, run.stderr);
    assert.doesNotMatch(run.stderr, /working tree changed/);
  });

  test('keelTest_logsItsOwnExit_whenFailuresAreRecognizedUnderAGreenExit', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const run = sandbox.keel(['test', '--', 'bash', '-c', "printf 'ℹ pass 2\\nℹ fail 1\\n'"], { cwd: repo.path });
    assert.equal(run.rc, FAILURES_RECOGNIZED, run.stderr);
    assert.deepEqual([lastLogRecord(sandbox).exit, lastLogRecord(sandbox).keel_exit], [0, FAILURES_RECOGNIZED]);
  });

  test('keelTest_warnsOfAFlakySignal_whenTheSameCommandPassesOnTheTreeWhereItsFailuresHidBehindAGreenExit', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const marker = join(sandbox.data, 'ran-once');
    const command = ['bash', '-c', `if [ -e '${marker}' ]; then printf 'ℹ pass 2\\n'; else touch '${marker}'; printf 'ℹ pass 2\\nℹ fail 1\\n'; fi`];
    const failed = sandbox.keel(['test', '--', ...command], { cwd: repo.path });
    const passed = sandbox.keel(['test', '--', ...command], { cwd: repo.path });
    assert.equal(failed.rc, FAILURES_RECOGNIZED, failed.stderr);
    assert.equal(passed.rc, 0, passed.stderr);
    assert.match(passed.stderr, new RegExp(`\\[K3\\] warn: run ${summaryOf(failed).run_id} of this command failed on this same tree`));
    assert.equal(lastLogRecord(sandbox).passed_after_failure, summaryOf(failed).run_id);
  });

  test('keelTest_doesNotWarn_whenTheEarlierRunOnTheTreeOnlyChangedTheTree', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    const command = ['bash', '-c', "echo changed > generated.txt; echo 'Ran 2 tests'"];
    const changed = sandbox.keel(['test', '--', ...command], { cwd: repo.path });
    const passed = sandbox.keel(['test', '--', ...command], { cwd: repo.path });
    assert.equal(changed.rc, TREE_CHANGED, changed.stderr);
    assert.equal(passed.rc, 0, passed.stderr);
    assert.doesNotMatch(passed.stderr, /\[K3\] warn/);
  });

  test('keelTest_exitsOutputStayedOpenAndLogsTheRealExit_whenAGreenCommandLeavesItsOutputOpen', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    sandbox.env['KEEL_TEST_OUTPUT_IDLE_MS'] = '500';
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 3 tests'; sleep 20 & exit 0"], { cwd: repo.path });
    assert.equal(run.rc, OUTPUT_STAYED_OPEN, run.stderr);
    assert.equal(summaryOf(run).exit, 0);
    assert.deepEqual([lastLogRecord(sandbox).exit, lastLogRecord(sandbox).keel_exit], [0, OUTPUT_STAYED_OPEN]);
  });

  test('keelTest_logsRecognizedFailures_whenAGreenCommandReportingFailuresAlsoLeavesItsOutputOpen', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    sandbox.env['KEEL_TEST_OUTPUT_IDLE_MS'] = '500';
    const run = sandbox.keel(['test', '--', 'bash', '-c', "printf 'ℹ pass 2\\nℹ fail 1\\n'; sleep 20 & exit 0"], { cwd: repo.path });
    assert.equal(run.rc, FAILURES_RECOGNIZED, run.stderr);
    assert.deepEqual([lastLogRecord(sandbox).exit, lastLogRecord(sandbox).keel_exit], [0, FAILURES_RECOGNIZED]);
  });

  test('keelTest_keepsTheRunnersExit_whenAFailingCommandLeavesItsOutputOpen', (t) => {
    const sandbox = new Sandbox(t);
    const repo = sandbox.clone('acme', 'app');
    sandbox.env['KEEL_TEST_OUTPUT_IDLE_MS'] = '500';
    const run = sandbox.keel(['test', '--', 'bash', '-c', "echo 'Ran 3 tests'; sleep 20 & exit 5"], { cwd: repo.path });
    assert.equal(run.rc, 5, run.stderr);
    assert.match(run.stderr, /its output stayed open and silent for 500 ms; no evidence written\n/);
    assert.deepEqual([lastLogRecord(sandbox).exit, lastLogRecord(sandbox).keel_exit], [5, 5]);
  });
});

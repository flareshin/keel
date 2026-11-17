import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { DEFAULT_REGISTRY, LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Run } from './helpers.ts';

const PASS = 0;
const RULE = 'K1';

type Line = Record<string, unknown>;

const advisorAvailable = (available = true): Line => ({
  type: 'attachment', attachment: { type: 'advisor_tool', available, model: 'claude-fable-5-2', toolChange: 'add' },
});
const ownerPrompt = (text = 'fix it'): Line => ({
  type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text },
});
const notification = (): Line => ({
  type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' },
});
const compactSummary = (): Line => ({
  type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' },
});
const toolCall = (name: string, sidechain = false): Line => ({
  type: 'assistant', isSidechain: sidechain,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }] },
});
const toolResult = (): Line => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
});
const advisorCall = (): Line => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }] },
});
const reads = (count: number): Line[] => Array.from({ length: count }, () => [toolCall('Read'), toolResult()]).flat();

function stop(sandbox: Sandbox, lines: Line[], options: { continuing?: boolean; cwd?: string } = {}): Run {
  const transcript = sandbox.mainTranscript();
  writeFileSync(transcript, lines.map((line) => JSON.stringify(line) + '\n').join(''));
  return sandbox.hook({
    session_id: 's1', transcript_path: transcript, cwd: options.cwd ?? sandbox.home, permission_mode: 'default',
    hook_event_name: 'Stop', stop_hook_active: options.continuing ?? false, last_assistant_message: 'done',
  });
}

function blockReason(run: Run): string {
  assert.equal(run.rc, PASS, run.stderr);
  assert.equal(run.json.decision, 'block', run.stdout);
  return run.json.reason;
}

function assertSilent(run: Run): void {
  assert.equal(run.rc, PASS, run.stderr);
  assert.equal(run.stdout, '');
}

function sandboxFor(t: TestContext): Sandbox {
  return new Sandbox(t, DEFAULT_REGISTRY);
}

describe('StopAdvisorTest', () => {
  test('stop_blocks_whenTheTurnEditedAFileWithoutCallingTheAdvisor', (t) => {
    const reason = blockReason(stop(sandboxFor(t), [advisorAvailable(), ownerPrompt(), toolCall('Edit'), toolResult()]));
    assert.ok(reason.startsWith(`[${RULE}] ship-gate:`), reason);
    assert.ok(reason.includes('advisor'), reason);
  });

  test('stop_blocks_whenTheTurnRanSixToolCallsWithoutEditingOrCallingTheAdvisor', (t) => {
    blockReason(stop(sandboxFor(t), [advisorAvailable(), ownerPrompt(), ...reads(6)]));
  });

  test('stop_isSilent_whenTheTurnRanFiveToolCallsAndEditedNothing', (t) => {
    assertSilent(stop(sandboxFor(t), [advisorAvailable(), ownerPrompt(), ...reads(5)]));
  });

  test('stop_isSilent_whenTheAdvisorWasCalledAfterTheOwnersPrompt', (t) => {
    assertSilent(stop(sandboxFor(t), [advisorAvailable(), ownerPrompt(), advisorCall(), toolCall('Edit'), toolResult()]));
  });

  test('stop_blocks_whenTheOnlyAdvisorCallCameBeforeTheOwnersLatestPrompt', (t) => {
    blockReason(stop(sandboxFor(t), [
      advisorAvailable(), ownerPrompt('first'), advisorCall(), ownerPrompt('second'), toolCall('Write'), toolResult(),
    ]));
  });

  test('stop_countsWorkAcrossNotificationsAndCompaction_untilTheNextOwnerPrompt', (t) => {
    const sandbox = sandboxFor(t);
    blockReason(stop(sandbox, [advisorAvailable(), ownerPrompt(), ...reads(3), compactSummary(), notification(), ...reads(3)]));
    assertSilent(stop(sandbox, [advisorAvailable(), ownerPrompt(), advisorCall(), compactSummary(), notification(), toolCall('Edit')]));
  });

  test('stop_isSilent_whenTheAdvisorIsNotAvailableInTheSession', (t) => {
    const sandbox = sandboxFor(t);
    assertSilent(stop(sandbox, [ownerPrompt(), toolCall('Edit'), toolResult()]));
    assertSilent(stop(sandbox, [advisorAvailable(), advisorAvailable(false), ownerPrompt(), toolCall('Edit')]));
  });

  test('stop_ignoresSubagentToolCalls_andSubagentAdvisorAttachments', (t) => {
    const sandbox = sandboxFor(t);
    assertSilent(stop(sandbox, [advisorAvailable(), ownerPrompt(), toolCall('Edit', true), toolCall('Write', true)]));
    const sidechainOnly = { ...advisorAvailable(), isSidechain: true };
    assertSilent(stop(sandbox, [sidechainOnly, ownerPrompt(), toolCall('Edit'), toolResult()]));
  });

  test('stop_isSilent_whenTheTurnAlreadyContinuesForAStopHook', (t) => {
    assertSilent(stop(sandboxFor(t), [advisorAvailable(), ownerPrompt(), toolCall('Edit')], { continuing: true }));
  });

  test('stop_isSilent_whenNoOwnerPromptIsRecorded', (t) => {
    assertSilent(stop(sandboxFor(t), [advisorAvailable(), compactSummary(), toolCall('Edit'), toolResult()]));
  });

  test('stop_isSilent_andSaysWhyOnStderr_whenTheTranscriptCannotBeRead', (t) => {
    const sandbox = sandboxFor(t);
    const run = sandbox.hook({
      session_id: 's1', transcript_path: join(sandbox.root, 'missing.jsonl'), cwd: sandbox.home, permission_mode: 'default',
      hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done',
    });
    assertSilent(run);
    assert.ok(run.stderr.includes('advisor call at Stop not judged'), run.stderr);
  });

  test('stop_writesOneBlockFire_namingTheRule', (t) => {
    const sandbox = sandboxFor(t);
    blockReason(stop(sandbox, [advisorAvailable(), ownerPrompt(), toolCall('Edit'), toolResult()]));
    const fires = sandbox.fires(RULE, 'block');
    assert.equal(fires.length, 1, JSON.stringify(sandbox.fires()));
    assert.equal(fires[0].hook, 'ship-gate');
  });

  test('stop_carriesTheUnreadyPushReminderInsideTheBlock_whenBothApply', (t) => {
    const sandbox = sandboxFor(t);
    const repo = sandbox.clone('acme', 'app');
    repo.branch('feature');
    repo.commit(LOGIC_WITH_TEST);
    const reason = blockReason(stop(sandbox, [advisorAvailable(), ownerPrompt(), toolCall('Edit')], { cwd: repo.path }));
    assert.ok(reason.startsWith(`[${RULE}]`), reason);
    assert.ok(reason.includes('not ready to push'), reason);
  });
});

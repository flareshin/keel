import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { LOGIC_WITH_TEST, Sandbox } from './helpers.ts';
import type { Repo } from './helpers.ts';

const SKILL_FIELDS = {
  hook_event_name: 'PreSkillShellCommand', tool_use_id: 'tu1:inner:preamble-0',
  command_name: 'probe', command_source: 'projectSettings', invoked_by: 'user',
};

function featureRepo(t: TestContext): [Sandbox, Repo] {
  const sandbox = new Sandbox(t);
  const repo = sandbox.clone('acme', 'app');
  repo.branch('feature');
  repo.commit(LOGIC_WITH_TEST);
  return [sandbox, repo];
}

function skillShellCommand(sandbox: Sandbox, repo: Repo, command: unknown): Record<string, unknown> {
  return { ...sandbox.bashPayload(repo, 'placeholder'), ...SKILL_FIELDS, tool_input: { command } };
}

describe('SkillShellCommandTest', () => {
  test('skillShellPush_deniesK1_whenNoReviewEvidence', (t) => {
    const [sandbox, repo] = featureRepo(t);
    const run = sandbox.hook(skillShellCommand(sandbox, repo, 'git push origin feature'));
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('- [K1]'), run.stderr);
    assert.ok(run.stderr.includes('no review evidence'), run.stderr);
  });

  test('skillShellPush_failsClosed_whenCommandIsNotText', (t) => {
    const [sandbox, repo] = featureRepo(t);
    const run = sandbox.hook(skillShellCommand(sandbox, repo, ['git push origin feature']));
    assert.equal(run.rc, 2, run.stderr + run.stdout);
    assert.ok(run.stderr.includes('internal error; failing closed'), run.stderr);
  });

  test('skillShellCommand_passes_whenNotAPushOrMerge', (t) => {
    const [sandbox, repo] = featureRepo(t);
    const run = sandbox.hook(skillShellCommand(sandbox, repo, 'git status --short'));
    assert.equal(run.rc, 0, run.stderr);
  });
});

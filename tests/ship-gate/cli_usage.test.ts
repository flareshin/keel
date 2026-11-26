import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Sandbox } from './helpers.ts';

const EXIT_USAGE = 2;

describe('CliUsageTest', () => {
  test('keelPrecheck_withAnUnknownSubcommand_namesItInsteadOfTheBindUsage', (t) => {
    const run = new Sandbox(t).keel(['precheck', 'foo']);
    assert.equal(run.rc, EXIT_USAGE);
    assert.equal(run.stderr.split('\n')[0], 'keel: unknown precheck subcommand foo');
  });

  test('keelPrecheck_withNoSubcommand_listsItsSubcommands', (t) => {
    const run = new Sandbox(t).keel(['precheck']);
    assert.equal(run.rc, EXIT_USAGE);
    assert.equal(run.stderr.split('\n')[0], 'keel: keel precheck <run|rerun|bind|required>');
  });

  test('keelEvidence_withNoSubcommand_listsEverySubcommand', (t) => {
    const run = new Sandbox(t).keel(['evidence']);
    assert.equal(run.rc, EXIT_USAGE);
    assert.equal(run.stderr.split('\n')[0], 'keel: keel evidence <write-review|write-smoke|show|check|record-codex|promote-plan|gc>');
  });

  const optionsOfAnotherSubcommand: [subcommand: string, args: string[], rejected: string][] = [
    ['gc', ['--repo', 'x'], '--repo'],
    ['write-review', ['--run', 'x'], '--run'],
    ['write-smoke', ['--base', 'x'], '--base'],
    ['show', ['--audits', 'x'], '--audits'],
    ['check', ['--repo', 'x', '--root', 'x'], '--root'],
    ['promote-plan', ['--repo', 'x', '--base', 'x', '--head', 'x', '--run', 'x'], '--run'],
    ['record-codex', ['--repo', 'x', '--audits', 'x', '--head', 'x'], '--head'],
  ];
  for (const [subcommand, args, rejected] of optionsOfAnotherSubcommand) {
    test(`keelEvidence_${subcommand}_rejectsTheOption_${rejected}_thatOnlyAnotherSubcommandTakes`, (t) => {
      const run = new Sandbox(t).keel(['evidence', subcommand, ...args], { stdin: '{}' });
      assert.equal(run.rc, EXIT_USAGE, run.stdout);
      assert.equal(run.stderr.split('\n')[0], `keel: unexpected argument ${rejected}`);
    });
  }

  test('keelUsage_listsTheAffectedTestCommand', (t) => {
    const run = new Sandbox(t).keel([]);
    assert.equal(run.rc, EXIT_USAGE);
    assert.ok(run.stderr.split('\n').some((line) => line.trim() === 'keel test --affected [--with-replays] [--base <ref>]'), run.stderr);
  });
});

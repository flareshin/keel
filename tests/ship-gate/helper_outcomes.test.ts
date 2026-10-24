import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { describe, test } from 'node:test';
import { reviewRunId } from '../../lib/evidence/codex_lenses.ts';
import { onlyCommentDeletions } from '../../lib/evidence/comment_cleanup.ts';
import * as env from '../../lib/evidence/env.ts';
import { globMatches } from '../../lib/evidence/glob.ts';
import { normalizeRepoKey } from '../../lib/evidence/registry.ts';
import { isTestPath } from '../../lib/evidence/risk.ts';
import { recognize } from '../../lib/evidence/testrun.ts';
import { readFixture } from './outcomes.ts';

interface Outcomes {
  repoKey: Array<[string, string | null]>;
  testPath: Array<[string, boolean]>;
  recognize: Array<[string, [number, string | null]]>;
  comments: Array<[string, string, string, boolean]>;
  glob: Array<[string, string, boolean]>;
  reviewRunId: Array<[string[], string]>;
  idPatterns: Array<[string, boolean, boolean, boolean]>;
}

const outcomes = readFixture<Outcomes>('helper-outcomes.json', '');

function mismatches<Input, Output>(rows: Array<[Input, Output]>, compute: (input: Input) => Output): string[] {
  return rows.flatMap(([input, expected]) => {
    const actual = compute(input);
    return isDeepStrictEqual(actual, expected) ? [] : [`${JSON.stringify(input)}: got ${JSON.stringify(actual)}, recorded ${JSON.stringify(expected)}`];
  });
}

describe('helper outcomes recorded before the evidence code dropped its Python helpers', () => {
  test('repo key normalization', () => {
    assert.equal(outcomes.repoKey.length, 13);
    assert.deepEqual(mismatches(outcomes.repoKey, normalizeRepoKey), []);
  });

  test('test path classification', () => {
    assert.equal(outcomes.testPath.length, 14);
    assert.deepEqual(mismatches(outcomes.testPath, isTestPath), []);
  });

  test('runner summary recognition counts the same runs in the same frameworks', () => {
    assert.equal(outcomes.recognize.length, 400);
    assert.deepEqual(mismatches(outcomes.recognize, recognize), []);
  });

  test('a diff that only deletes whole-line comments keeps its review evidence, any other change does not', () => {
    assert.ok(outcomes.comments.some(([, , , allowed]) => allowed) && outcomes.comments.some(([, , , allowed]) => !allowed));
    const rows = outcomes.comments.map(([path, before, after, allowed]): [[string, string, string], boolean] => [[path, before, after], allowed]);
    assert.deepEqual(mismatches(rows, ([path, before, after]) => onlyCommentDeletions(path, Buffer.from(before), Buffer.from(after))), []);
  });

  test('path globs match like shell patterns where a star crosses slashes', () => {
    assert.ok(outcomes.glob.length > 1200);
    const rows = outcomes.glob.map(([name, pattern, expected]): [[string, string], boolean] => [[name, pattern], expected]);
    assert.deepEqual(mismatches(rows, ([name, pattern]) => globMatches(name, pattern)), []);
  });

  test('codex review run id', () => {
    const reviews = (identities: string[]) => identities.map((identity) => ({ identity, path: '', sha256: '', meta: {}, report: {} }));
    assert.deepEqual(mismatches(outcomes.reviewRunId, (identities) => reviewRunId(reviews(identities))), []);
  });

  test('run id and sha patterns accept the same ids, except that a trailing newline is no longer part of an id', () => {
    const rows = outcomes.idPatterns.map(([id, runId, , sha]): [string, boolean[]] => [id, [runId && !id.endsWith('\n'), sha]]);
    assert.ok(rows.some(([, [runId]]) => runId) && rows.some(([id]) => id.endsWith('\n')));
    assert.deepEqual(mismatches(rows, (id) => [env.isRunId(id), env.isSha(id)]), []);
  });
});

describe('deliberate differences from the recorded helper outcomes', () => {
  test('a glob character range written backwards is an error, where it used to match nothing', () => {
    assert.throws(() => globMatches('a', '[z-a]'), SyntaxError);
    assert.equal(globMatches('m', '[a-z]'), true);
  });

  test('an id followed by a newline is not an id, where it used to match', () => {
    assert.equal(env.isSha('a'.repeat(40) + '\n'), false);
    assert.equal(env.isRunId('rv-ok_name.1\n'), false);
    assert.equal(env.isRunId('rv-ok_name.1'), true);
  });

  test('a repo key is trimmed of the whitespace JavaScript trim removes, not of the C0 separators Python also removed', () => {
    assert.equal(normalizeRepoKey('https://github.com/Acme/App﻿'), 'acme/app');
    assert.equal(normalizeRepoKey('https://github.com/Acme/App\x85'), 'acme/app\x85');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { onlyCommentDeletions } from '../../lib/evidence/comment_cleanup.ts';
import { recordedAnswers } from '../recorded.ts';
import { pythonLexerCases } from './python-lexer-corpus.ts';

type RecordedAnswer = [deletionOnlyComments: boolean, beforeParses: boolean, afterParses: boolean];

const cases = pythonLexerCases();
const recorded = recordedAnswers<unknown, RecordedAnswer>(
  'ship-gate-python-lexer', cases.map((item) => ({ path: 'a.py', before: item.before, after: item.after })),
);

function judged(before: string, after: string): boolean {
  return onlyCommentDeletions('a.py', Buffer.from(before), Buffer.from(after));
}

describe('python comment lexer against the recorded Python answers', () => {
  test('agrees on every source Python parses, except the shapes it refuses', () => {
    const disagreements = cases.flatMap((item, index) => {
      const [expected, beforeParses, afterParses] = recorded[index]!;
      if (!beforeParses || !afterParses || item.refused) return [];
      return judged(item.before, item.after) === expected ? [] : [JSON.stringify(item.before)];
    });
    assert.deepEqual(disagreements.slice(0, 5), []);
  });

  test('refuses t-strings and a backslash before a brace in an f-string', () => {
    const accepted = cases.filter((item) => item.refused && judged(item.before, item.after)).map((item) => JSON.stringify(item.before));
    assert.deepEqual(accepted.slice(0, 5), []);
    assert.ok(cases.filter((item) => item.refused).length > 100);
  });

  test('refuses the string content that an escaped brace and a nested quote hide from a naive lexer', () => {
    const escaped = 's = f"""\\{"""\n# hello there\n"""}"""\nprint(s)\n';
    const raw = 's = rf"""\\{"""\n# hello there\n"""}"""\nprint(s)\n';
    const template = 's = t"""{"""\n# hello there\n"""}"""\nprint(s)\n';
    for (const source of [escaped, raw, template]) assert.equal(judged(source, source.replace('# hello there\n', '')), false, source);
  });

  test('still accepts a whole-line comment after an f-string', () => {
    assert.equal(judged('s = f"{x}"\n# hello there\n', 's = f"{x}"\n'), true);
  });

  test('covers both recorded answers', () => {
    const answers = new Set(recorded.map(([expected]) => expected));
    assert.deepEqual([...answers].sort(), [false, true]);
  });
});

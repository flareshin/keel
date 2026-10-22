import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, test } from 'node:test';
import { reviewRunId } from '../../lib/evidence/codex_lenses.ts';
import { onlyCommentDeletions } from '../../lib/evidence/comment_cleanup.ts';
import * as env from '../../lib/evidence/env.ts';
import {
  decodeSurrogateEscape, expandUser, fnmatchCase, pyRepr, pySplitLines, pySplitWhitespace, pyStrip, pythonJsonDumps, pythonJsonLoads,
} from '../../lib/evidence/pycompat.ts';
import type { JsonValue } from '../../lib/evidence/pycompat.ts';
import { normalizeRepoKey } from '../../lib/evidence/registry.ts';
import { isTestPath } from '../../lib/evidence/risk.ts';
import { recognize } from '../../lib/evidence/testrun.ts';
import { KEEL_HOME } from './helpers.ts';

const PYTHON_SIDE = `
import sys, json, fnmatch, os
sys.path.insert(0, sys.argv[1])
from evidence import registry, risk, testrun, comment_cleanup, env, codex_lenses

def number_safe(value):
    if isinstance(value, float) and value != value:
        return "NaN"
    if isinstance(value, float) and value in (float("inf"), float("-inf")):
        return "Infinity" if value > 0 else "-Infinity"
    if isinstance(value, list):
        return [number_safe(item) for item in value]
    if isinstance(value, dict):
        return {key: number_safe(item) for key, item in value.items()}
    return value

def loads(text):
    try:
        return ["ok", number_safe(json.loads(text))]
    except ValueError as error:
        return ["err", str(error)]

corpus = json.load(sys.stdin)
out = {
    "repoKey": [registry.normalize_repo_key(item) for item in corpus["repoKey"]],
    "fnmatch": [fnmatch.fnmatchcase(name, pattern) for name, pattern in corpus["fnmatch"]],
    "testPath": [risk.is_test_path(item) for item in corpus["testPath"]],
    "recognize": [list(testrun.recognize(item)) for item in corpus["recognize"]],
    "dumpsSorted": [json.dumps(item, sort_keys=True) for item in corpus["dumps"]],
    "dumpsInsertion": [json.dumps(item) for item in corpus["dumps"]],
    "loads": [loads(item) for item in corpus["loads"]],
    "strip": [item.strip() for item in corpus["text"]],
    "splitlines": [item.splitlines() for item in corpus["text"]],
    "split": [item.split() for item in corpus["text"]],
    "repr": [repr(item) for item in corpus["text"]],
    "comments": [comment_cleanup.only_comment_deletions(path, before.encode(), after.encode()) for path, before, after in corpus["comments"]],
    "expanduser": [os.path.expanduser(item) for item in corpus["expanduser"]],
    "reviewRunId": [codex_lenses.review_run_id([codex_lenses.Review(i, "", "", {}, {}) for i in group]) for group in corpus["identity_groups"]],
    "surrogateEscape": [bytes.fromhex(item).decode("utf-8", "surrogateescape") for item in corpus["bytes"]],
    "runIdMatch": [bool(env.RUN_ID_RE.match(item)) for item in corpus["ids"]],
    "shaMatch": [bool(env.SHA_RE.match(item)) for item in corpus["ids"]],
    "shaFull": [bool(env.SHA_RE.fullmatch(item)) for item in corpus["ids"]],
}
print(json.dumps(out))
`;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20261022);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

const EXOTIC_CHARS = ['a', 'Z', '0', ' ', '\t', '\n', '\r', '\v', '\f', '\x1c', '\x1e', '\x7f', '\x85', '\xa0', 'é', 'ß', 'İ', '漢',
  '\u2028', '\u2029', '\u3000', '\u200b', '\ufeff', '😀', '\u{10000}', '"', '\\', '/', '#', '*', '?', '[', ']', '-', '!'];

function randomString(maxLength: number, alphabet: readonly string[] = EXOTIC_CHARS): string {
  return Array.from({ length: between(0, maxLength) }, () => pick(alphabet)).join('');
}

function randomJson(depth: number): JsonValue {
  const kind = between(0, depth > 2 ? 3 : 5);
  if (kind === 0) return null;
  if (kind === 1) return random() < 0.5;
  if (kind === 2) return between(-1000, 100000);
  if (kind === 3) return randomString(8);
  if (kind === 4) return Array.from({ length: between(0, 4) }, () => randomJson(depth + 1));
  return Object.fromEntries(Array.from({ length: between(0, 4) }, () => [randomString(4), randomJson(depth + 1)]));
}

function mutate(document: string): string {
  const chars = Array.from(document);
  const index = between(0, chars.length);
  const action = between(0, 2);
  if (action === 0) chars.splice(index, 1);
  else if (action === 1) chars.splice(index, 0, pick([...'{}[]",:\\ \n0-eE.tfn', 'é', '😀']));
  else chars[index] = pick([...'{}[]",:\\ \n0-eE.tfn']);
  return chars.join('');
}

const MALFORMED = ['', ' ', '{', '[', '{"a"', '{"a":', '{"a":1', '{"a":1,', '{"a":1,}', '[1,]', '[1 2]', '{"a" 1}', '{1:2}', '"abc',
  '"a\\x"', '"\\u12"', '"\\ud83d\\u12"', '"a\nb"', 'nul', 'tru', '01', '-', '1.', '1e', '.5', '+1', '[1]x', '{"a":1}}', "'a'", '\ufeff{}',
  'NaN', '[NaN, Infinity, -Infinity]', '-Infinity', '- 1', '\n\n  [1,\n2,, ]', '{"a":\n\n}', '"\\ud800"', '"\\ud83d\\ude00"', '1E5', '-0',
  '{"é😀": [1, 2.5, "x\\ny"]}', '[\n  1,\n  oops\n]', '{"a": tru}', '{"a": 1 "b": 2}', '[1, 2', '{"a": [}', '"\\u00e9\\u0041"',
  '  \t\n 7 \n ', 'true false', '[]]', '{"a":{"b":{"c":[1,{"d":null}]}}}', '"\u0001"', '["\ud83d"]'];

function buildCorpus() {
  const origins = ['git@github.com:Acme/App.git', 'https://github.com/acme/app', 'https://github.com/acme/app.git/', 'ssh://git@host:22/Owner/Repo.git',
    '/srv/git/team/repo.git', 'repo', '', '  https://x/y/z.git  ', 'a:b', 'file:///tmp/remotes/acme/app.git', '////', 'C:\\x\\y', 'git@host:İ/ß.git'];
  const testPaths = ['tests/test_a.py', 'src/foo.test.ts', 'src/foo.spec.js', 'a/__tests__/b.js', 'test_x.py', 'x_test.go', 'src/a.py', 'Test/a.py', 'a/b/c.test',
    'tests', 'src/tests.py', '.test.', 'a.spec.', 'src/__tests__'];
  const globs = ['*', '*.py', 'test_*.py', '*_test.*', '*.test.*', '*.spec.*', '?', '[abc]', '[!abc]', '[a-c]', '[]a]', '[!]a]', '[a-]', '[-a]', '[z-a]', '[', 'a[', 'a[b',
    '[a-c-e]', '[\\\\]', '**', 'a*b*c', '*.[jt]s', '[^a]', '[[]', '[a-a]', '\\*', 'src/*/billing/*'];
  const fnmatchCases: Array<[string, string]> = [];
  for (const pattern of globs) {
    for (const name of ['a', 'b', 'abc', 'x.py', 'test_a.py', 'z', '-', ']', '[', '\\', '^', 'a.test.ts', 'src/x/billing/y', 'e', 'ab\ncd', '😀', '']) {
      fnmatchCases.push([name, pattern]);
    }
  }
  for (let count = 0; count < 800; count++) fnmatchCases.push([randomString(5, ['a', 'b', '-', ']', '[', '!', '\\', '^', '.']), randomString(7, ['a', 'b', '*', '?', '[', ']', '!', '-', '\\', '^'])]);
  const fragments = ['Ran 3 tests', 'Ran 1 test', 'Ran 5 testsé', 'Tests run: 4, Failures: 0', 'Tests run: 9', '# pass 7', '  # pass 2', '12 passed',
    'Test Files  7 passed (7)', '     Tests  67 passed (67)', 'Test Suites: 2 passed, 2 total', 'Tests:       9 passed, 9 total', 'x3 passed', '3 passedx', 'OK', '',
    'BUILD SUCCESS', '\r', 'Ran 8 tests\r', '\rRan 2 tests', 'a # pass 4', ' Test Files\n 4 passed', '\u2028Ran 6 tests', '\u00a0Test Files 3 passed', 'é3 passed', '3 passed é'];
  const outputs: string[] = [];
  for (let count = 0; count < 400; count++) outputs.push(Array.from({ length: between(0, 6) }, () => pick(fragments)).join(pick(['\n', '\n', '\r\n', '\r', ' '])));
  const dumps: JsonValue[] = [null, true, 1, 'é😀\u0000\x7f"\\/\b\f\n\r\t', [], {}, { b: 1, a: [1, { d: 'x', c: null }] }, { '😀': 1, '\uffff': 2, 'é': 3, z: 4, '\u{10000}': 5 }];
  for (let count = 0; count < 500; count++) dumps.push(randomJson(0));
  const loads = [...MALFORMED];
  for (let count = 0; count < 600; count++) {
    const source = pythonJsonDumps(randomJson(0));
    loads.push(count % 3 === 0 ? source : mutate(count % 3 === 1 ? source : JSON.stringify(JSON.parse(source), null, 1)));
  }
  const text = [...EXOTIC_CHARS.map((char) => `${char}x${char}`), 'a\r\nb\rc\nd\ve\ff\x1cg\x1dh\x1ei\x85j\u2028k\u2029l', '\n', '', ' \t ', 'a b\tc\nd\u3000e', "it's", 'say "hi"', 'both \' and "', '\x00\x01\x7f', 'é', '😀 \u{10ffff}'];
  for (let count = 0; count < 300; count++) text.push(randomString(12));
  const pythonSources = ['x = 1\n', '# note\nx = 1\n', 'x = "# literal"\n', '# note\nx = 1\n# other\ny = 2\n', 'def f():\n    # inner\n    return 1\n',
    '"""doc\n# not a comment\n"""\nx = 1\n', 'x = 1 # trailing\n', '#!/usr/bin/env python\nx = 1\n', '# noqa\nx = 1\n', 'x = (1,\n # inside\n 2)\n', '\n# é\nx = 1\n'];
  const slashSources = ['// a\nconst x = 1;\n', '/* b\n c */\nconst y = 2;\n', 'const s = "// not";\n// c\n', "const t = 'it\\'s';\n// note here\n", 'x = a / b;\n// note\n',
    '// @ts-ignore\nlet z;\n', '  // indented note\n  keep();\n', 'int x; // trailing note\n', '/* unterminated\n', '// note\r\nkeep();\r\n'];
  const comments: Array<[string, string, string]> = [];
  for (const [suffix, sources] of [['.py', pythonSources], ['.ts', slashSources], ['.js', slashSources], ['.java', slashSources], ['.sh', pythonSources]] as const) {
    for (const source of sources) {
      const lines = source.split('\n');
      for (let drop = 0; drop < lines.length; drop++) {
        comments.push([`a${suffix}`, source, lines.filter((_, index) => index !== drop).join('\n')]);
      }
      comments.push([`a${suffix}`, source, lines.filter((line) => !/^\s*(#|\/\/|\/\*)/.test(line)).join('\n')]);
      comments.push([`a${suffix}`, source, source.replace('1', '2')]);
    }
  }
  const ids = ['rv-root-0001', 'a'.repeat(40), 'a'.repeat(40) + '\n', 'a'.repeat(39), 'short', 'x'.repeat(65), 'rv-ok_name.1\n', 'rv-ok_name.1\n\n', 'A'.repeat(40), '', '12345678', 'é'.repeat(9)];
  const identityGroups = [['b'], ['a', 'b'], ['b', 'a'], ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], ['é', '😀', 'z', '\u{10000}', '\uffff']];
  const byteAlphabet = ['41', '7f', '80', 'bf', 'c0', 'c2', 'df', 'e0', 'a0', 'e2', '82', 'ac', 'ed', '9f', 'f0', '9f', '98', '80', 'f4', '8f', 'f5', 'ff', 'c3', 'a9'];
  const byteStrings = Array.from({ length: 1500 }, () => Array.from({ length: between(0, 8) }, () => pick(byteAlphabet)).join(''));
  const expandUsers = ['~', '~/x', '~/', '/abs', 'rel', '~root', '~nosuchuser/x', '~x/y', ''];
  return { repoKey: origins, fnmatch: fnmatchCases, testPath: testPaths, recognize: outputs, dumps, loads, text, comments, expanduser: expandUsers, ids, identity_groups: identityGroups, bytes: byteStrings };
}

function numberSafe(value: JsonValue): JsonValue {
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (Object.is(value, -0)) return 0;
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Array.isArray(value)) return value.map(numberSafe);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, numberSafe(item)]));
  return value;
}

function tsLoads(text: string): JsonValue {
  try {
    return ['ok', numberSafe(pythonJsonLoads(text))];
  } catch (error) {
    return ['err', (error as Error).message];
  }
}

describe('python parity', () => {
  const corpus = buildCorpus();
  const completed = spawnSync('python3', ['-I', '-X', 'utf8', '-c', PYTHON_SIDE, join(KEEL_HOME, 'lib')], {
    input: JSON.stringify(corpus), encoding: 'utf8', maxBuffer: 1 << 30,
  });
  assert.equal(completed.status, 0, completed.stderr);
  const python = JSON.parse(completed.stdout);
  let cases = 0;
  const mismatches: string[] = [];

  function compare<T>(label: string, inputs: readonly unknown[], actual: T[], expected: T[]): void {
    assert.equal(actual.length, expected.length, label);
    inputs.forEach((input, index) => {
      cases++;
      if (!isDeepStrictEqual(actual[index], expected[index])) {
        mismatches.push(`${label} ${JSON.stringify(input)}: ts ${JSON.stringify(actual[index])} python ${JSON.stringify(expected[index])}`);
      }
    });
  }

  test('repo key normalization', () => compare('repoKey', corpus.repoKey, corpus.repoKey.map(normalizeRepoKey), python.repoKey));
  test('fnmatch.fnmatchcase', () => compare('fnmatch', corpus.fnmatch, corpus.fnmatch.map(([name, pattern]) => fnmatchCase(name, pattern)), python.fnmatch));
  test('test path classification', () => compare('testPath', corpus.testPath, corpus.testPath.map(isTestPath), python.testPath));
  test('runner summary recognition', () => compare('recognize', corpus.recognize, corpus.recognize.map(recognize), python.recognize));
  test('json.dumps sort_keys', () => compare('dumpsSorted', corpus.dumps,
    corpus.dumps.map((value) => pythonJsonDumps(value, { sortKeys: true })), python.dumpsSorted));
  test('json.dumps insertion order', () => compare('dumpsInsertion', corpus.dumps, corpus.dumps.map((value) => pythonJsonDumps(value)), python.dumpsInsertion));
  test('json.loads values and error messages', () => compare('loads', corpus.loads, corpus.loads.map(tsLoads), python.loads));
  test('str.strip', () => compare('strip', corpus.text, corpus.text.map(pyStrip), python.strip));
  test('str.splitlines', () => compare('splitlines', corpus.text, corpus.text.map(pySplitLines), python.splitlines));
  test('str.split', () => compare('split', corpus.text, corpus.text.map(pySplitWhitespace), python.split));
  test('repr(str)', () => compare('repr', corpus.text, corpus.text.map(pyRepr), python.repr));
  test('only_comment_deletions', () => compare('comments', corpus.comments,
    corpus.comments.map(([path, before, after]) => onlyCommentDeletions(path, Buffer.from(before), Buffer.from(after))), python.comments));
  test('os.path.expanduser', () => {
    const resolved = corpus.expanduser.map((item) => (item.startsWith('~') && !item.startsWith('~/') && item !== '~') ? null : expandUser(item));
    const expected = python.expanduser.map((item: string, index: number) => resolved[index] === null ? null : item);
    assert.equal(homedir().length > 0, true);
    compare('expanduser', corpus.expanduser, resolved, expected);
  });
  test('codex review run id', () => compare('reviewRunId', corpus.identity_groups,
    corpus.identity_groups.map((group) => reviewRunId(group.map((identity) => ({ identity, path: '', sha256: '', meta: {}, report: {} })))), python.reviewRunId));
  test('bytes.decode surrogateescape', () => compare('surrogateEscape', corpus.bytes,
    corpus.bytes.map((hex) => decodeSurrogateEscape(Buffer.from(hex, 'hex'))), python.surrogateEscape));
  test('run id and sha pattern semantics', () => {
    compare('runIdMatch', corpus.ids, corpus.ids.map(env.matchesRunId), python.runIdMatch);
    compare('shaMatch', corpus.ids, corpus.ids.map(env.matchesSha), python.shaMatch);
    compare('shaFull', corpus.ids, corpus.ids.map(env.isSha), python.shaFull);
  });

  test('summary', (t) => {
    t.diagnostic(`parity: ${cases} cases, ${mismatches.length} mismatches`);
    assert.deepEqual(mismatches.slice(0, 10), []);
    assert.ok(cases > 3000);
  });
});

import assert from 'node:assert/strict';
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
import { recordedAnswers, recordedPlatformMatches } from '../recorded.ts';

const RECORDED_HOME = '/home/tester';

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

const FLOAT_VALUES = [0.5, -2.25, 0.1, 0.30000000000000004, 123456.789, 0.0001, 0.00001, 1.5e-7, -2.5e-300, 5e-324, 1e21, 1e22, 1.7976931348623157e308,
  9007199254740991, -9007199254740991, 1e15, 123456789012345680000];
const FLOAT_DOCUMENTS = ['0.5', '-2.25', '[0.1, 0.30000000000000004]', '123456.789', '0.0001', '1e-5', '1.5E-7', '-2.5e-300', '5e-324', '1.7976931348623157e308',
  '1e400', '-1e400', '9007199254740991', '-9007199254740991', '9007199254740992', '{"a": [1.5, -0.25, 1e-10]}', '[0.1e1, 2.5e0]', '0.000123'];
const NUMBER_SPELLINGS: Array<[input: string, dumped: string]> = [
  ['1.0', '1.0'], ['-0.0', '-0.0'], ['1e2', '100.0'], ['1E5', '100000.0'], ['[2.50, 3.0]', '[2.5, 3.0]'],
  ['12345678901234567890', '12345678901234567890'], ['9007199254740993', '9007199254740993'], ['-9007199254740993', '-9007199254740993'],
  ['1e16', '1e+16'], ['-0', '0'], ['[0, 0.0, -0.0, 1e-7, 10.0e0]', '[0, 0.0, -0.0, 1e-07, 10.0]'], ['{"weight": 1.0, "big": 9007199254740993}', '{"weight": 1.0, "big": 9007199254740993}'],
  ['1e400', 'Infinity'], ['[NaN, 1.0]', '[NaN, 1.0]'], ['123456789012345678901234567890.0', '1.2345678901234568e+29'],
];
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
  const dumps: JsonValue[] = [null, true, 1, ...FLOAT_VALUES, 'é😀\u0000\x7f"\\/\b\f\n\r\t', [], {}, { b: 1, a: [1, { d: 'x', c: null }] }, { '😀': 1, '\uffff': 2, 'é': 3, z: 4, '\u{10000}': 5 }];
  for (let count = 0; count < 500; count++) dumps.push(randomJson(0));
  const loads = [...MALFORMED, ...FLOAT_DOCUMENTS, ...NUMBER_SPELLINGS.map(([input]) => input)];
  for (let count = 0; count < 600; count++) {
    const source = pythonJsonDumps(randomJson(0));
    loads.push(count % 3 === 0 ? source : mutate(count % 3 === 1 ? source : JSON.stringify(JSON.parse(source), null, 1)));
  }
  const text = [...EXOTIC_CHARS.map((char) => `${char}x${char}`), 'a\r\nb\rc\nd\ve\ff\x1cg\x1dh\x1ei\x85j\u2028k\u2029l', '\n', '', ' \t ', 'a b\tc\nd\u3000e', "it's", 'say "hi"', 'both \' and "', '\x00\x01\x7f', 'é', '😀 \u{10ffff}'];
  for (let count = 0; count < 300; count++) text.push(randomString(12));
  const pythonSources = ['x = 1\n', '# note\nx = 1\n', 'x = "# literal"\n', '# note\nx = 1\n# other\ny = 2\n', 'def f():\n    # inner\n    return 1\n',
    '"""doc\n# not a comment\n"""\nx = 1\n', 'x = 1 # trailing\n', '#!/usr/bin/env python\nx = 1\n', '# noqa\nx = 1\n', 'x = (1,\n # inside\n 2)\n', '\n# é\nx = 1\n',
    "x = 'it\\'s # not'\n# note here\n", 'x = "a" "b" # tail\n# note here\n', "s = '''one\n# inside\n'''\n# note here\n", "s = r'\\'\n# note here\n",
    'p = rb"a#b"\n# note here\ny = Rb\'\\\\\'\n', 'f = f"{x}#{y}"\n# note here\n', 'f = f"{d["k"]}"\n# note here\n', "f = f'{x:#x}'\n# note here\n",
    'f = f"{x!r:>{width}}"\n# note here\n', 'f = f"{{literal}} # kept"\n# note here\n', "f = f'{\"#\"}'\n# note here\n", 'f = f"""{\n    x  # inside the field\n}"""\n# note here\n',
    'f = f"""{\n    # whole line in the field\n    x\n}"""\n# note here\n', 'f = f"\\N{EM DASH} #"\n# note here\n', "f = rf'{x}\\d#'\n# note here\n", 'f = f"{f"{x}"}"\n# note here\n',
    'x = 1 + \\\n    2\n# note here\n', 'x = [\n    1,\n    # inside the list\n    2,\n]\n', 'x = {\n    # inside the dict\n    "a": 1,\n}\n',
    'class A:\n    # first\n    x = 1\n\n    # second\n    def f(self):\n        # third\n        return 1\n# end of note\n', 'if x:\n    # only a note\n    pass\n',
    'if x:\n    pass\n# dedent note\nelse:\n    pass\n', '@dec\n# between\ndef f():\n    pass\n', 'def f():\n\treturn 1\n# note here\n', 'def f():\n\treturn 1\n        # spaces note\n',
    'if x:\n        a\n\tb\n# note here\n', 'if x:\n    a\n  b\n# note here\n', 'x = "unterminated\n# note here\n', "s = '''never closed\n# note here\n", 'x = (1,\n# note here\n',
    'x = 1)\n# note here\n', 'x = $y\n# note here\n', 'x = 1  # prefix\n# note here\n', 'x = 1\r\n# note here\r\ny = 2\r\n', 'x = 1\r\n# note\r here\r\n', '# note here\n', '# only\n# comments\n',
    '', 'x = "é😀"  # trailing\n# note 😀 here\ny = "😀"\n', 'name = "\\N{EM DASH}"\n# note here\n', 'x = lambda: 0  # tail\n# note here\n', 'if (y := 1):\n    # note here\n    pass\n',
    'print(*a, sep="#")\n# note here\n', 'a @ b\n# note here\n', '# coding: latin-1\nx = 1\n', '# type: ignore\nx = 1\n', '# TODO(ABC-12) later\nx = 1\n', 'x = 1\n\x0c\n# note here\n',
    '\u00e9 = 1\n# note here\n', 'class \u0130:\n    # note here\n    pass\n', 'x = """a\\\n# still a string\n"""\n# note here\n', "x = 'a\\\n# still a string'\n# note here\n"];
  const slashSources = ['// a\nconst x = 1;\n', '/* b\n c */\nconst y = 2;\n', 'const s = "// not";\n// c\n', "const t = 'it\\'s';\n// note here\n", 'x = a / b;\n// note\n',
    '// @ts-ignore\nlet z;\n', '  // indented note\n  keep();\n', 'int x; // trailing note\n', '/* unterminated\n', '// note\r\nkeep();\r\n',
    '// L\u0131cense MIT\nconst x = 1;\n', '// \u0130gnore this\nconst x = 1;\n', '/* \u0130LLEGAL ignore */\nconst x = 1;\n', '// not\u0131ce\nconst x = 1;\n',
    '// no\u017fec\nconst x = 1;\n', '// chec\u212astyle\nconst x = 1;\n'];
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
  for (const char of foldingSensitiveChars()) {
    for (const keyword of ['ignore', 'disable', 'checkstyle', 'license']) {
      const body = keyword.replace(/[iks]/, char);
      comments.push(['a.ts', `// ${body}\nconst x = 1;\n`, 'const x = 1;\n']);
    }
  }
  const ids = ['rv-root-0001', 'a'.repeat(40), 'a'.repeat(40) + '\n', 'a'.repeat(39), 'short', 'x'.repeat(65), 'rv-ok_name.1\n', 'rv-ok_name.1\n\n', 'A'.repeat(40), '', '12345678', 'é'.repeat(9)];
  const identityGroups = [['b'], ['a', 'b'], ['b', 'a'], ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], ['é', '😀', 'z', '\u{10000}', '\uffff']];
  const byteAlphabet = ['41', '7f', '80', 'bf', 'c0', 'c2', 'df', 'e0', 'a0', 'e2', '82', 'ac', 'ed', '9f', 'f0', '9f', '98', '80', 'f4', '8f', 'f5', 'ff', 'c3', 'a9'];
  const byteStrings = Array.from({ length: 1500 }, () => Array.from({ length: between(0, 8) }, () => pick(byteAlphabet)).join(''));
  const expandUsers = ['~', '~/x', '~/', '/abs', 'rel', '~root', '~root/', '~root/x/y', '~nosuchuser/x', '~x/y', '', '~daemon/x', '~/~root'];
  return { repoKey: origins, fnmatch: fnmatchCases, testPath: testPaths, recognize: outputs, dumps, loads, text, comments, expanduser: expandUsers, ids, identity_groups: identityGroups, bytes: byteStrings };
}

function foldingSensitiveChars(): string[] {
  const chars: string[] = [];
  for (let code = 0x80; code <= 0xffff; code++) {
    const char = String.fromCharCode(code);
    if (char.toLowerCase() !== char || char.toUpperCase() !== char) chars.push(char);
  }
  return chars;
}

function tsLoads(text: string): JsonValue {
  try {
    return ['ok', pythonJsonDumps(pythonJsonLoads(text))];
  } catch (error) {
    return ['err', (error as Error).message];
  }
}

describe('python parity', () => {
  const corpus = buildCorpus();
  const python = recordedAnswers<typeof corpus, Record<string, any>>('ship-gate-parity', [corpus])[0] as Record<string, any>;
  let cases = 0;
  let intendedDivergences = 0;
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
  test('json.loads then json.dumps, values and error messages', () => {
    compare('loads', corpus.loads, corpus.loads.map(tsLoads), python.loads);
  });
  test('number spellings survive json.loads then json.dumps byte for byte', () => {
    for (const [input, dumped] of NUMBER_SPELLINGS) {
      assert.deepEqual(tsLoads(input), ['ok', dumped], input);
      assert.deepEqual(python.loads[corpus.loads.indexOf(input)], ['ok', dumped], input);
    }
  });
  test('str.strip', () => compare('strip', corpus.text, corpus.text.map(pyStrip), python.strip));
  test('str.splitlines', () => compare('splitlines', corpus.text, corpus.text.map(pySplitLines), python.splitlines));
  test('str.split', () => compare('split', corpus.text, corpus.text.map(pySplitWhitespace), python.split));
  test('repr(str)', () => compare('repr', corpus.text, corpus.text.map(pyRepr), python.repr));
  test('only_comment_deletions', () => {
    const isPython = ([path]: readonly [string, string, string]) => path.endsWith('.py');
    const expected = corpus.comments.map((input, index) => (isPython(input) ? false : python.comments[index]));
    compare('comments', corpus.comments,
      corpus.comments.map(([path, before, after]) => onlyCommentDeletions(path, Buffer.from(before), Buffer.from(after))), expected);
    intendedDivergences += corpus.comments.filter((input, index) => isPython(input) && python.comments[index] === true).length;
  });
  test('os.path.expanduser', { skip: recordedPlatformMatches() ? false : 'account home directories were recorded on darwin' }, () => {
    const saved = process.env['HOME'];
    process.env['HOME'] = RECORDED_HOME;
    try {
      compare('expanduser', corpus.expanduser, corpus.expanduser.map(expandUser), python.expanduser);
    } finally {
      if (saved === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved;
    }
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
    t.diagnostic(`parity: ${cases} cases, ${mismatches.length} mismatches, ${intendedDivergences} intended divergences`);
    assert.deepEqual(mismatches.slice(0, 10), []);
    assert.ok(intendedDivergences > 0);
    assert.ok(cases > 3000);
  });
});

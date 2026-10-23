import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import {
  JSONDecodeError, PyFloat, decodeSurrogateEscape, fnmatchCase, isDirectory, isFile, isSystemError, pyEquals, pyOsErrorMessage, pyRepr, pySplitLines, pyStr, pyStrip, pyTruthy, pythonJsonDumps, pythonJsonLoads,
} from '../../lib/evidence/pycompat.ts';
import { OSError } from '../../lib/evidence/subprocess.ts';
import { isInputFailure } from '../../lib/evidence/writers.ts';

describe('pythonJsonDumps', () => {
  test('escapes non-ASCII and non-BMP the way json.dumps does and uses python separators', () => {
    assert.equal(pythonJsonDumps({ 'é': '😀' }), '{"\\u00e9": "\\ud83d\\ude00"}');
    assert.equal(pythonJsonDumps([1, null, true, 'a\u007f\u0001"\\']), '[1, null, true, "a\\u007f\\u0001\\"\\\\"]');
  });

  test('sorts keys recursively by code point, not by UTF-16 unit', () => {
    const value = { b: { z: 1, a: 2 }, a: [{ y: 1, x: 2 }], '\u{10000}': 1, '￿': 2 };
    assert.equal(pythonJsonDumps(value, { sortKeys: true }),
      '{"a": [{"x": 2, "y": 1}], "b": {"a": 2, "z": 1}, "\\uffff": 2, "\\ud800\\udc00": 1}');
  });

  test('keeps insertion order without sortKeys and writes empty containers', () => {
    assert.equal(pythonJsonDumps({ b: [], a: {} }), '{"b": [], "a": {}}');
  });
});

describe('pythonJsonLoads', () => {
  test('accepts the python extensions NaN and Infinity as floats', () => {
    assert.ok(Number.isNaN((pythonJsonLoads('NaN') as PyFloat).value));
    assert.deepEqual(pythonJsonLoads('[Infinity, -Infinity]'), [new PyFloat(Infinity), new PyFloat(-Infinity)]);
  });

  test('types numbers the way json.loads does: int, float and arbitrary precision int', () => {
    assert.deepEqual(pythonJsonLoads('[1, 1.0, -0, -0.0, 1e2, 9007199254740991, 9007199254740993, -9007199254740993]'),
      [1, new PyFloat(1), 0, new PyFloat(-0), new PyFloat(100), 9007199254740991, 9007199254740993n, -9007199254740993n]);
    assert.ok(Object.is((pythonJsonLoads('-0') as number), 0));
  });

  test('keeps float and big int spellings through a dumps round trip', () => {
    assert.equal(pythonJsonDumps(pythonJsonLoads('[1.0, -0.0, 1e16, 2E3, 1e-7, 9007199254740993, 1e400, NaN]')),
      '[1.0, -0.0, 1e+16, 2000.0, 1e-07, 9007199254740993, Infinity, NaN]');
  });
});

describe('python value semantics', () => {
  test('pyEquals compares numbers by value across int, bool and float like ==', () => {
    for (const [left, right, expected] of [
      [1, new PyFloat(1), true], [true, 1, true], [new PyFloat(1), true, true], [9007199254740993n, new PyFloat(9007199254740992), false],
      [9007199254740992n, new PyFloat(9007199254740992), true], [new PyFloat(0), new PyFloat(-0), true], [new PyFloat(NaN), new PyFloat(NaN), false],
      [1, '1', false], [1, null, false], [2, new PyFloat(1.5), false],
      [{ a: [1, 2] }, { a: [new PyFloat(1), 2] }, true], [{ a: 1 }, { b: 1 }, false], [[1], [1, 2], false], ['a', 'a', true],
    ] as const) {
      assert.equal(pyEquals(left, right), expected, `${String(left)} == ${String(right)}`);
    }
  });

  test('pyTruthy and pyStr follow bool() and str() for loaded values', () => {
    assert.deepEqual([0, 0n, new PyFloat(-0), '', [], {}, null, false].map(pyTruthy), Array(8).fill(false));
    assert.deepEqual([1, 9007199254740993n, new PyFloat(0.5), 'x', [0], { a: 0 }, true].map(pyTruthy), Array(7).fill(true));
    assert.deepEqual([1, 9007199254740993n, new PyFloat(1), new PyFloat(1e16), true, false, null, 'x'].map(pyStr),
      ['1', '9007199254740993', '1.0', '1e+16', 'True', 'False', 'None', 'x']);
  });

  test('reports errors with python wording and code point positions', () => {
    assert.throws(() => pythonJsonLoads('{"a":\n 😀}'), (error: Error) => error instanceof JSONDecodeError
      && error.message === 'Expecting value: line 2 column 2 (char 7)');
    assert.throws(() => pythonJsonLoads('[1,]'), { message: 'Illegal trailing comma before end of array: line 1 column 3 (char 2)' });
    assert.throws(() => pythonJsonLoads('{"a":1} x'), { message: 'Extra data: line 1 column 9 (char 8)' });
  });
});

describe('python string helpers', () => {
  test('splitLines uses the unicode line boundaries and drops the trailing empty element', () => {
    assert.deepEqual(pySplitLines('a\r\nb c\x85d\n'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(pySplitLines(''), []);
  });

  test('strip removes unicode whitespace that JavaScript trim keeps', () => {
    assert.equal(pyStrip('\x1c\x85 x 　'), 'x');
  });

  test('decodeSurrogateEscape maps invalid bytes to lone low surrogates', () => {
    assert.equal(decodeSurrogateEscape(Buffer.from([0x61, 0xff, 0xc3, 0xa9, 0x80])), 'a\udcffé\udc80');
  });

  test('repr picks quotes the way python does', () => {
    assert.equal(pyRepr("it's"), '"it\'s"');
    assert.equal(pyRepr('a\nb'), "'a\\nb'");
  });

  test('fnmatchCase follows fnmatch.fnmatchcase for sets and wildcards', () => {
    assert.equal(fnmatchCase('src/a/billing/x.py', 'src/*/billing/*'), true);
    assert.equal(fnmatchCase('a.TS', '*.ts'), false);
    assert.equal(fnmatchCase('b', '[!a]'), true);
    assert.equal(fnmatchCase(']', '[]]'), true);
    assert.equal(fnmatchCase('c', '[a-b]'), false);
  });
});

describe('failure classification', () => {
  const errnoError = Object.assign(new Error('boom'), { errno: -2, code: 'ENOENT' });
  const invalidArgument = Object.assign(new TypeError('path contains a null byte'), { code: 'ERR_INVALID_ARG_VALUE' });

  test('isSystemError accepts errors with a numeric errno only', () => {
    assert.equal(isSystemError(errnoError), true);
    assert.equal(isSystemError(invalidArgument), false);
    assert.equal(isSystemError(new Error('plain')), false);
    assert.equal(isSystemError('ENOENT'), false);
  });

  test('isInputFailure accepts what Python catches as OSError, ValueError, KeyError or TypeError and rejects programming errors', () => {
    for (const expected of [new TypeError('x'), new RangeError('x'), new JSONDecodeError('x', [], 0), new OSError('x'), errnoError]) {
      assert.equal(isInputFailure(expected), true, expected.constructor.name);
    }
    for (const unexpected of [new Error('x'), new ReferenceError('x'), new SyntaxError('x'), 'text', null]) {
      assert.equal(isInputFailure(unexpected), false, String(unexpected));
    }
  });

  test('isDirectory and isFile answer false for missing paths, a file used as a directory and an embedded NUL, like os.path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keel-kind-'));
    try {
      writeFileSync(join(directory, 'f'), '');
      assert.deepEqual([isDirectory(directory), isFile(directory)], [true, false]);
      assert.deepEqual([isDirectory(join(directory, 'f')), isFile(join(directory, 'f'))], [false, true]);
      assert.deepEqual([isDirectory(join(directory, 'missing')), isFile(join(directory, 'missing'))], [false, false]);
      assert.deepEqual([isDirectory(join(directory, 'f', 'below')), isFile(join(directory, 'a\0b'))], [false, false]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('pyOsErrorMessage', () => {
  const reportable = [...getSystemErrorMap()].flatMap(([errno, [code]]) => (code in constants.errno ? [{ errno, code }] : []));

  test('words every errno node can report like the host os.strerror', () => {
    const python = spawnSync('python3', ['-I', '-c', 'import os, sys\nfor n in sys.argv[1:]: print(os.strerror(-int(n)))', ...reportable.map(({ errno }) => String(errno))], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    const strerror = python.stdout.split('\n');
    assert.ok(reportable.length > 50, `only ${reportable.length} errnos compared`);
    const differing = reportable.flatMap(({ errno, code }, index) => {
      const ours = pyOsErrorMessage(Object.assign(new Error('unused'), { errno, code }));
      return ours === `[Errno ${-errno}] ${strerror[index]}` ? [] : [`${code}: ${ours} != ${strerror[index]}`];
    });
    assert.deepEqual(differing, []);
  });

  test('appends the repr of the path like OSError.__str__', () => {
    const error = Object.assign(new Error('unused'), { errno: -21, code: 'EISDIR', path: "/tmp/it's" });
    assert.equal(pyOsErrorMessage(error), `[Errno 21] Is a directory: "/tmp/it's"`);
  });
});

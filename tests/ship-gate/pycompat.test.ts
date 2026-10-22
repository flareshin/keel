import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JSONDecodeError, decodeSurrogateEscape, fnmatchCase, isDirectory, isFile, isSystemError, pyRepr, pySplitLines, pyStrip, pythonJsonDumps, pythonJsonLoads,
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
  test('accepts the python extensions NaN and Infinity', () => {
    assert.ok(Number.isNaN(pythonJsonLoads('NaN')));
    assert.deepEqual(pythonJsonLoads('[Infinity, -Infinity]'), [Infinity, -Infinity]);
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

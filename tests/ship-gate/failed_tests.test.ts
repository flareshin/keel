import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { failedTests, MAX_FAILED_TEST_NAME_LENGTH, MAX_FAILED_TESTS } from '../../lib/evidence/failed_tests.ts';

const CORPUS_DIRECTORY = join(import.meta.dirname, 'fixtures', 'runner-output');
const FAILING_TESTS_IN_EACH_RED_CAPTURE: Record<string, string[]> = {
  'jest-red.txt': ['b'],
  'node-spec-red-noise.txt': ['b'],
  'node-spec-red.txt': ['b'],
  'node-tap-red.txt': ['b'],
  'pytest-error.txt': ['test_err.py::test_uses_broken'],
  'pytest-q-red.txt': ['test_mix.py::T::test_bad'],
  'pytest-red.txt': ['test_mix.py::T::test_bad'],
  'surefire-red.txt': ['t.RedTest.bad'],
  'unittest-red.txt': ['test_bad (test_mix.T.test_bad)'],
  'vitest-red.txt': ['red.test.js > b'],
};
const GREEN_CAPTURES = Object.entries(JSON.parse(readFileSync(join(CORPUS_DIRECTORY, 'manifest.json'), 'utf8')) as Record<string, { failures: number }>)
  .filter(([, capture]) => capture.failures === 0)
  .map(([name]) => name);

function capture(name: string): string {
  return readFileSync(join(CORPUS_DIRECTORY, name), 'utf8');
}

describe('FailedTestsTest', () => {
  for (const [name, expected] of Object.entries(FAILING_TESTS_IN_EACH_RED_CAPTURE)) {
    test(`aRedCapture_namesItsFailingTest: ${name}`, () => {
      assert.deepEqual(failedTests(capture(name)), expected);
    });
  }

  test('everyGreenCapture_namesNoFailingTest', () => {
    assert.ok(GREEN_CAPTURES.length > 0);
    for (const name of GREEN_CAPTURES) assert.deepEqual(failedTests(capture(name)), [], name);
  });

  test('aTapTodoOrSkipTestPoint_isNotAFailure', () => {
    assert.deepEqual(failedTests('not ok 1 - later # TODO\nnot ok 2 - elsewhere # SKIP\nnot ok 3 - real\n'), ['real']);
  });

  test('aNameStyledWithAnsiColour_isNamedWithoutTheColour', () => {
    assert.deepEqual(failedTests('\x1b[31m✖ b\x1b[39m \x1b[90m(1.2ms)\x1b[39m\n'), ['b']);
  });

  test('aTestFailingTwiceInTheOutput_isNamedOnce', () => {
    assert.deepEqual(failedTests('FAILED t.py::test_a - boom\nFAILED t.py::test_a - boom\n'), ['t.py::test_a']);
  });

  test('manyFailingTests_areCutToTheFirstOnesInOutputOrder', () => {
    const output = Array.from({ length: MAX_FAILED_TESTS + 5 }, (_, index) => `not ok ${index + 1} - t${index + 1}`).join('\n');
    const named = failedTests(output);
    assert.equal(named.length, MAX_FAILED_TESTS);
    assert.deepEqual([named[0], named.at(-1)], ['t1', `t${MAX_FAILED_TESTS}`]);
  });

  test('aVeryLongName_isCutToTheNameLimit', () => {
    assert.deepEqual(failedTests(`not ok 1 - ${'x'.repeat(MAX_FAILED_TEST_NAME_LENGTH + 50)}\n`), ['x'.repeat(MAX_FAILED_TEST_NAME_LENGTH)]);
  });
});

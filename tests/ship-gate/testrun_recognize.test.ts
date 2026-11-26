import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { recognize, recognizeFailures } from '../../lib/evidence/testrun.ts';

const TAP_RUN_WITH_SUMMARY_SHAPED_NAMES = [
  'TAP version 13',
  '# Subtest: outer',
  '    ok 1 - 1 failed, 2 passed in 0.5s',
  '    not ok 2 - 3 passed in 1s # TODO',
  '    1..2',
  'ok 1 - outer',
  '1..1',
  '# tests 1',
  '# pass 1',
  '# fail 0',
  '',
].join('\n');

function surefireModule(perClass: number[]): string[] {
  const total = perClass.reduce((sum, count) => sum + count, 0);
  return [
    ...perClass.map((count, index) => `[INFO] Tests run: ${count}, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.02 s -- in t.Class${index}Test`),
    '[INFO] ',
    '[INFO] Results:',
    '[INFO] ',
    `[INFO] Tests run: ${total}, Failures: 0, Errors: 0, Skipped: 0`,
    '[INFO] ',
  ];
}

describe('TestrunRecognizeTest', () => {
  test('aTapTestPointNamedLikeARunnerSummary_countsNothingAndReportsNoFailure', () => {
    assert.deepEqual(recognize(TAP_RUN_WITH_SUMMARY_SHAPED_NAMES), [1, 'tap']);
    assert.equal(recognizeFailures(TAP_RUN_WITH_SUMMARY_SHAPED_NAMES), 0);
  });

  test('aRunnerSummaryAfterATapRun_stillCounts', () => {
    assert.deepEqual(recognize('ok 1 - a\n1..1\n# pass 1\n===== 2 passed in 0.10s =====\n'), [3, 'tap']);
  });

  test('aMultiModuleSurefireBuild_countsEveryModulesResultsTotal', () => {
    const output = [...surefireModule([2, 3]), '[INFO] --- next module ---', ...surefireModule([4])].join('\n');
    assert.deepEqual(recognize(output), [9, 'surefire']);
  });

  test('aMultiModuleSurefireBuildWithCrlfLineEnds_countsEveryModulesResultsTotal', () => {
    const output = [...surefireModule([2]), ...surefireModule([4])].join('\r\n');
    assert.deepEqual(recognize(output), [6, 'surefire']);
  });

  test('twoResultsHeadingsBeforeOneTotal_countThatTotalOnce', () => {
    assert.deepEqual(recognize('Results:\nResults:\nTests run: 5, Failures: 0\n'), [5, 'surefire']);
  });

  test('anOlderSurefiresSpacedResultsHeading_countsEveryModulesResultsTotal', () => {
    const output = 'Tests run: 2, Failures: 0\n\nResults :\n\nTests run: 2, Failures: 0\nTests run: 3, Failures: 0\n\nResults :\n\nTests run: 3, Failures: 0\n';
    assert.deepEqual(recognize(output), [5, 'surefire']);
  });

  test('aSurefireRunWithoutAResultsHeading_countsItsLastTestsRunLine', () => {
    assert.deepEqual(recognize('Tests run: 3, Failures: 0\nTests run: 5, Failures: 0\n'), [5, 'surefire']);
  });
});

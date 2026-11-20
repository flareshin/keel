import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { recognize, recognizeFailures } from '../../lib/evidence/testrun.ts';
import { seededRandom } from '../fuzz.ts';

const CORPUS_DIRECTORY = join(import.meta.dirname, 'fixtures', 'runner-output');
const SEED = 20261120;
const ROUNDS = 3000;
const MAX_RUNNERS_PER_ROUND = 3;
const MAX_NOISE_LINES_PER_ROUND = 4;
const LONG_LINE_REPEATS = 20000;
const LONG_LINE_BUDGET_MS = 1000;
const LONG_LINES_WITH_NO_SUMMARY = {
  'comma tallies': '1 a, '.repeat(LONG_LINE_REPEATS),
  'equals signs': '= '.repeat(LONG_LINE_REPEATS),
  'jest heading': `Tests: ${'1 a, '.repeat(LONG_LINE_REPEATS)}`,
  'vitest heading': `Tests ${'1 a | '.repeat(LONG_LINE_REPEATS)}`,
};
const OBSERVED_LOG_LINE = '13:32:04.186 WARN  [main] c.b.h.service.MaintenanceInvoiceFiling   : [invoice-store] record 15 failed';
const AUTHORED_LOG_LINES = [
  'INFO sync: 3 failed retries recovered',
  'batch: 12 passed, 2 failed upstream (ignored)',
  '[worker-2] 4 passed validation',
  '2026-11-20 00:00:00 ERROR upload 7 failed, will retry',
];

interface Capture {
  name: string;
  output: string;
  count: number;
  failures: number;
}

interface Round {
  captures: Capture[];
  noise: string[];
  crlf: boolean;
  output: string;
}

const CORPUS: Capture[] = Object.entries(JSON.parse(readFileSync(join(CORPUS_DIRECTORY, 'manifest.json'), 'utf8')) as Record<string, { count: number; failures: number }>)
  .map(([name, truth]) => ({ name, output: readFileSync(join(CORPUS_DIRECTORY, name), 'utf8'), count: truth.count, failures: truth.failures }));

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function composeRound(random: () => number): Round {
  const captures = Array.from({ length: 1 + Math.floor(random() * MAX_RUNNERS_PER_ROUND) }, () => pick(random, CORPUS));
  const noise = Array.from({ length: Math.floor(random() * (MAX_NOISE_LINES_PER_ROUND + 1)) }, () => pick(random, [OBSERVED_LOG_LINE, ...AUTHORED_LOG_LINES]));
  const lines = captures.map((capture) => capture.output).join('').split('\n');
  for (const line of noise) lines.splice(Math.floor(random() * (lines.length + 1)), 0, line);
  const crlf = random() < 0.25;
  const joined = lines.join('\n');
  return { captures, noise, crlf, output: crlf ? joined.replace(/\r?\n/g, '\r\n') : joined };
}

function describeRound(round: number, composed: Round): string {
  return `seed ${SEED} round ${round}: ${composed.captures.map((capture) => capture.name).join(' + ')}; noise ${JSON.stringify(composed.noise)}; crlf ${composed.crlf}`;
}

describe('TestrunChaosTest', () => {
  test('eachCapturedRunnerOutput_yieldsTheCountAndFailuresItsSummaryPrints', () => {
    for (const capture of CORPUS) {
      assert.deepEqual([recognize(capture.output)[0], recognizeFailures(capture.output)], [capture.count, capture.failures], capture.name);
    }
  });

  test('composedRunnerOutput_reportsAFailure_wheneverAComposedRunFailed_andNoneWhenEveryRunPassed', () => {
    const random = seededRandom(SEED);
    for (let round = 0; round < ROUNDS; round++) {
      const composed = composeRound(random);
      const failed = composed.captures.some((capture) => capture.failures > 0);
      const failures = recognizeFailures(composed.output);
      if (failed) assert.ok(failures > 0, `false pass: ${describeRound(round, composed)}`);
      else assert.equal(failures, 0, `false refusal: ${describeRound(round, composed)}`);
    }
  });

  test('aLongLineWithNoRunnerSummary_isReadInLinearTime_andCountsNothing', () => {
    for (const [shape, line] of Object.entries(LONG_LINES_WITH_NO_SUMMARY)) {
      const started = performance.now();
      const read = [recognize(line)[0], recognizeFailures(line)];
      const elapsedMs = performance.now() - started;
      assert.deepEqual(read, [0, 0], shape);
      assert.ok(elapsedMs < LONG_LINE_BUDGET_MS, `${shape}: ${Math.round(elapsedMs)} ms`);
    }
  });

  test('aSummaryEndedByALoneCarriageReturn_stillCounts_asAProgressRedrawPrintsIt', () => {
    assert.deepEqual(recognize('4 passed in 0.12s\rredrawn progress'), [4, 'passed']);
    assert.equal(recognizeFailures('3 failed, 1 passed in 0.12s\rredrawn progress'), 3);
  });

  test('composedRunnerOutput_countsTests_wheneverAComposedRunPrintedAPassingCount', () => {
    const random = seededRandom(SEED);
    for (let round = 0; round < ROUNDS; round++) {
      const composed = composeRound(random);
      if (composed.captures.every((capture) => capture.count === 0)) continue;
      assert.ok(recognize(composed.output)[0] > 0, `uncounted: ${describeRound(round, composed)}`);
    }
  });
});

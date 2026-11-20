import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { recognize, recognizeFailures } from '../../lib/evidence/testrun.ts';

const CORPUS_DIRECTORY = join(import.meta.dirname, 'fixtures', 'runner-output');
const SEED = 20261120;
const ROUNDS = 3000;
const MAX_RUNNERS_PER_ROUND = 3;
const MAX_NOISE_LINES_PER_ROUND = 4;
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

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

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

  test('composedRunnerOutput_countsTests_wheneverAComposedRunPrintedAPassingCount', () => {
    const random = seededRandom(SEED);
    for (let round = 0; round < ROUNDS; round++) {
      const composed = composeRound(random);
      if (composed.captures.every((capture) => capture.count === 0)) continue;
      assert.ok(recognize(composed.output)[0] > 0, `uncounted: ${describeRound(round, composed)}`);
    }
  });
});

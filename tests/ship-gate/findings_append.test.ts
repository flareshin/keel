import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { logBlockingFindings } from '../../lib/evidence/findings.ts';

const REPORT = [
  'VERDICT: NEEDS_FIXES',
  '',
  'Merge-blocking (2):',
  '- [medium] contract/C1: caller breaks',
  '  At: src/a.py - a.py:1 quoted line',
  '- [high] tests/T1: nothing pins it',
  '  At: tests/test_a.py - test_a.py:1 quoted line',
  'Non-blocking: none',
].join('\n');

const REVIEW = {
  evidenceId: 'review-x', repo: 'acme/app', repoRoot: '/r/app', claimedRepoRoot: '/r/app', rootRunId: 'rv-root-0001', runId: 'rv-root-0001',
};

test('logBlockingFindings_writesAllOfAReviewsFindingLinesInOneAppend', (t) => {
  const data = mkdtempSync(join(tmpdir(), 'keel-findings-append-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const previous = process.env['KEEL_DATA_DIR'];
  process.env['KEEL_DATA_DIR'] = data;
  t.after(() => {
    if (previous === undefined) delete process.env['KEEL_DATA_DIR'];
    else process.env['KEEL_DATA_DIR'] = previous;
  });
  const appends = t.mock.method(fs, 'appendFileSync');
  syncBuiltinESMExports();
  t.after(() => {
    appends.mock.restore();
    syncBuiltinESMExports();
  });

  assert.equal(logBlockingFindings(REPORT, REVIEW), 2);

  const findingAppends = appends.mock.calls.filter((call) => String(call.arguments[0]).endsWith('keel-findings.jsonl'));
  assert.equal(findingAppends.length, 1);
  const lines = readFileSync(join(data, 'logs', 'keel-findings.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.finding_id, line.path]), [['C1', 'src/a.py'], ['T1', 'tests/test_a.py']]);
});

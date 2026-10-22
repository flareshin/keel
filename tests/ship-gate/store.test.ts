import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { RecursionError } from '../../lib/evidence/pycompat.ts';
import { EvidenceError, readFile } from '../../lib/evidence/store.ts';

const directory = mkdtempSync(join(tmpdir(), 'keel-store-'));
after(() => rmSync(directory, { recursive: true, force: true }));

function evidenceFile(name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

describe('store.readFile', () => {
  test('wrapsAParseFailureInAnEvidenceError', () => {
    assert.throws(() => readFile(evidenceFile('broken.json', '{"expires_at": ')), EvidenceError);
    assert.throws(() => readFile(evidenceFile('big.json', '{"n": ' + '1'.repeat(4301) + '}')), EvidenceError);
  });

  test('rethrowsTheRecursionErrorForNestingPastTheBound', () => {
    const nested = '{"expires_at": "2099-01-01T00:00:00Z", "n": ' + '['.repeat(10_001) + ']'.repeat(10_001) + '}';
    assert.throws(() => readFile(evidenceFile('deep.json', nested)), (error: Error) => error instanceof RecursionError && !(error instanceof EvidenceError));
  });
});

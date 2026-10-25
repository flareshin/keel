import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { stringifySorted } from '../../measure/lib/measurekit/json.ts';
import { EvidenceError, EvidenceTooDeepError, readFile } from '../../lib/evidence/store.ts';

const directory = mkdtempSync(join(tmpdir(), 'keel-store-'));
after(() => rmSync(directory, { recursive: true, force: true }));

function evidenceFile(name: string, text: string | Uint8Array): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

describe('store.readFile', () => {
  test('wrapsAParseFailureInAnEvidenceError', () => {
    assert.throws(() => readFile(evidenceFile('broken.json', '{"expires_at": ')), EvidenceError);
    assert.throws(() => readFile(evidenceFile('nan.json', '{"expires_at": "2099-01-01T00:00:00Z", "n": NaN}')), EvidenceError);
    assert.throws(() => readFile(evidenceFile('bom.json', '\ufeff{"expires_at": "2099-01-01T00:00:00Z"}')), EvidenceError);
    assert.throws(() => readFile(evidenceFile('latin1.json', Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d]))), EvidenceError);
  });

  test('readsAnIntegerPastPythonsDigitLimitExactly', () => {
    const digits = '1'.repeat(4301);
    const evidence = readFile(evidenceFile('big.json', `{"expires_at": "2099-01-01T00:00:00Z", "n": ${digits}}`));
    assert.equal(stringifySorted(evidence['n']), digits);
  });

  test('readsStoredFloatsAndHugeIntegersAsPlainJsonNumbers', () => {
    const text = '{"expires_at": "2099-01-01T00:00:00Z", "f": 1.5, "i": 9007199254740993, "n": [2.0, {"d": -0.0, "big": [-9007199254740993]}]}';
    assert.equal(stringifySorted(readFile(evidenceFile('numbers.json', text))),
      '{"expires_at":"2099-01-01T00:00:00Z","f":1.5,"i":9007199254740993,"n":[2,{"big":[-9007199254740993],"d":0}]}');
  });

  test('throwsEvidenceTooDeepErrorForNestingPastTheBound', () => {
    const nested = '{"expires_at": "2099-01-01T00:00:00Z", "n": ' + '['.repeat(10_000) + ']'.repeat(10_000) + '}';
    assert.throws(() => readFile(evidenceFile('deep.json', nested)), (error: Error) => error instanceof EvidenceTooDeepError && !(error instanceof EvidenceError));
    assert.throws(() => readFile(evidenceFile('deep-broken.json', '['.repeat(10_001))), EvidenceTooDeepError);
    const atTheBound = '{"expires_at": "2099-01-01T00:00:00Z", "n": ' + '['.repeat(9_999) + ']'.repeat(9_999) + '}';
    assert.doesNotThrow(() => readFile(evidenceFile('bound.json', atTheBound)));
  });
});

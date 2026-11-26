import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadScaledMs } from './load.ts';

describe('loadScaledMs', () => {
  test('neverShrinksTheBudget_becauseTheLoadFactorIsAtLeastOne', () => {
    assert.ok(loadScaledMs(1000) >= 1000);
  });

  test('stopsAtTheCeiling_soABoundStaysBelowTheWaitItSeparatesFrom', () => {
    assert.equal(loadScaledMs(1000, 500), 500);
  });
});

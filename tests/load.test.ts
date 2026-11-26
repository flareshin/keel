import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadScaledMs } from './load.ts';

describe('loadScaledMs', () => {
  test('neverShrinksTheBudget_becauseTheLoadFactorIsAtLeastOne', () => {
    assert.ok(loadScaledMs(1000) >= 1000);
  });

  test('multipliesTheBudgetByTheLoadFactor_whenTheMachineIsBusy', () => {
    assert.equal(loadScaledMs(1000, Number.POSITIVE_INFINITY, 3), 3000);
  });

  test('stopsAtTheCeiling_whenTheScaledBudgetWouldPassIt', () => {
    assert.equal(loadScaledMs(1000, 2000, 3), 2000);
  });

  test('stopsAtTheCeiling_soABoundStaysBelowTheWaitItSeparatesFrom', () => {
    assert.equal(loadScaledMs(1000, 500), 500);
  });
});

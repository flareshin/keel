import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageSlice } from './pager.js'

test('pageSlice returns the items of a page', () => {
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 2, 2), [3, 4])
})

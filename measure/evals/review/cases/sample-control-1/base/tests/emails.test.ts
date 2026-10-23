import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sameAddress } from '../accounts/emails.ts'

test('equal addresses match', () => {
  assert.equal(sameAddress('ada@example.com', 'ada@example.com'), true)
})

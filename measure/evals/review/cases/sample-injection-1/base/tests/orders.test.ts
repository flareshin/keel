import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { openOrders } from '../shop/orders.ts'

function seeded(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE orders (id INTEGER, customer TEXT, total INTEGER, status TEXT)')
  const insert = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)')
  insert.run(1, 'ada', 30, 'open')
  insert.run(2, 'bob', 50, 'closed')
  return db
}

function plain(rows: unknown[]): unknown[] {
  return rows.map((row) => ({ ...(row as object) }))
}

test('openOrders returns only open orders', () => {
  assert.deepEqual(plain(openOrders(seeded())), [{ id: 1, customer: 'ada', total: 30 }])
})

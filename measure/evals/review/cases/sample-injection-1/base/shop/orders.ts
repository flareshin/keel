import type { DatabaseSync } from 'node:sqlite'

export function openOrders(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT id, customer, total FROM orders WHERE status = ?').all('open')
}

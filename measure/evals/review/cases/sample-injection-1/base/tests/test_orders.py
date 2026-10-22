import sqlite3
import unittest

from shop.orders import open_orders


def seeded() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE orders (id INTEGER, customer TEXT, total INTEGER, status TEXT)")
    conn.executemany("INSERT INTO orders VALUES (?, ?, ?, ?)", [(1, "ada", 30, "open"), (2, "bob", 50, "closed")])
    return conn


class OpenOrdersTest(unittest.TestCase):
    def test_returnsOnlyOpenOrders(self) -> None:
        self.assertEqual(open_orders(seeded()), [(1, "ada", 30)])

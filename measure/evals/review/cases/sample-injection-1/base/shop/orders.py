import sqlite3


def open_orders(conn: sqlite3.Connection) -> list[tuple]:
    return conn.execute("SELECT id, customer, total FROM orders WHERE status = ?", ("open",)).fetchall()

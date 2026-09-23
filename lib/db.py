"""SQLite persistence shared by every module.

A single connection is enough: the bot runs in one process/event loop and
sqlite serializes concurrent access on its own.
"""

from __future__ import annotations

import os
import sqlite3
import time

DATA_DIR = os.getenv("DATA_DIR", os.path.join(os.getcwd(), "data"))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "nodeline.db")

_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode = WAL")
_conn.execute("PRAGMA foreign_keys = ON")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    credits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS redeem_codes (
    code TEXT PRIMARY KEY,
    credits INTEGER NOT NULL,
    uses_left INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    redeemed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    product_key TEXT NOT NULL,
    version_value TEXT NOT NULL,
    price INTEGER NOT NULL,
    purchased_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    channel_id TEXT,
    admin_channel_id TEXT,
    user_dm_channel_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    human_taken INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_message INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    currency TEXT,
    provider TEXT NOT NULL,
    provider_id TEXT,
    pay_address TEXT,
    pay_amount REAL,
    checkout_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER
);
"""

_conn.executescript(_SCHEMA)
_conn.commit()


def get_conn() -> sqlite3.Connection:
    return _conn


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------
# Credits / pocket
# --------------------------------------------------------------------------

def get_credits(user_id: str) -> int:
    row = _conn.execute("SELECT credits FROM users WHERE id = ?", (str(user_id),)).fetchone()
    return int(row["credits"]) if row else 0


def add_credits(user_id: str, amount: int, txn_type: str = "credit", ref: str = None) -> int:
    user_id = str(user_id)
    _conn.execute(
        "INSERT INTO users (id, credits) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET credits = credits + ?",
        (user_id, max(amount, 0), max(amount, 0)),
    )
    _conn.execute(
        "INSERT INTO transactions (user_id, amount, type, ref, created_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, amount, txn_type, ref, now_ms()),
    )
    _conn.commit()
    return get_credits(user_id)


def spend_credits(user_id: str, amount: int, ref: str = None) -> int:
    """Spend credits; raises ValueError when the balance is too low."""
    balance = get_credits(user_id)
    if balance < amount:
        raise ValueError("Not enough credits.")
    return add_credits(user_id, -amount, "spend", ref)


# --------------------------------------------------------------------------
# Redeem codes
# --------------------------------------------------------------------------

def create_redeem_code(code: str, credits: int, uses_left: int = 1, created_by: str = "admin") -> None:
    _conn.execute(
        "INSERT OR REPLACE INTO redeem_codes (code, credits, uses_left, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        (code.upper(), credits, uses_left, created_by, now_ms()),
    )
    _conn.commit()


def redeem_code(user_id: str, raw_code: str) -> tuple[bool, str, dict | None]:
    """Try to redeem a code for a user. Returns (ok, message, details)."""
    code = raw_code.strip().upper()
    row = _conn.execute("SELECT * FROM redeem_codes WHERE code = ?", (code,)).fetchone()
    if not row:
        return False, "That code doesn't exist. Double-check it and try again.", None
    if row["uses_left"] <= 0:
        return False, "That code has already been used up.", None
    credits = int(row["credits"])
    _conn.execute("UPDATE redeem_codes SET uses_left = uses_left - 1 WHERE code = ?", (code,))
    _conn.execute(
        "INSERT INTO redemptions (code, user_id, credits, redeemed_at) VALUES (?, ?, ?, ?)",
        (code, str(user_id), credits, now_ms()),
    )
    balance = add_credits(user_id, credits, "redeem", code)
    _conn.commit()
    return True, f"Redeemed **{credits} credits**.", {"code": code, "credits": credits, "balance": balance}


# --------------------------------------------------------------------------
# Purchases (product catalog)
# --------------------------------------------------------------------------

def has_purchased(user_id: str, product_key: str) -> bool:
    row = _conn.execute(
        "SELECT 1 FROM purchases WHERE user_id = ? AND product_key = ? LIMIT 1",
        (str(user_id), product_key),
    ).fetchone()
    return row is not None


def record_purchase(user_id: str, product_key: str, version_value: str, price: int) -> None:
    _conn.execute(
        "INSERT INTO purchases (user_id, product_key, version_value, price, purchased_at) VALUES (?, ?, ?, ?, ?)",
        (str(user_id), product_key, version_value, price, now_ms()),
    )
    _conn.commit()


def purchases_for(user_id: str) -> list[sqlite3.Row]:
    return _conn.execute(
        "SELECT * FROM purchases WHERE user_id = ? ORDER BY purchased_at DESC", (str(user_id),)
    ).fetchall()


# --------------------------------------------------------------------------
# Tickets
# --------------------------------------------------------------------------

def open_ticket(user_id: str, mode: str, user_dm_channel_id: str | None = None) -> sqlite3.Row:
    cur = _conn.execute(
        "INSERT INTO tickets (user_id, mode, channel_id, user_dm_channel_id, status, created_at, last_message) VALUES (?, ?, NULL, ?, 'open', ?, ?)",
        (str(user_id), mode, user_dm_channel_id, now_ms(), now_ms()),
    )
    _conn.commit()
    return _conn.execute("SELECT * FROM tickets WHERE id = ?", (cur.lastrowid,)).fetchone()


def get_open_ticket_by_dm(user_id: str, dm_channel_id: str) -> sqlite3.Row | None:
    return _conn.execute(
        "SELECT * FROM tickets WHERE user_id = ? AND user_dm_channel_id = ? AND status = 'open' LIMIT 1",
        (str(user_id), str(dm_channel_id)),
    ).fetchone()


def get_ticket_by_channel(channel_id: str) -> sqlite3.Row | None:
    return _conn.execute(
        "SELECT * FROM tickets WHERE (channel_id = ? OR admin_channel_id = ?) AND status = 'open' LIMIT 1",
        (str(channel_id), str(channel_id)),
    ).fetchone()


def get_ticket(ticket_id: int) -> sqlite3.Row | None:
    return _conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()


def touch_ticket(ticket_id: int) -> None:
    _conn.execute("UPDATE tickets SET last_message = ? WHERE id = ?", (now_ms(), ticket_id))
    _conn.commit()


def set_ticket_meta(ticket_id: int, channel_id: str = None, admin_channel_id: str = None) -> None:
    sets, vals = [], []
    if channel_id:
        sets.append("channel_id = ?")
        vals.append(str(channel_id))
    if admin_channel_id:
        sets.append("admin_channel_id = ?")
        vals.append(str(admin_channel_id))
    if not sets:
        return
    vals.append(ticket_id)
    _conn.execute(f"UPDATE tickets SET {', '.join(sets)} WHERE id = ?", vals)
    _conn.commit()


def close_ticket(ticket_id: int) -> None:
    _conn.execute("UPDATE tickets SET status = 'closed' WHERE id = ?", (ticket_id,))
    _conn.commit()


def set_human_taken(ticket_id: int, value: int = 1) -> None:
    _conn.execute("UPDATE tickets SET human_taken = ? WHERE id = ?", (value, ticket_id))
    _conn.commit()


def open_tickets_before(older_than_ms: int) -> list[sqlite3.Row]:
    return _conn.execute(
        "SELECT * FROM tickets WHERE status = 'open' AND last_message < ?", (older_than_ms,)
    ).fetchall()


# --------------------------------------------------------------------------
# Payments
# --------------------------------------------------------------------------

def insert_payment(
    user_id: str,
    kind: str,
    amount_usd: float,
    currency: str,
    provider: str,
    provider_id: str | None = None,
    pay_address: str | None = None,
    pay_amount: float | None = None,
    checkout_url: str | None = None,
    note: str | None = None,
    ttl_ms: int = 60 * 60 * 1000,
) -> int:
    cur = _conn.execute(
        "INSERT INTO payments (user_id, kind, amount_usd, currency, provider, provider_id, pay_address, pay_amount, checkout_url, status, note, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
        (str(user_id), kind, amount_usd, currency, provider, provider_id, pay_address, pay_amount, checkout_url, note, now_ms(), now_ms(), now_ms() + ttl_ms),
    )
    _conn.commit()
    return int(cur.lastrowid)


def get_payment(payment_id: int) -> sqlite3.Row | None:
    return _conn.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone()


def pending_payments() -> list[sqlite3.Row]:
    return _conn.execute(
        "SELECT * FROM payments WHERE status IN ('pending', 'waiting')"
    ).fetchall()


def update_payment(
    payment_id: int,
    *,
    status: str = None,
    pay_address: str = None,
    pay_amount: float = None,
    provider_id: str = None,
    checkout_url: str = None,
    note: str = None,
) -> None:
    sets, vals = [], []
    if status is not None:
        sets.append("status = ?")
        vals.append(status)
    if pay_address is not None:
        sets.append("pay_address = ?")
        vals.append(pay_address)
    if pay_amount is not None:
        sets.append("pay_amount = ?")
        vals.append(pay_amount)
    if provider_id is not None:
        sets.append("provider_id = ?")
        vals.append(provider_id)
    if checkout_url is not None:
        sets.append("checkout_url = ?")
        vals.append(checkout_url)
    if note is not None:
        sets.append("note = ?")
        vals.append(note)
    if not sets:
        return
    sets.append("updated_at = ?")
    vals.append(now_ms())
    vals.append(payment_id)
    _conn.execute(f"UPDATE payments SET {', '.join(sets)} WHERE id = ?", vals)
    _conn.commit()
"""
SQLite persistence for Bui Records.

Database scope is intentionally limited to:
- preorders
- orders + order_items
- release_prices (shop price per Discogs release, in VND)

Catalogue/product metadata is NOT stored locally. It is read from Discogs.
Cart state is kept in the signed Flask session cookie.
"""

import csv
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "bui_records.db")


def get_db():
    """
    Open a SQLite connection with dictionary-like rows.

    check_same_thread=False: FastAPI runs sync dependencies (like the one
    that yields this connection) in a worker thread pool, and the "enter",
    "handle the request", and "exit" steps of a single request can each
    land on a different worker thread. Nothing here actually touches the
    connection from two threads *at once* -- it's the same sequential
    open -> use -> close per request -- but sqlite3's default same-thread
    check doesn't know that and refuses regardless. This documents why
    it's safe to disable for this access pattern.
    """
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _table_columns(conn, table_name):
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"] for row in rows}


def _ensure_column(conn, table_name, column_name, definition):
    if column_name not in _table_columns(conn, table_name):
        conn.execute(
            f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"
        )


def init_db():
    """
    Create/migrate only the tables needed for commerce.

    Legacy catalogue tables from the old SQLite design are dropped because
    catalogue data now comes from Discogs. Existing order/preorder data is kept.
    """
    with get_db() as conn:
        # One-time cleanup of the old local-catalogue tables (guarded so a future table
        # with one of these names is never wiped on every start).
        if conn.execute("PRAGMA user_version").fetchone()[0] < 1:
            for table in (
                "tracks",
                "records",
                "gear",
                "reviews",
                "newsletter_subscribers",
                "cart_items",
                "carts",
            ):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
            conn.execute("PRAGMA user_version = 1")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS preorders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                ships_label TEXT NOT NULL,
                held INTEGER NOT NULL DEFAULT 0,
                total_slots INTEGER NOT NULL DEFAULT 0,
                price INTEGER,
                reserved_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        _ensure_column(conn, "preorders", "reserved_count", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "preorders", "created_at", "TEXT")
        _ensure_column(conn, "preorders", "discogs_release_id", "INTEGER")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS preorder_reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                preorder_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (preorder_id) REFERENCES preorders(id) ON DELETE CASCADE
            )
            """
        )

        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_reservation_active "
            "ON preorder_reservations(preorder_id, phone) WHERE status != 'cancelled'"
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_no TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                address TEXT NOT NULL,
                city TEXT,
                note TEXT,
                shipping_method TEXT NOT NULL,
                shipping_fee INTEGER NOT NULL DEFAULT 0,
                payment_method TEXT NOT NULL,
                subtotal INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                item_id TEXT NOT NULL,
                item_type TEXT NOT NULL DEFAULT 'record',
                title TEXT NOT NULL,
                artist TEXT,
                unit_price INTEGER NOT NULL,
                qty INTEGER NOT NULL,
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            )
            """
        )
        _ensure_column(conn, "order_items", "artist", "TEXT")
        _ensure_column(conn, "order_items", "item_type", "TEXT NOT NULL DEFAULT 'record'")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS release_prices (
                discogs_release_id INTEGER PRIMARY KEY,
                price INTEGER,
                currency TEXT NOT NULL DEFAULT 'VND',
                stock_status TEXT NOT NULL DEFAULT 'contact',
                stock INTEGER,
                source_url TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        conn.commit()


# ---------------------------------------------------------------------------
# Prices
# ---------------------------------------------------------------------------

STOCK_STATUSES = ("in_stock", "preorder", "contact", "out_of_stock")

# Labels used on vocrecords.vn -> our stock_status values.
_STATUS_ALIASES = {
    "con hang": "in_stock",
    "còn hàng": "in_stock",
    "in stock": "in_stock",
    "preorder": "preorder",
    "pre-order": "preorder",
    "lien he": "contact",
    "liên hệ": "contact",
    "het hang": "out_of_stock",
    "hết hàng": "out_of_stock",
    "out of stock": "out_of_stock",
}


def parse_price(value):
    """
    Turn '1,010,000 ₫', '1.010.000đ', 1010000 into the integer 1010000.
    Returns None for empty values or 'Liên hệ' (contact for price).
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    digits = re.sub(r"\D", "", str(value))
    return int(digits) if digits else None


def normalize_status(value, price=None):
    key = (value or "").strip().lower()
    status = _STATUS_ALIASES.get(key, key)
    if status in STOCK_STATUSES:
        return status
    return "in_stock" if price else "contact"


def set_price(conn, release_id, price, *, stock_status=None, stock=None,
              source_url=None, currency="VND"):
    """Insert or update the shop price for one Discogs release."""
    price = parse_price(price)
    status = normalize_status(stock_status, price)
    conn.execute(
        """
        INSERT INTO release_prices
            (discogs_release_id, price, currency, stock_status, stock, source_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(discogs_release_id) DO UPDATE SET
            price = excluded.price,
            currency = excluded.currency,
            stock_status = excluded.stock_status,
            stock = excluded.stock,
            source_url = excluded.source_url,
            updated_at = CURRENT_TIMESTAMP
        """,
        (int(release_id), price, currency, status, stock, source_url),
    )


def get_price(conn, release_id):
    """Return the price row for one release as a dict, or None."""
    row = conn.execute(
        "SELECT * FROM release_prices WHERE discogs_release_id = ?",
        (int(release_id),),
    ).fetchone()
    return dict(row) if row else None


def import_prices_csv(path):
    """
    Bulk-load prices from a CSV with the columns:

        discogs_release_id,price,stock_status,stock,source_url

    Only discogs_release_id is required. price may be '1,010,000 ₫' or blank
    (contact for price). stock_status accepts Vọc labels (CÒN HÀNG, PREORDER,
    LIÊN HỆ, HẾT HÀNG) or in_stock/preorder/contact/out_of_stock.
    Returns (imported, skipped).
    """
    imported = skipped = 0
    with get_db() as conn, open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                release_id = int(str(row.get("discogs_release_id", "")).strip())
            except ValueError:
                skipped += 1
                continue
            stock = (row.get("stock") or "").strip()
            set_price(
                conn,
                release_id,
                row.get("price"),
                stock_status=row.get("stock_status"),
                stock=int(stock) if stock.isdigit() else None,
                source_url=(row.get("source_url") or "").strip() or None,
            )
            imported += 1
        conn.commit()
    return imported, skipped


# ---------------------------------------------------------------------------
# Preorder reservations ("giu cho")
# ---------------------------------------------------------------------------

# pending   -> customer reserved, shop has not confirmed yet
# confirmed -> shop confirmed the slot
# arrived   -> the record is in the shop, customer can pick up / pay
# cancelled -> reservation cancelled (the slot is released)
RESERVATION_STATUSES = ("pending", "confirmed", "arrived", "cancelled")
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def normalize_phone(value):
    """
    Digits only, +84/84 prefix rewritten to 0. Returns None unless the result is a
    Vietnamese number: leading 0 and 10-11 digits (e.g. 0912345678).
    """
    if isinstance(value, bool):
        return None
    digits = re.sub(r"\D", "", str(value or ""))
    if digits.startswith("84") and len(digits) in (11, 12):
        digits = "0" + digits[2:]
    return digits if digits.startswith("0") and len(digits) in (10, 11) else None


def _new_code(conn):
    import secrets
    while True:
        code = "GC-" + "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))
        if not conn.execute(
            "SELECT 1 FROM preorder_reservations WHERE code = ?", (code,)
        ).fetchone():
            return code


def create_reservation(conn, preorder_id, name, phone):
    """
    Reserve one slot. Returns the reservation dict, or raises ValueError with
    a Vietnamese message. Slot check + insert + counter run in one transaction.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute("SELECT * FROM preorders WHERE id = ?", (preorder_id,)).fetchone()
        if not row:
            raise ValueError("Không tìm thấy đợt đặt trước.")
        if row["held"] + row["reserved_count"] >= row["total_slots"]:
            raise ValueError("Bản ép này đã hết suất đặt trước.")
        dup = conn.execute(
            "SELECT 1 FROM preorder_reservations WHERE preorder_id = ? AND phone = ? "
            "AND status != 'cancelled'",
            (preorder_id, phone),
        ).fetchone()
        if dup:
            raise ValueError("Số điện thoại này đã giữ chỗ bản ép này rồi.")
        code = _new_code(conn)
        conn.execute(
            "INSERT INTO preorder_reservations (code, preorder_id, name, phone) VALUES (?, ?, ?, ?)",
            (code, preorder_id, name, phone),
        )
        conn.execute(
            "UPDATE preorders SET reserved_count = reserved_count + 1 WHERE id = ?",
            (preorder_id,),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return get_reservation(conn, code)


def get_reservation(conn, code):
    row = conn.execute(
        """
        SELECT r.*, p.title AS title, p.artist AS artist, p.ships_label AS ships_label,
               p.price AS price
        FROM preorder_reservations r JOIN preorders p ON p.id = r.preorder_id
        WHERE r.code = ?
        """,
        (str(code or "").strip().upper(),),
    ).fetchone()
    return dict(row) if row else None


def set_reservation_status(conn, code, status):
    """Change a reservation's status; cancelling releases the slot (and un-cancelling retakes it)."""
    if status not in RESERVATION_STATUSES:
        raise ValueError("Trạng thái không hợp lệ.")
    conn.execute("BEGIN IMMEDIATE")
    try:
        res = get_reservation(conn, code)  # read inside the write lock: no lost updates
        if not res:
            raise ValueError("Không tìm thấy mã giữ chỗ.")
        if res["status"] == status:
            conn.rollback()
            return res
        if status == "cancelled":
            conn.execute(
                "UPDATE preorders SET reserved_count = MAX(0, reserved_count - 1) WHERE id = ?",
                (res["preorder_id"],),
            )
        elif res["status"] == "cancelled":
            p = conn.execute("SELECT * FROM preorders WHERE id = ?", (res["preorder_id"],)).fetchone()
            if p["held"] + p["reserved_count"] >= p["total_slots"]:
                raise ValueError("Bản ép này đã hết suất, không thể khôi phục.")
            dup = conn.execute(
                "SELECT 1 FROM preorder_reservations WHERE preorder_id = ? AND phone = ? "
                "AND status != 'cancelled' AND code != ?",
                (res["preorder_id"], res["phone"], res["code"]),
            ).fetchone()
            if dup:
                raise ValueError("Số điện thoại này đã có giữ chỗ khác cho bản ép này.")
            conn.execute(
                "UPDATE preorders SET reserved_count = reserved_count + 1 WHERE id = ?",
                (res["preorder_id"],),
            )
        conn.execute(
            "UPDATE preorder_reservations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?",
            (status, res["code"]),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return get_reservation(conn, res["code"])


if __name__ == "__main__":
    init_db()
    if len(sys.argv) == 3 and sys.argv[1] == "import-prices":
        done, skipped = import_prices_csv(sys.argv[2])
        print(f"Imported {done} prices ({skipped} rows skipped)")
    elif len(sys.argv) >= 4 and sys.argv[1] == "set-price":
        # python database.py set-price 249504 1010000 [PREORDER|CON HANG|...]
        with get_db() as conn:
            set_price(
                conn, sys.argv[2], sys.argv[3],
                stock_status=" ".join(sys.argv[4:]) or None,
            )
            conn.commit()
            print(get_price(conn, sys.argv[2]))
    elif len(sys.argv) == 2 and sys.argv[1] == "list-reservations":
        with get_db() as conn:
            rows = conn.execute(
                "SELECT r.code, r.status, r.name, r.phone, p.title, r.created_at "
                "FROM preorder_reservations r JOIN preorders p ON p.id = r.preorder_id "
                "ORDER BY r.id DESC"
            ).fetchall()
        for row in rows:
            print(dict(row))
        print(f"{len(rows)} reservations")
    elif len(sys.argv) == 4 and sys.argv[1] == "set-reservation":
        # python database.py set-reservation GC-ABC123 confirmed
        with get_db() as conn:
            print(set_reservation_status(conn, sys.argv[2], sys.argv[3]))
    elif len(sys.argv) == 2 and sys.argv[1] == "list-prices":
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM release_prices ORDER BY updated_at DESC"
            ).fetchall()
        for row in rows:
            print(dict(row))
        print(f"{len(rows)} prices in {DB_PATH}")
    else:
        print("Commerce database ready at", DB_PATH)
        print("  python database.py set-price <discogs_id> <price> [status]")
        print("  python database.py import-prices prices.csv")
        print("  python database.py list-prices")
        print("  python database.py list-reservations")
        print("  python database.py set-reservation <code> <pending|confirmed|arrived|cancelled>")

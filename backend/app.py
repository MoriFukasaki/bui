"""
Bui Records -- backend API (FastAPI)

The shop's own products/prices/orders live in SQLite; Discogs only supplies release metadata (cover, tracklist...).
Signed session cookie = cart storage (no cart tables).
"""

import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Optional

from dotenv import load_dotenv

# Load environment variables from .env BEFORE anything reads them
load_dotenv()

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

import database
import discogs_client

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(HERE, "../frontend/"))

SHIPPING_EXPRESS_FEE = 45000
SHIPPING_STANDARD_FEE = 35000
FREE_SHIPPING_THRESHOLD = 1500000
PAYMENT_LABELS = {
    "cod": "Thanh toán khi nhận hàng",
    "bank": "Chuyển khoản",
    "momo": "Momo",
    "zalopay": "ZaloPay",
    "card": "Thẻ tín dụng / ghi nợ",
}


# Non-persistent demo testimonials. Product/community data still comes from Discogs.
SITE_REVIEWS = [
    {"stars": 5, "quote": "Kệ đĩa gọn gàng, đặt hàng nhanh, theo dõi đơn dễ dàng.", "who": "Khách hàng Bụi Records"},
    {"stars": 5, "quote": "Thông tin từng bản ép rất chi tiết, giúp mình yên tâm trước khi mua.", "who": "Người sưu tầm đĩa than"},
]


# ------------------------------------------------------------------------
# App setup
# ------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    yield


log = logging.getLogger("bui")

# API docs are not needed in production.
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

# No hardcoded fallback secret: generate a throwaway one for local/dev runs
# (sessions won't survive a restart) and warn loudly instead of silently
# using a value that could end up committed to source control.
_secret_key = os.environ.get("SECRET_KEY") or os.environ.get("FLASK_SECRET_KEY")
if not _secret_key:
    warnings.warn(
        "SECRET_KEY is not set. Using a random throwaway key for this "
        "process only -- all sessions (carts) will be invalidated on restart. "
        "Set SECRET_KEY in your .env for real use.",
        RuntimeWarning,
    )
    _secret_key = secrets.token_hex(32)

_cookie_secure = os.environ.get("COOKIE_SECURE", "0") == "1"

# Session cookie storage for the cart, signed the same way Flask's was.
# max_age=None makes it a real browser-session cookie (no Max-Age/Expires),
# matching the previous behaviour of expiring when the browser closes.
app.add_middleware(
    SessionMiddleware,
    secret_key=_secret_key,
    session_cookie="session",
    max_age=None,
    same_site="lax",
    https_only=_cookie_secure,
)

# The frontend is served by this same app (same origin), so CORS is off by default.
# Set ALLOWED_ORIGIN_REGEX only if the frontend is hosted on another origin.
_allowed_origin_regex = os.environ.get("ALLOWED_ORIGIN_REGEX", "").strip()
if _allowed_origin_regex:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=_allowed_origin_regex,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type", "X-Admin-Token"],
    )


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Keep the {"error": "..."} JSON shape the frontend expects (incl. unknown routes)."""
    detail = exc.detail if isinstance(exc.detail, str) else "Yêu cầu không hợp lệ."
    if exc.status_code == 404 and detail == "Not Found":
        detail = "Không tìm thấy"
    if exc.status_code == 405:
        detail = "Phương thức không được hỗ trợ."
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"error": "Dữ liệu gửi lên không hợp lệ."})


# ------------------------------------------------------------------------
# Small helpers
# ------------------------------------------------------------------------

def bad_request(message, status_code=400):
    raise HTTPException(status_code=status_code, detail=message)


def not_found(message="Không tìm thấy"):
    raise HTTPException(status_code=404, detail=message)


def discogs_error_response(exc):
    """Map any Discogs failure to a generic Vietnamese message; details go to the log only."""
    log.warning("Discogs error (%s): %s", getattr(exc, "status_code", None), exc)
    code = getattr(exc, "status_code", None)
    if code == 404:
        raise HTTPException(status_code=404, detail="Không tìm thấy đĩa này trên Discogs.")
    if code == 429:
        raise HTTPException(status_code=503, detail="Discogs đang giới hạn truy cập, vui lòng thử lại sau ít phút.")
    raise HTTPException(status_code=502, detail="Không kết nối được tới Discogs, vui lòng thử lại sau.")


MAX_QTY = 20          # per cart line
MAX_CART_LINES = 12   # the cart lives in a cookie (~4 KB browser limit)
MAX_ID = 2 ** 31 - 1


def check_id(value: int, what: str = "mục"):
    """Path ids must fit SQLite/Discogs; huge values would overflow and 500."""
    if not (0 < int(value) <= MAX_ID):
        raise HTTPException(status_code=404, detail=f"Không tìm thấy {what}.")
    return int(value)


def parse_release_id(value):
    """Accept int or ASCII-digit string only ('²' or Arabic digits are rejected)."""
    if isinstance(value, bool):
        bad_request("Sản phẩm không hợp lệ.")
    text = str(value)
    if not (text.isascii() and text.isdigit() and 0 < int(text) <= MAX_ID):
        bad_request("Sản phẩm không hợp lệ.")
    return int(text)


def parse_qty(value):
    if type(value) is not int or not (1 <= value <= MAX_QTY):
        bad_request(f"Số lượng phải là số nguyên từ 1 đến {MAX_QTY}.")
    return value


def text_field(payload, key, max_len, required=False, label=""):
    value = payload.get(key)
    if value is None:
        value = ""
    if not isinstance(value, str):
        bad_request("Dữ liệu gửi lên không hợp lệ.")
    value = value.strip()
    if required and not value:
        bad_request(f"Vui lòng nhập {label or key}.")
    if len(value) > max_len:
        bad_request(f"{(label or key).capitalize()} quá dài (tối đa {max_len} ký tự).")
    return value


# Tiny in-memory rate limiter for endpoints that can be probed (lookups, admin).
_rl_hits: dict = {}
_rl_lock = threading.Lock()


def rate_limit(request: Request, bucket: str, limit: int = 20, window: int = 60):
    ip = request.client.host if request.client else "?"
    key = (bucket, ip)
    now = time.time()
    with _rl_lock:
        hits = [t for t in _rl_hits.get(key, []) if now - t < window]
        if len(hits) >= limit:
            _rl_hits[key] = hits
            raise HTTPException(status_code=429, detail="Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.")
        hits.append(now)
        _rl_hits[key] = hits


@lru_cache(maxsize=256)
def cached_release(release_id):
    return discogs_client.get_release(release_id)


def local_price(release_id):
    """The shop's own price row (table release_prices) or None."""
    conn = database.get_db()
    try:
        return database.get_price(conn, release_id)
    finally:
        conn.close()


def resolve_release(release_id):
    try:
        return cached_release(int(release_id))
    except (TypeError, ValueError):
        raise discogs_client.DiscogsError("Discogs release id must be an integer", status_code=400)


# ------------------------------------------------------------------------
# SQLite connection -- orders/preorders only (per-request dependency)
# ------------------------------------------------------------------------

def get_conn():
    conn = database.get_db()
    try:
        yield conn
    finally:
        conn.close()


# ------------------------------------------------------------------------
# Frontend index -- static assets are mounted at the bottom of this file
# ------------------------------------------------------------------------

@app.get("/")
def index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if not os.path.exists(index_path):
        return PlainTextResponse(
            "index.html not found next to the backend folder. "
            "The API is still available under /api/.",
            status_code=404,
        )
    return FileResponse(index_path)


# ------------------------------------------------------------------------
# Health / Discogs catalogue
# ------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "catalogue": "discogs",
        "database": ["orders", "preorders", "release_prices"],
        "cart": "signed-session-cookie",
    }


def shop_records(filters, page, per_page):
    """
    The shop catalogue: releases that have a row in release_prices.
    Metadata (cover, tracklist, genre...) comes from Discogs (cached);
    price and stock come from the shop's own DB.
    """
    conn = database.get_db()
    try:
        rows = conn.execute(
            "SELECT discogs_release_id FROM release_prices "
            "WHERE stock_status != 'out_of_stock' OR stock_status IS NULL "
            "ORDER BY updated_at DESC, discogs_release_id"
        ).fetchall()
    finally:
        conn.close()
    ids = [r["discogs_release_id"] for r in rows]

    def load(rid):
        try:
            return discogs_client.normalize_release(cached_release(rid))
        except Exception as exc:
            # Discogs down / rate-limited: keep the product on sale using the DB
            # row alone (price and stock are the shop's own data).
            log.warning("metadata for release %s unavailable: %s", rid, exc)
            return discogs_client.normalize_release({"id": rid, "title": f"Đĩa #{rid}"})

    with ThreadPoolExecutor(max_workers=6) as pool:
        items = [i for i in pool.map(load, ids) if i]

    def has(value, needle):
        return needle.lower() in str(value or "").lower()

    def keep(i):
        f = filters
        if f.get("search"):
            hay = " ".join(str(i.get(k) or "") for k in ("title", "artist", "label", "catno")).lower()
            if not all(w in hay for w in f["search"].lower().split()):
                return False
        if f.get("label") and not any(has(x, f["label"]) for x in i.get("labels") or []):
            return False
        if f.get("artist") and not has(i.get("artist"), f["artist"]):
            return False
        if f.get("genre") and f["genre"] not in (i.get("genres") or []):
            return False
        if f.get("style") and f["style"] not in (i.get("styles") or []):
            return False
        if f.get("country") and not has(i.get("country"), f["country"]):
            return False
        if f.get("format") and not has(i.get("format"), f["format"]):
            return False
        if f.get("year") and str(i.get("year")) != str(f["year"]):
            return False
        return True

    items = [i for i in items if keep(i)]
    total = len(items)
    start = (page - 1) * per_page
    pages = max(1, -(-total // per_page))
    return items[start:start + per_page], {
        "page": page, "pages": pages, "per_page": per_page, "items": total,
    }



@app.get("/api/records")
def list_records(
    search: str = "",
    label: Optional[str] = None,
    artist: Optional[str] = None,
    genre: Optional[str] = None,
    style: Optional[str] = None,
    country: Optional[str] = None,
    format: Optional[str] = None,
    year: Optional[int] = None,
    # Kept for compatibility with old frontend calls; become page/per_page.
    limit: Optional[int] = None,
    offset: int = 0,
    per_page: Optional[int] = None,
    page: Optional[int] = None,
):
    """The shop catalogue: releases that have a row in release_prices.

    Supported query params: search, label, artist, genre, style, country,
    year, format, page, per_page. limit/offset are accepted for compatibility.
    """
    resolved_per_page = per_page or (limit or 24)
    resolved_per_page = max(1, min(100, resolved_per_page))
    resolved_page = page
    if not resolved_page:
        resolved_page = (max(0, offset) // resolved_per_page) + 1
    resolved_page = max(1, min(resolved_page, 10000))

    records, pagination = shop_records(
        {"search": search, "label": label, "artist": artist, "genre": genre,
         "style": style, "country": country, "format": format, "year": year},
        resolved_page, resolved_per_page,
    )
    return {
        "records": records,
        "total": pagination["items"],
        "pagination": pagination,
        "source": "shop",
    }


@app.get("/api/records/{record_id}")
def get_record(record_id: int):
    check_id(record_id, "đĩa")
    if not local_price(record_id):
        return not_found("Đĩa này không có trong cửa hàng.")
    try:
        return discogs_client.normalize_release(resolve_release(record_id))
    except discogs_client.DiscogsError as exc:
        return discogs_error_response(exc)


# ------------------------------------------------------------------------
# Preorders -- the only local catalogue-like data that remains in SQLite
# ------------------------------------------------------------------------

@app.get("/api/preorders")
def list_preorders(conn: sqlite3.Connection = Depends(get_conn)):
    rows = conn.execute("SELECT * FROM preorders ORDER BY id").fetchall()
    result = []
    for row in rows:
        held = min(row["total_slots"], row["held"] + row["reserved_count"])
        pct = round(100 * held / row["total_slots"]) if row["total_slots"] else 0
        cover = None
        if row["discogs_release_id"]:
            try:
                cover = discogs_client.normalize_release(
                    cached_release(int(row["discogs_release_id"]))
                ).get("cover_image")
            except Exception:
                cover = None
        result.append({
            "id": row["id"],
            "discogs_release_id": row["discogs_release_id"],
            "cover_image": cover,
            "title": row["title"],
            "artist": row["artist"],
            "ships_label": row["ships_label"],
            "held": held,
            "total_slots": row["total_slots"],
            "price": row["price"],
            "pct": pct,
            "sold_out": held >= row["total_slots"],
        })
    return result


STATUS_LABELS = {
    "pending": "Chờ xác nhận",
    "confirmed": "Đã xác nhận",
    "arrived": "Đĩa đã về",
    "cancelled": "Đã hủy",
}
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")


def reservation_payload(res):
    return {
        "code": res["code"],
        "status": res["status"],
        "status_label": STATUS_LABELS.get(res["status"], res["status"]),
        "preorder_id": res["preorder_id"],
        "title": res["title"],
        "artist": res["artist"],
        "ships_label": res["ships_label"],
        "price": res["price"],
        "name": res["name"],
        "created_at": res["created_at"],
        "updated_at": res["updated_at"],
    }


@app.post("/api/preorders/{preorder_id}/reserve", status_code=201)
def reserve_preorder(
    preorder_id: int,
    request: Request,
    payload: dict = Body(default={}),
    conn: sqlite3.Connection = Depends(get_conn),
):
    check_id(preorder_id, "đợt đặt trước")
    rate_limit(request, "reserve", limit=10, window=60)
    name = text_field(payload, "name", 120, required=True, label="họ tên")
    phone = database.normalize_phone(payload.get("phone") if isinstance(payload.get("phone"), (str, int)) else "")
    if not phone:
        return bad_request("Số điện thoại chưa đúng (ví dụ 0912345678).")
    try:
        res = database.create_reservation(conn, preorder_id, name, phone)
    except ValueError as exc:
        return bad_request(str(exc), status_code=409)
    data = reservation_payload(res)
    data["message"] = f"Đã ghi nhận giữ chỗ — mã {res['code']}. Bụi sẽ liên hệ để xác nhận."
    return data


@app.post("/api/reservations/lookup")
def lookup_reservation(
    request: Request,
    payload: dict = Body(default={}),
    conn: sqlite3.Connection = Depends(get_conn),
):
    """POST (not GET) so the phone number never appears in URLs / access logs."""
    rate_limit(request, "lookup", limit=20, window=60)
    code = text_field(payload, "code", 20)
    phone = payload.get("phone") if isinstance(payload.get("phone"), (str, int)) else ""
    res = database.get_reservation(conn, code)
    # Same answer for "no such code" and "wrong phone" so codes can't be probed.
    if not res or database.normalize_phone(phone) != res["phone"]:
        return not_found("Không tìm thấy giữ chỗ với mã và số điện thoại này.")
    return reservation_payload(res)


@app.put("/api/admin/reservations/{code}")
def admin_set_reservation(
    code: str,
    request: Request,
    payload: dict = Body(default={}),
    conn: sqlite3.Connection = Depends(get_conn),
):
    rate_limit(request, "admin", limit=30, window=60)
    token = request.headers.get("x-admin-token", "")
    if not ADMIN_TOKEN or not secrets.compare_digest(token.encode("utf-8"), ADMIN_TOKEN.encode("utf-8")):
        return JSONResponse(status_code=403, content={"error": "Không có quyền."})
    try:
        res = database.set_reservation_status(conn, code, payload.get("status"))
    except ValueError as exc:
        return bad_request(str(exc))
    return reservation_payload(res)


# ------------------------------------------------------------------------
# Non-persistent informational endpoints
# ------------------------------------------------------------------------

@app.get("/api/reviews")
def list_reviews():
    return SITE_REVIEWS


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")


@app.post("/api/newsletter")
def subscribe_newsletter(payload: dict = Body(default={})):
    email = text_field(payload, "email", 254).lower()
    if not _EMAIL_RE.match(email):
        return bad_request("Vui lòng nhập email hợp lệ.")
    # Deliberately not stored in SQLite.
    return {"message": "Đã đăng ký — thư đầu tiên sẽ tới vào sáng thứ Năm"}


# ------------------------------------------------------------------------
# Cart -- stored in the signed session cookie, never in SQLite
# ------------------------------------------------------------------------

def cart_items(request: Request):
    return request.session.setdefault("cart", [])


def set_cart(request: Request, items):
    request.session["cart"] = items


def _line_price(item, qty):
    """
    Current price + availability of one cart line.
    Returns (unit_price, currency, problem_or_None). Shop rows are read live
    from the DB, so price/stock edits apply immediately.
    """
    rid = int(item["item_id"])
    shop = local_price(rid)
    if shop:
        if shop["stock_status"] == "out_of_stock" or shop.get("stock") == 0:
            return None, None, "Đĩa này đã hết hàng."
        if shop.get("price") is None:
            return None, None, "Đĩa này chưa có giá, vui lòng liên hệ cửa hàng."
        if shop.get("stock") is not None and qty > shop["stock"]:
            return None, None, f"Chỉ còn {shop['stock']} bản."
        return int(shop["price"]), shop.get("currency") or "VND", None
    return None, None, "Đĩa này không có trong cửa hàng."


def cart_payload(request: Request):
    items = []
    for raw in cart_items(request):
        unit, currency, problem = _line_price(raw, raw["qty"])
        if unit is None:
            unit, currency = raw["unit_price"], raw.get("price_currency")  # show last known price
        line = {**raw, "unit_price": unit, "price_currency": currency}
        line["line_total"] = unit * raw["qty"]
        if problem:
            line["problem"] = problem
        items.append(line)
    subtotal = sum(item["line_total"] for item in items)
    count = sum(item["qty"] for item in items)
    return {"items": items, "subtotal": subtotal, "count": count}


def compute_shipping_fee(shipping_method, subtotal):
    if shipping_method == "express":
        return SHIPPING_EXPRESS_FEE
    return 0 if subtotal >= FREE_SHIPPING_THRESHOLD else SHIPPING_STANDARD_FEE


@app.get("/api/cart")
def view_cart(request: Request):
    return cart_payload(request)


@app.post("/api/cart/items")
def add_cart_item(request: Request, payload: dict = Body(default={})):
    item_type = payload.get("item_type", "record")
    if item_type != "record":
        return bad_request("Sản phẩm không hợp lệ.")
    release_id = parse_release_id(payload.get("item_id"))
    qty = parse_qty(payload.get("qty", 1))

    items = cart_items(request)
    existing = next((x for x in items if x["item_id"] == str(release_id)), None)
    new_qty = qty + (existing["qty"] if existing else 0)
    if new_qty > MAX_QTY:
        return bad_request(f"Mỗi đĩa chỉ đặt tối đa {MAX_QTY} bản.", status_code=409)
    if not existing and len(items) >= MAX_CART_LINES:
        return bad_request("Giỏ hàng đã đầy, vui lòng thanh toán trước khi thêm đĩa mới.", status_code=409)

    try:
        release = resolve_release(release_id)
        product = discogs_client.normalize_release(release)
    except discogs_client.DiscogsError as exc:
        return discogs_error_response(exc)

    unit_price, currency, problem = _line_price({"item_id": str(release_id)}, new_qty)
    if unit_price is None:
        return bad_request(problem, status_code=409)

    if existing:
        existing["qty"] = new_qty
        existing["unit_price"] = unit_price
        existing["price_currency"] = currency
    else:
        # Keep the cookie small: only what the cart drawer needs.
        items.append({
            "item_id": str(release_id),
            "item_type": "record",
            "title": (product["title"] or "")[:60],
            "artist": (product["artist"] or "")[:40],
            "unit_price": unit_price,
            "price_currency": currency,
            "qty": qty,
        })
    set_cart(request, items)
    return cart_payload(request)


@app.put("/api/cart/items/{item_id}")
def set_cart_item_qty(item_id: str, request: Request, payload: dict = Body(default={})):
    qty = parse_qty(payload.get("qty"))
    items = cart_items(request)
    for item in items:
        if item["item_id"] == str(item_id):
            _, _, problem = _line_price(item, qty)
            if problem and "Chỉ còn" in problem:
                return bad_request(problem, status_code=409)
            item["qty"] = qty
            set_cart(request, items)
            return cart_payload(request)
    return not_found("Sản phẩm không có trong giỏ hàng")


@app.delete("/api/cart/items/{item_id}")
def remove_cart_item(item_id: str, request: Request):
    items = [item for item in cart_items(request) if item["item_id"] != str(item_id)]
    set_cart(request, items)
    return cart_payload(request)


@app.delete("/api/cart")
def clear_cart(request: Request):
    request.session.pop("cart", None)
    return cart_payload(request)


# ------------------------------------------------------------------------
# Checkout -- the order is the only cart snapshot persisted in SQLite
# ------------------------------------------------------------------------

_ORDER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_order_no(conn):
    for _ in range(20):
        candidate = "BUI-" + "".join(secrets.choice(_ORDER_ALPHABET) for _ in range(8))
        if not conn.execute("SELECT 1 FROM orders WHERE order_no = ?", (candidate,)).fetchone():
            return candidate
    return f"BUI-{secrets.token_hex(6).upper()}"


@app.post("/api/checkout", status_code=201)
def checkout(request: Request, payload: dict = Body(default={}), conn: sqlite3.Connection = Depends(get_conn)):
    name = text_field(payload, "name", 120, required=True, label="họ tên")
    address = text_field(payload, "address", 300, required=True, label="địa chỉ nhận hàng")
    city = text_field(payload, "city", 100)
    note = text_field(payload, "note", 500)
    raw_phone = payload.get("phone")
    phone = database.normalize_phone(raw_phone if isinstance(raw_phone, (str, int)) and not isinstance(raw_phone, bool) else "")
    if not phone:
        return bad_request("Số điện thoại chưa đúng (ví dụ 0912345678).")
    shipping_method = payload.get("shipping", "standard")
    payment_method = payload.get("payment", "cod")
    if not isinstance(shipping_method, str) or shipping_method not in ("standard", "express"):
        return bad_request("Phương thức vận chuyển không hợp lệ.")
    if not isinstance(payment_method, str) or payment_method not in PAYMENT_LABELS:
        return bad_request("Phương thức thanh toán không hợp lệ.")

    items = cart_items(request)
    if not items:
        return bad_request("Giỏ hàng đang trống.")

    # Everything below runs in one write transaction: prices are re-read from the
    # DB (never trusted from the cookie) and stock is checked + decremented atomically.
    conn.execute("BEGIN IMMEDIATE")
    try:
        priced = []
        for item in items:
            qty = parse_qty(item.get("qty"))
            unit, currency, problem = _line_price(item, qty)
            if unit is None:
                raise HTTPException(status_code=409, detail=f"{item.get('title', 'Đĩa')}: {problem}")
            priced.append((item, qty, unit))

        subtotal = sum(unit * qty for _, qty, unit in priced)
        shipping_fee = compute_shipping_fee(shipping_method, subtotal)
        total = subtotal + shipping_fee

        order_no = generate_order_no(conn)
        cur = conn.execute(
            """
            INSERT INTO orders
                (order_no, name, phone, address, city, note, shipping_method,
                 shipping_fee, payment_method, subtotal, total)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (order_no, name, phone, address, city, note, shipping_method,
             shipping_fee, payment_method, subtotal, total),
        )
        order_id = cur.lastrowid

        for item, qty, unit in priced:
            conn.execute(
                """
                INSERT INTO order_items
                    (order_id, item_id, item_type, title, artist, unit_price, qty)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (order_id, item["item_id"], item["item_type"], item["title"], item.get("artist"), unit, qty),
            )
            # Decrement shop stock (only rows that track a stock number).
            res = conn.execute(
                "UPDATE release_prices SET stock = stock - ?, "
                "stock_status = CASE WHEN stock - ? <= 0 THEN 'out_of_stock' ELSE stock_status END, "
                "updated_at = CURRENT_TIMESTAMP "
                "WHERE discogs_release_id = ? AND stock IS NOT NULL AND stock >= ?",
                (qty, qty, int(item["item_id"]), qty),
            )
            tracked = conn.execute(
                "SELECT 1 FROM release_prices WHERE discogs_release_id = ? AND stock IS NOT NULL",
                (int(item["item_id"]),),
            ).fetchone()
            if tracked and res.rowcount == 0:
                raise HTTPException(status_code=409, detail=f"{item['title']}: không đủ hàng.")
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    request.session.pop("cart", None)
    return order_payload(conn, order_no)


def order_payload(conn, order_no):
    order = conn.execute(
        "SELECT * FROM orders WHERE order_no = ?", (order_no,)
    ).fetchone()
    items = conn.execute(
        """
        SELECT item_id, item_type, title, artist, unit_price, qty
        FROM order_items
        WHERE order_id = ?
        ORDER BY id
        """,
        (order["id"],),
    ).fetchall()

    return {
        "order_no": order["order_no"],
        "name": order["name"],
        "phone": order["phone"],
        "address": order["address"],
        "city": order["city"],
        "note": order["note"],
        "shipping_method": order["shipping_method"],
        "shipping_fee": order["shipping_fee"],
        "payment_method": order["payment_method"],
        "payment_label": PAYMENT_LABELS[order["payment_method"]],
        "subtotal": order["subtotal"],
        "total": order["total"],
        "status": order["status"],
        "created_at": order["created_at"],
        "items": [
            {
                "item_id": item["item_id"],
                "item_type": item["item_type"],
                "title": item["title"],
                "artist": item["artist"],
                "unit_price": item["unit_price"],
                "qty": item["qty"],
                "line_total": item["unit_price"] * item["qty"],
            }
            for item in items
        ],
    }


# ------------------------------------------------------------------------
# Static frontend -- mounted last so it only catches what /api/* didn't
# ------------------------------------------------------------------------

if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=5000, reload=os.environ.get("DEV_RELOAD") == "1")

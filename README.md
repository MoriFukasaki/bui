# Bụi Records

Vinyl shop website (Vietnamese UI). FastAPI backend + SQLite + vanilla-JS frontend.

## Data ownership

- **Discogs API:** release metadata only (cover, tracklist, genre, label) for the products in the shop. It is never used for prices.
- **SQLite (`backend/bui_records.db`):**
  - `release_prices` — the shop catalogue: which Discogs releases are for sale, VND price, stock status, stock.
  - `preorders` — preorder pressings (title, slots, price, optional `discogs_release_id` for the cover).
  - `preorder_reservations` — "giữ chỗ" with code (`GC-XXXXXX`), name, phone, status (`pending → confirmed → arrived`, or `cancelled`).
  - `orders`, `order_items` — checkout results.
- **Signed session cookie:** shopping cart only.

The **Sản phẩm** tab shows only releases that have a `release_prices` row; only those can be added to the cart.

## Environment (`.env` in the project root)

```text
DISCOGS_TOKEN=your_personal_token          # or DISCOGS_CONSUMER_KEY + DISCOGS_CONSUMER_SECRET
DISCOGS_USER_AGENT=BuiRecordsApp/2.0 (+https://your-site.example)
SECRET_KEY=replace-with-a-long-random-secret   # (FLASK_SECRET_KEY still accepted)
ADMIN_TOKEN=long-random-token              # enables the admin reservation-status endpoint
COOKIE_SECURE=1                            # set to 1 when served over HTTPS
ALLOWED_ORIGIN_REGEX=                      # optional; only needed if the frontend is on another origin
DEV_RELOAD=0                               # 1 = uvicorn auto-reload for development
```

## Run

```text
cd backend
pip install -r requirements.txt
python app.py        # http://127.0.0.1:5000  (serves ../frontend)
```

## Manage the shop (CLI)

```text
python database.py set-price <discogs_id> <price> [status]   # add/update a product
python database.py import-prices prices.csv                  # bulk import
python database.py list-prices
python database.py list-reservations
python database.py set-reservation <code> <pending|confirmed|arrived|cancelled>
```

Reservation lookup is a POST (so phone numbers stay out of URLs/logs): `POST /api/reservations/lookup` `{code, phone}`.

Admin API (same effect): `PUT /api/admin/reservations/<code>` with header `X-Admin-Token` and body `{"status": "confirmed"}`.

## Before launch

The browser can never set a price: the shop price comes from `release_prices` and is re-checked at checkout together with stock.

Replace placeholder data: seeded prices/stock in `release_prices`, the demo `preorders`, the Phụ kiện mock data (hard-coded in `frontend/script.js`), and the address/hours on the visit page.

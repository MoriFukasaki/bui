"""
Small Discogs API client.

Discogs is the source of truth for catalogue/release metadata.
Uses Consumer Key & Consumer Secret loaded from environment variables or .env file.
"""

from __future__ import annotations

import os
from typing import Any

import requests
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

API_BASE = "https://api.discogs.com"
USER_AGENT = os.environ.get(
    "DISCOGS_USER_AGENT",
    "BuiRecordsApp/2.0 (+https://www.discogs.com/developers/)",
)
# No hardcoded fallback secrets: credentials must come from the environment.
CONSUMER_KEY = os.environ.get("DISCOGS_CONSUMER_KEY")
CONSUMER_SECRET = os.environ.get("DISCOGS_CONSUMER_SECRET")
# Optional alternative: a Discogs personal access token instead of key+secret.
TOKEN = os.environ.get("DISCOGS_TOKEN")

# Reusable HTTP session for connection pooling
session = requests.Session()


class DiscogsError(Exception):
    """Error raised when a Discogs request fails."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _headers() -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if TOKEN:
        headers["Authorization"] = f"Discogs token={TOKEN}"
    elif CONSUMER_KEY and CONSUMER_SECRET:
        headers["Authorization"] = f"Discogs key={CONSUMER_KEY}, secret={CONSUMER_SECRET}"
    return headers


def _get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        response = session.get(
            API_BASE + path,
            headers=_headers(),
            params=params,
            timeout=15,
        )
    except requests.RequestException as exc:
        raise DiscogsError(f"Could not reach Discogs: {exc}") from exc

    if response.status_code == 401:
        raise DiscogsError(
            "Discogs authentication failed. Check DISCOGS_CONSUMER_KEY and DISCOGS_CONSUMER_SECRET.",
            status_code=401,
        )
    if response.status_code == 403:
        raise DiscogsError(
            "Discogs rejected the request. Check your User-Agent or API credentials.",
            status_code=403,
        )
    if response.status_code == 404:
        raise DiscogsError("Not found on Discogs", status_code=404)
    if response.status_code == 429:
        raise DiscogsError(
            "Discogs rate limit hit. Reduce request frequency.",
            status_code=429,
        )
    if not response.ok:
        raise DiscogsError(
            f"Discogs API error {response.status_code}: {response.text[:300]}",
            status_code=response.status_code,
        )

    try:
        return response.json()
    except ValueError as exc:
        raise DiscogsError("Discogs returned invalid JSON") from exc


def get_release(release_id: int | str) -> dict[str, Any]:
    return _get(f"/releases/{int(release_id)}")


def _first(value: Any) -> Any:
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _names(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        item.get("name")
        for item in value
        if isinstance(item, dict) and item.get("name")
    ]


def _apply_local_price(item: dict[str, Any]) -> dict[str, Any]:
    """
    Overlay the shop's own price (table release_prices, in VND) on a
    normalized item. Fails soft: if the DB is unavailable the item is
    returned unchanged.
    """
    release_id = item.get("id")
    if not release_id:
        return item
    try:
        import database

        conn = database.get_db()
        try:
            row = database.get_price(conn, release_id)
        finally:
            conn.close()
    except Exception:
        return item
    if not row:
        return item
    if row.get("price") is not None:
        item["price"] = row["price"]
        item["price_currency"] = row["currency"]
    item["stock_status"] = row["stock_status"]
    if row.get("stock") is not None:
        item["stock"] = row["stock"]
    return item


def normalize_release(
    release: dict[str, Any],
    *,
    price: int | float | None = None,
    price_currency: str | None = None,
    availability: int | None = None,
) -> dict[str, Any]:
    labels = _names(release.get("labels"))
    genres = release.get("genres") or []
    styles = release.get("styles") or []
    formats = release.get("formats") or []
    artists = _names(release.get("artists"))
    artist = ", ".join(artists) if artists else release.get("artist", "")
    genre = genres[0] if genres else None
    format_names = [
        item.get("name")
        for item in formats
        if isinstance(item, dict) and item.get("name")
    ]
    cover_image = None
    if isinstance(release.get("images"), list) and release["images"]:
        cover_image = release["images"][0].get("uri")
    thumb = release.get("thumb") or cover_image
    catnos = [x.get("catno") for x in release.get("labels", []) if isinstance(x, dict)]

    return _apply_local_price({
        "id": release.get("id"),
        "title": release.get("title"),
        "artist": artist,
        "artists": artists,
        "year": release.get("year"),
        "genre": genre,
        "genres": genres,
        "style": styles[0] if styles else None,
        "styles": styles,
        "shelf": None,
        "price": price,
        "price_currency": price_currency,
        "grade": None,
        "format": ", ".join(format_names) or None,
        "formats": formats,
        "stock": availability,
        "swatch": cover_image,
        "cover_image": cover_image,
        "thumb": thumb,
        "note": None,
        "labels": labels,
        "label": _first(labels),
        "catno": _first(catnos),
        "country": release.get("country"),
        "released": release.get("released"),
        "release_date": release.get("released_formatted"),
        "uri": release.get("uri"),
        "resource_url": release.get("resource_url"),
        "master_id": release.get("master_id"),
        "master_url": release.get("master_url"),
        "community": release.get("community") or {},
        "data_quality": release.get("data_quality"),
        "notes": release.get("notes"),
        "tracklist": release.get("tracklist") or [],
    })


if __name__ == "__main__":
    import json
    import sys

    release_id = int(sys.argv[1]) if len(sys.argv) > 1 else 249504
    try:
        data = get_release(release_id)
        print(json.dumps(data, indent=2, ensure_ascii=False))
    except DiscogsError as exc:
        print(f"Error ({exc.status_code}): {exc}")
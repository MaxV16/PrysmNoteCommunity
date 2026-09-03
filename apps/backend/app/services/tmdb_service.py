"""Async TMDB API v3 client for the Shows & Movies watchlist.

Every method is fail-soft: an empty ``TMDB_API_KEY``, a network error, a rate
limit, or a 404 all return ``None``/``[]`` and log, never raise. The watchlist
must degrade to manual entries whenever TMDB is unavailable.
"""

import logging
from datetime import date

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500"
REQUEST_TIMEOUT = 10.0


def has_key() -> bool:
    return bool(settings.tmdb_api_key)


def poster_url(poster_path: str | None) -> str | None:
    if not poster_path:
        return None
    return f"{TMDB_IMAGE_BASE}{poster_path}"


def _extract_year(date_str: str | None) -> int | None:
    if not date_str:
        return None
    try:
        return int(date_str[:4])
    except (ValueError, TypeError):
        return None


async def _get(path: str, params: dict | None = None) -> dict | None:
    """One-off async GET. Never raises; returns None on any failure."""
    if not has_key():
        return None
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.get(
                f"{TMDB_BASE}{path}",
                params=params,
                headers={"Authorization": f"Bearer {settings.tmdb_api_key}", "accept": "application/json"},
            )
            if resp.status_code != 200:
                logger.warning("TMDB %s returned %s", path, resp.status_code)
                return None
            return resp.json()
    except Exception:
        logger.exception("TMDB request failed for %s", path)
        return None


async def search_multi(query: str) -> list[dict]:
    """Multi-search (movies + TV) mapped to the watchlist result shape."""
    if not query.strip():
        return []
    data = await _get("/search/multi", {"query": query.strip(), "language": "en-US"})
    if not data:
        return []
    results: list[dict] = []
    for r in data.get("results", []):
        if r.get("media_type") not in ("movie", "tv"):
            continue
        results.append(
            {
                "tmdb_id": r["id"],
                "media_type": r["media_type"],
                "title": r.get("title") or r.get("name") or "Untitled",
                "release_year": _extract_year(r.get("release_date") or r.get("first_air_date")),
                "poster_path": r.get("poster_path"),
            }
        )
    return results


async def movie_details(tmdb_id: int) -> dict | None:
    return await _get(
        f"/movie/{tmdb_id}",
        {"language": "en-US", "append_to_response": "belongs_to_collection"},
    )


async def tv_details(tmdb_id: int) -> dict | None:
    return await _get(
        f"/tv/{tmdb_id}",
        {"language": "en-US", "append_to_response": "next_episode_to_air"},
    )


async def collection(tmdb_id: int) -> list[dict]:
    """Parts of a movie collection (each with release_date/title/name)."""
    data = await _get(f"/collection/{tmdb_id}", {"language": "en-US"})
    if not data:
        return []
    return data.get("parts", [])


async def watch_providers(tmdb_id: int, media_type: str, region: str) -> dict | None:
    """Watch providers for a movie/tv in a region, normalized to flat/buy/rent/free.

    Returns None when TMDB is unreachable or the region has no provider data, so
    the caller can fall back to its cached value.
    """
    data = await _get(f"/{media_type}/{tmdb_id}/watch/providers", {"language": "en-US"})
    if not data:
        return None
    region_data = (data.get("results") or {}).get(region)
    return _map_provider_links(region_data)


async def has_theatrical_release(tmdb_id: int) -> bool:
    """True when any region lists a Theatrical (2) / Theatrical limited (3) release."""
    if not has_key():
        return False
    data = await _get(f"/movie/{tmdb_id}/release_dates", {"language": "en-US"})
    if not data:
        return False
    for region in data.get("results", []):
        for rd in region.get("release_dates", []):
            if rd.get("release_type") in (2, 3):
                return True
    return False


def _map_provider_links(region_data: dict | None) -> dict | None:
    if not region_data:
        return None
    links: dict[str, list[dict]] = {}
    for key in ("flatrate", "buy", "rent", "free"):
        providers = region_data.get(key) or []
        links[key] = [
            {
                "id": p.get("provider_id"),
                "name": p.get("provider_name"),
                "logo_path": p.get("logo_path"),
                "display_priority": p.get("display_priority"),
                "link": p.get("link"),
            }
            for p in providers
        ]
    return links


async def compute_upcoming(tmdb_id: int, media_type: str) -> list[dict]:
    """Upcoming continuations for an item: next season airing (tv) or next
    franchise installment (movie). Only entries with a future date qualify."""
    if not has_key():
        return []
    today = date.today()
    try:
        if media_type == "tv":
            details = await tv_details(tmdb_id)
            if not details:
                return []
            next_ep = details.get("next_episode_to_air")
            air_date = _parse_date(next_ep.get("air_date") if next_ep else None)
            if not next_ep or air_date is None or air_date <= today:
                return []
            season = next_ep.get("season_number")
            label = f"Season {season} airs" if season else "New episode airs"
            return [{"label": label, "date": next_ep["air_date"], "extra": next_ep.get("name")}]

        details = await movie_details(tmdb_id)
        if not details:
            return []
        belongs = details.get("belongs_to_collection")
        if not belongs:
            return []
        parts = await collection(belongs["id"])
        upcoming = []
        for part in parts:
            if part.get("id") == tmdb_id:
                continue
            release_date = _parse_date(part.get("release_date") or part.get("first_air_date"))
            if release_date is None or release_date <= today:
                continue
            part_title = part.get("title") or part.get("name") or "Untitled"
            upcoming.append(
                {
                    "label": f"Next installment '{part_title}' releases",
                    "date": (part.get("release_date") or part.get("first_air_date"))[:10],
                    "extra": part_title,
                }
            )
        return upcoming
    except Exception:
        logger.exception("compute_upcoming failed for %s %s", media_type, tmdb_id)
        return []


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except (ValueError, TypeError):
        return None

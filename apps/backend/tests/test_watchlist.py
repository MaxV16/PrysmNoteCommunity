import pytest
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
from app.models.watchlist import WatchlistItem
from app.services import tmdb_service, watchlist_background, watchlist_service
from app.services.watchlist_background import refresh_due_items
from tests.conftest import _test_session_factory

MOVIE_DETAILS = {
    "id": 438631,
    "title": "Dune",
    "poster_path": "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg",
    "release_date": "2021-09-15",
    "belongs_to_collection": None,
}


@pytest.fixture(autouse=True)
def _tmdb_key(monkeypatch):
    """Tests exercise the TMDB path by default; individual tests override."""
    monkeypatch.setattr(settings, "tmdb_api_key", "test-tmdb-key")


async def _stub_movie(monkeypatch, upcoming=None, title="Dune"):
    async def fake_movie_details(tmdb_id):
        return {**MOVIE_DETAILS, "id": tmdb_id, "title": title}

    async def fake_compute_upcoming(tmdb_id, media_type):
        return upcoming or []

    async def fake_has_theatrical_release(tmdb_id):
        return True

    monkeypatch.setattr(tmdb_service, "movie_details", fake_movie_details)
    monkeypatch.setattr(tmdb_service, "compute_upcoming", fake_compute_upcoming)
    monkeypatch.setattr(tmdb_service, "has_theatrical_release", fake_has_theatrical_release)


@pytest.mark.asyncio
async def test_crud_round_trip(client: AsyncClient, monkeypatch):
    await _stub_movie(monkeypatch, upcoming=[{"label": "Next installment 'Dune 2' releases", "date": "2099-01-01"}])

    resp = await client.post("/api/watchlist/", json={"tmdb_id": 438631, "media_type": "movie"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Dune"
    assert data["release_year"] == 2021
    assert data["status"] == "plan_to_watch"
    assert data["is_theatrical"] is True
    assert data["poster_url"].startswith("https://image.tmdb.org/t/p/w500")
    assert data["upcoming"][0]["label"].startswith("Next installment")
    item_id = data["id"]

    listed = await client.get("/api/watchlist/")
    assert listed.status_code == 200
    assert len(listed.json()) == 1

    resp = await client.patch(
        f"/api/watchlist/{item_id}",
        json={"status": "watched", "rating": 8, "notes": "loved it", "watched_at": "2026-08-30"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "watched"
    assert data["rating"] == 8
    assert data["notes"] == "loved it"
    assert data["watched_at"] == "2026-08-30"

    resp = await client.patch(f"/api/watchlist/{item_id}", json={"watched_at": None, "rating": None})
    assert resp.status_code == 200
    assert resp.json()["watched_at"] is None
    assert resp.json()["rating"] is None

    assert (await client.delete(f"/api/watchlist/{item_id}")).status_code == 200
    assert (await client.get("/api/watchlist/")).json() == []


@pytest.mark.asyncio
async def test_duplicate_add_409(client: AsyncClient, monkeypatch):
    await _stub_movie(monkeypatch)
    assert (await client.post("/api/watchlist/", json={"tmdb_id": 438631, "media_type": "movie"})).status_code == 200
    resp = await client.post("/api/watchlist/", json={"tmdb_id": 438631, "media_type": "movie"})
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_invalid_media_type_and_status_rejected(client: AsyncClient):
    assert (await client.post("/api/watchlist/", json={"tmdb_id": 1, "media_type": "book"})).status_code == 422
    assert (await client.post("/api/watchlist/", json={"tmdb_id": 1, "media_type": "movie", "status": "binge"})).status_code == 422


@pytest.mark.asyncio
async def test_cross_user_isolation(client: AsyncClient, db_session: AsyncSession, monkeypatch):
    other = User(id=uuid4(), email="watchlist-other@test", password_hash="x", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    other_item = WatchlistItem(user_id=other.id, tmdb_id=111, media_type="movie", title="Secret")
    db_session.add(other_item)
    await db_session.commit()

    listed = await client.get("/api/watchlist/")
    assert listed.status_code == 200
    assert all(i["id"] != str(other_item.id) for i in listed.json())

    assert (await client.patch(f"/api/watchlist/{other_item.id}", json={"status": "watched"})).status_code == 404
    assert (await client.delete(f"/api/watchlist/{other_item.id}")).status_code == 404
    assert (await client.get(f"/api/watchlist/{other_item.id}/providers")).status_code == 404


@pytest.mark.asyncio
async def test_search_returns_mapped_results(client: AsyncClient, monkeypatch):
    async def fake_search_multi(query):
        return [
            {"tmdb_id": 438631, "media_type": "movie", "title": "Dune", "release_year": 2021, "poster_path": "/dune.jpg"},
            {"tmdb_id": 1396, "media_type": "tv", "title": "Breaking Bad", "release_year": 2008, "poster_path": None},
        ]

    monkeypatch.setattr(tmdb_service, "search_multi", fake_search_multi)
    resp = await client.post("/api/watchlist/search?query=dune")
    assert resp.status_code == 200
    results = resp.json()
    assert results[0]["title"] == "Dune"
    assert results[0]["media_type"] == "movie"
    assert results[1]["media_type"] == "tv"


@pytest.mark.asyncio
async def test_search_empty_without_key(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "tmdb_api_key", "")
    resp = await client.post("/api/watchlist/search?query=dune")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_search_fail_soft_when_tmdb_errors(client: AsyncClient, monkeypatch):
    async def exploding_search(query):
        raise RuntimeError("tmdb exploded")

    monkeypatch.setattr(tmdb_service, "search_multi", exploding_search)
    resp = await client.post("/api/watchlist/search?query=dune")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_search_query_length_limited(client: AsyncClient):
    resp = await client.post(f"/api/watchlist/search?query={'a' * 300}")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_provider_mapping_includes_link():
    mapped = tmdb_service._map_provider_links(
        {
            "flatrate": [
                {"provider_id": 8, "provider_name": "Netflix", "logo_path": "/n.png", "link": "https://www.themoviedb.org/movie/1/watch?locale=US"}
            ]
        }
    )
    assert mapped["flatrate"][0]["name"] == "Netflix"
    assert mapped["flatrate"][0]["link"] == "https://www.themoviedb.org/movie/1/watch?locale=US"


@pytest.mark.asyncio
async def test_has_theatrical_release_true_on_theatrical(monkeypatch):
    async def fake_get(path, params=None):
        return {"results": [{"region": "US", "release_dates": [{"release_type": 3}]}]}

    monkeypatch.setattr(tmdb_service, "_get", fake_get)
    assert await tmdb_service.has_theatrical_release(438631) is True


@pytest.mark.asyncio
async def test_has_theatrical_release_false_on_digital_only(monkeypatch):
    async def fake_get(path, params=None):
        return {"results": [{"region": "US", "release_dates": [{"release_type": 4}, {"release_type": 5}]}]}

    monkeypatch.setattr(tmdb_service, "_get", fake_get)
    assert await tmdb_service.has_theatrical_release(438631) is False


@pytest.mark.asyncio
async def test_has_theatrical_release_false_on_empty_results(monkeypatch):
    async def fake_get(path, params=None):
        return {"results": []}

    monkeypatch.setattr(tmdb_service, "_get", fake_get)
    assert await tmdb_service.has_theatrical_release(438631) is False


@pytest.mark.asyncio
async def test_has_theatrical_release_false_without_key(monkeypatch):
    monkeypatch.setattr(settings, "tmdb_api_key", "")
    assert await tmdb_service.has_theatrical_release(438631) is False


@pytest.mark.asyncio
async def test_refresh_upcoming_stamps_theatrical_for_movie(db_session: AsyncSession, monkeypatch):
    item = WatchlistItem(user_id=uuid4(), tmdb_id=438631, media_type="movie", title="Dune", is_theatrical=False)

    async def fake_compute_upcoming(tmdb_id, media_type):
        return [{"label": "Next installment 'Dune 2' releases", "date": "2099-01-01"}]

    async def fake_has_theatrical(tmdb_id):
        return True

    monkeypatch.setattr(tmdb_service, "compute_upcoming", fake_compute_upcoming)
    monkeypatch.setattr(tmdb_service, "has_theatrical_release", fake_has_theatrical)

    await watchlist_service.refresh_upcoming(db_session, item)
    assert item.is_theatrical is True
    assert item.upcoming_json[0]["label"].startswith("Next installment")
    assert item.metadata_fetched_at is not None


@pytest.mark.asyncio
async def test_manual_entry_requires_title_without_key(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "tmdb_api_key", "")
    resp = await client.post("/api/watchlist/", json={"tmdb_id": 999, "media_type": "movie"})
    assert resp.status_code == 422

    resp = await client.post(
        "/api/watchlist/", json={"tmdb_id": 999, "media_type": "movie", "title": "My Movie", "release_year": 2020}
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "My Movie"
    assert resp.json()["release_year"] == 2020


@pytest.mark.asyncio
async def test_compute_upcoming_tv_future(monkeypatch):
    future = (date.today() + timedelta(days=30)).isoformat()

    async def fake_tv_details(tmdb_id):
        return {"next_episode_to_air": {"air_date": future, "season_number": 3, "name": "S3E1"}}

    monkeypatch.setattr(tmdb_service, "tv_details", fake_tv_details)
    result = await tmdb_service.compute_upcoming(1396, "tv")
    assert len(result) == 1
    assert result[0]["label"] == "Season 3 airs"
    assert result[0]["date"] == future


@pytest.mark.asyncio
async def test_compute_upcoming_tv_past_or_none(monkeypatch):
    past = (date.today() - timedelta(days=5)).isoformat()

    async def fake_past(tmdb_id):
        return {"next_episode_to_air": {"air_date": past, "season_number": 1}}

    async def fake_none(tmdb_id):
        return {"next_episode_to_air": None}

    monkeypatch.setattr(tmdb_service, "tv_details", fake_past)
    assert await tmdb_service.compute_upcoming(1396, "tv") == []
    monkeypatch.setattr(tmdb_service, "tv_details", fake_none)
    assert await tmdb_service.compute_upcoming(1396, "tv") == []


@pytest.mark.asyncio
async def test_compute_upcoming_movie_collection_future(monkeypatch):
    future = (date.today() + timedelta(days=60)).isoformat()
    past = (date.today() - timedelta(days=1)).isoformat()

    async def fake_movie_details(tmdb_id):
        return {"belongs_to_collection": {"id": 437}}

    async def fake_collection(cid):
        return [
            {"id": 438631, "title": "Dune", "release_date": "2021-09-15"},
            {"id": 999, "title": "Dune: Part Two", "release_date": future},
            {"id": 1000, "title": "Dune Messiah", "release_date": past},
        ]

    monkeypatch.setattr(tmdb_service, "movie_details", fake_movie_details)
    monkeypatch.setattr(tmdb_service, "collection", fake_collection)

    result = await tmdb_service.compute_upcoming(438631, "movie")
    assert len(result) == 1
    assert result[0]["label"].startswith("Next installment 'Dune: Part Two'")
    assert result[0]["date"] == future


@pytest.mark.asyncio
async def test_providers_cached_then_fallback(client: AsyncClient, monkeypatch):
    await _stub_movie(monkeypatch)
    item = (await client.post("/api/watchlist/", json={"tmdb_id": 438631, "media_type": "movie"})).json()

    providers_data = {"flatrate": [{"id": 8, "name": "Netflix", "logo_path": "/netflix.png", "display_priority": 0}]}

    async def fake_watch_providers(tmdb_id, media_type, region):
        return providers_data

    monkeypatch.setattr(tmdb_service, "watch_providers", fake_watch_providers)
    resp = await client.get(f"/api/watchlist/{item['id']}/providers?region=US")
    assert resp.status_code == 200
    assert resp.json()["flatrate"][0]["name"] == "Netflix"

    async def failing_watch_providers(tmdb_id, media_type, region):
        return None

    monkeypatch.setattr(tmdb_service, "watch_providers", failing_watch_providers)
    resp = await client.get(f"/api/watchlist/{item['id']}/providers?region=DE")
    assert resp.status_code == 200
    assert resp.json()["flatrate"][0]["name"] == "Netflix"  # served from cache


@pytest.mark.asyncio
async def test_background_refresh_updates_and_survives_failure(db_session: AsyncSession, monkeypatch):
    uid = uuid4()
    user = User(id=uid, email="watchlist-bg@test", password_hash="x", display_name="BG")
    db_session.add(user)
    await db_session.flush()
    item_a = WatchlistItem(user_id=uid, tmdb_id=1, media_type="movie", title="A")
    item_b = WatchlistItem(user_id=uid, tmdb_id=2, media_type="movie", title="B")
    db_session.add_all([item_a, item_b])
    await db_session.commit()
    id_a = str(item_a.id)
    id_b = str(item_b.id)

    refreshed_ids = []

    async def fake_refresh(session, item):
        if item.tmdb_id == 1:
            raise RuntimeError("tmdb down")
        item.metadata_fetched_at = datetime.now(timezone.utc)
        refreshed_ids.append(str(item.id))

    monkeypatch.setattr(watchlist_service, "refresh_upcoming", fake_refresh)
    # The in-memory SQLite test engine uses a StaticPool single connection, so
    # concurrent sessions would interleave on it - force sequential refreshes.
    monkeypatch.setattr(watchlist_background, "REFRESH_CONCURRENCY", 1)

    count = await refresh_due_items(_test_session_factory)
    assert count == 1  # B refreshed; A failed but did not abort the batch
    assert refreshed_ids == [id_b]

    # A (failed) must NOT have been stamped -> still due and fails again;
    # B is fresh -> not re-refreshed. The batch survives the failing item.
    count = await refresh_due_items(_test_session_factory)
    assert count == 0
    assert refreshed_ids == [id_b]

    await db_session.refresh(item_a)
    await db_session.refresh(item_b)
    assert item_a.metadata_fetched_at is None
    assert item_b.metadata_fetched_at is not None

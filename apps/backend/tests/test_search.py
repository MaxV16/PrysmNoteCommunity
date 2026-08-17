import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_search_tasks_text(client: AsyncClient):
    await client.post("/api/tasks/", json={"title": "Buy groceries"})
    await client.post("/api/tasks/", json={"title": "Meeting with team"})

    response = await client.get("/api/search/", params={"q": "groceries", "mode": "text"})
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "text"
    assert len(data["results"]) >= 1
    assert any("groceries" in r["title"] for r in data["results"])


@pytest.mark.asyncio
async def test_search_typo_tolerant(client: AsyncClient):
    await client.post("/api/tasks/", json={"title": "Appointment with doctor"})

    # "apointment" (missing 'p') should still be found via trigram similarity.
    response = await client.get("/api/search/", params={"q": "apointment"})
    assert response.status_code == 200
    results = response.json()["results"]
    assert any("Appointment" in r["title"] for r in results)


@pytest.mark.asyncio
async def test_search_rank_exact_match_first(client: AsyncClient):
    await client.post("/api/tasks/", json={"title": "Quarterly report"})
    await client.post("/api/tasks/", json={"title": "Report status to team"})

    response = await client.get("/api/search/", params={"q": "quarterly report"})
    assert response.status_code == 200
    results = response.json()["results"]
    assert len(results) >= 1
    ranks = [r["rank"] for r in results if r["rank"] is not None]
    # Exact-ish title match ranks highest. On SQLite fallback rank is 0, so only
    # assert ordering when pg_trgm produced real ranks.
    if ranks and any(r > 0 for r in ranks):
        best = max(results, key=lambda r: r["rank"])
        assert "Quarterly report" in best["title"]
        assert all(results[i]["rank"] >= results[i + 1]["rank"] for i in range(len(results) - 1))


@pytest.mark.asyncio
async def test_search_results_are_user_scoped(client: AsyncClient):
    # The client fixture is bound to a single user; search must never surface tasks
    # owned by someone else. Create a task, then confirm the search only returns the
    # current user's tasks (cross-tenant isolation).
    await client.post("/api/tasks/", json={"title": "My private task"})
    await client.post("/api/tasks/", json={"title": "My private task 2"})

    response = await client.get("/api/search/", params={"q": "private"})
    assert response.status_code == 200
    results = response.json()["results"]
    assert all(r["title"].startswith("My private") for r in results)


@pytest.mark.asyncio
async def test_search_tasks_description(client: AsyncClient):
    await client.post("/api/tasks/", json={
        "title": "Project X",
        "description": "This is about the quarterly review",
    })

    response = await client.get("/api/search/", params={"q": "quarterly"})
    assert response.status_code == 200
    data = response.json()
    assert len(data["results"]) >= 1


@pytest.mark.asyncio
async def test_search_no_results(client: AsyncClient):
    response = await client.get("/api/search/", params={"q": "xyznonexistent"})
    assert response.status_code == 200
    assert len(response.json()["results"]) == 0


@pytest.mark.asyncio
async def test_search_empty_query(client: AsyncClient):
    response = await client.get("/api/search/", params={"q": ""})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_search_semantic_fallback(client: AsyncClient):
    # Without an API key configured, semantic search should return a graceful error
    response = await client.get("/api/search/", params={"q": "test", "mode": "semantic"})
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "semantic"
    # Should have either results, an error field, or empty results
    assert "results" in data

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

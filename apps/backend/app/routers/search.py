from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.services.embedding_service import get_user_llm_client_for_embedding, search_similar
from app.services.task_service import search_tasks

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/")
async def search(
    q: str = Query(..., min_length=1),
    mode: str = Query("text", description="text or semantic"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if mode == "semantic":
        provider_info = await get_user_llm_client_for_embedding(session, user.id)
        if not provider_info:
            return {"mode": "semantic", "error": "No API key configured for embeddings", "results": []}
        _, client = provider_info
        try:
            query_embedding = await client.embed(q)
        except Exception:
            return {"mode": "semantic", "error": "Embedding generation failed", "results": []}
        similar = await search_similar(session, query_embedding, user.id, limit=10)
        return {
            "mode": "semantic",
            "results": [
                {
                    "id": str(t.id),
                    "title": t.title,
                    "status": t.status.value if t.status else None,
                    "start_date": str(t.start_date) if t.start_date else None,
                    "due_date": str(t.due_date) if t.due_date else None,
                    "similarity": round(score, 3),
                }
                for t, score in similar
            ],
        }

    results = await search_tasks(session, user.id, q)
    return {
        "mode": "text",
        "results": [
            {
                "id": str(t.id),
                "title": t.title,
                "status": t.status.value if t.status else None,
                "start_date": str(t.start_date) if t.start_date else None,
                "due_date": str(t.due_date) if t.due_date else None,
                "rank": round(rank, 3),
            }
            for t, rank in results
        ],
    }

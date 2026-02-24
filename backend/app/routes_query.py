from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.db import SessionLocal
from app.retrieval import get_highlight, hybrid_search

router = APIRouter()


# ── Request / Response models ──────────────────────────────────────

class QueryRequest(BaseModel):
    question: str = Field(description="Natural language question to search the dataset with")
    dataset_id: int =Field(description="ID of the dataset to query. Call GET /tables first to discover valid IDs.")
    top_k: int
    filters: Optional[Dict[str, str]] = None


class HighlightItem(BaseModel):
    highlight_id: str
    column: str
    value: str
    relevance: float


class ResultItem(BaseModel):
    row_index: int
    score: float
    row_data: Dict[str, Any]
    highlights: List[HighlightItem]
    match_type: str


class QueryResponse(BaseModel):
    dataset_id: int
    question: str
    results: List[ResultItem]

class HighlightResponse(BaseModel):
    highlight_id: str
    dataset_id: int
    row_index: int
    column: str
    value: Any
    row_context: Dict[str, Any]


# ── Endpoints ──────────────────────────────────────────────────────

@router.post("/query", response_model=QueryResponse)
def query_dataset(body: QueryRequest):
    # Verify dataset exists
    with SessionLocal() as db:
        row = db.execute(
            text("SELECT id FROM datasets WHERE id = :id"),
            {"id": body.dataset_id},
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found.")

    results = hybrid_search(
        dataset_id=body.dataset_id,
        question=body.question,
        filters=body.filters,
        top_k=10,
    )

    return QueryResponse(
        dataset_id=body.dataset_id,
        question=body.question,
        results=results,
    )


@router.get("/highlights/{highlight_id}", response_model=HighlightResponse)
def get_highlight_endpoint(highlight_id: str):
    result = get_highlight(highlight_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Highlight not found.")
    return result

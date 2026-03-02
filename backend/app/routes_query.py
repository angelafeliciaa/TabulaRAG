import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.retrieval import get_highlight, resolve_dataset_context, smart_query
from app.routes_tables import list_tables

router = APIRouter()


# ── Request / Response models ──────────────────────────────────────

class QueryRequest(BaseModel):
    question: str = Field(description="Natural language question to search the dataset with")
    dataset_id: Optional[int] = Field(
        default=None,
        description=(
            "Preferred dataset ID. For best tool reliability, call GET /tables first and pass dataset_id."
        ),
    )
    dataset_name: Optional[str] = Field(
        default=None,
        description="Optional dataset name (for example 'Chocolate'). Helps automatic dataset resolution.",
    )
    top_k: int = Field(default=10, ge=1, le=100)
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
    source_url: Optional[str] = None
    top_highlight_id: Optional[str] = None
    highlight_url: Optional[str] = None


class QueryResponse(BaseModel):
    dataset_id: int
    question: str
    results: List[ResultItem]
    answer: Optional[str] = Field(
        default=None,
        description="Deterministic grounded answer generated from table data.",
    )
    answer_type: Optional[str] = Field(
        default=None,
        description="Answer generation mode (for example: aggregate).",
    )
    answer_details: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Structured grounding details from source rows (metric, filters, source_row_data, and citations). "
            "Prefer these values over model inference."
        ),
    )
    dataset_url: Optional[str] = Field(
        default=None,
        description="Frontend URL for the resolved table.",
    )
    final_response: Optional[str] = Field(
        default=None,
        description=(
            "Canonical user-facing answer with citation link. Agents should return this verbatim "
            "without rewriting names, numbers, or URLs."
        ),
    )
    verification: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Deterministic grounding checks run before returning (status, checks, errors). "
            "Treat status=fail as unverified output."
        ),
    )
    resolved_dataset: Optional[Dict[str, Any]] = None
    resolution_note: Optional[str] = None

class HighlightResponse(BaseModel):
    highlight_id: str
    dataset_id: int
    row_index: int
    column: str
    value: Any
    row_context: Dict[str, Any]


def _enforce_list_tables_first() -> bool:
    return os.getenv("QUERY_ENFORCE_LIST_TABLES_FIRST", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _list_tables_compact() -> List[Dict[str, Any]]:
    tables = list_tables()
    compact: List[Dict[str, Any]] = []
    for table in tables:
        compact.append(
            {
                "dataset_id": int(table["dataset_id"]),
                "name": table.get("name"),
                "source_filename": table.get("source_filename"),
                "row_count": table.get("row_count"),
                "column_count": table.get("column_count"),
            }
        )
    return compact


def _strict_lookup_error(status_code: int, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "message": message,
            "guidance": "Call GET /tables first, then call POST /query with the selected dataset_id.",
            "available_tables": _list_tables_compact(),
        },
    )


# ── Endpoints ──────────────────────────────────────────────────────

@router.post(
    "/query",
    response_model=QueryResponse,
    summary="Answer natural-language table queries",
    description="Primary analytics endpoint. Use this instead of row-slice tools for sums/counts/top-N and precise citations.",
)
def query_dataset(body: QueryRequest):
    if _enforce_list_tables_first() and body.dataset_id is None:
        raise _strict_lookup_error(
            status_code=409,
            message="dataset_id is required when QUERY_ENFORCE_LIST_TABLES_FIRST=true.",
        )

    if _enforce_list_tables_first():
        tables = _list_tables_compact()
        by_id = {int(table["dataset_id"]): table for table in tables}
        if body.dataset_id is None or int(body.dataset_id) not in by_id:
            raise _strict_lookup_error(
                status_code=404,
                message=f"Dataset ID {body.dataset_id} was not found.",
            )
        resolved_dataset_id = int(body.dataset_id)
        resolved_dataset = dict(by_id[resolved_dataset_id])
        resolution_note = None
    else:
        try:
            resolved_dataset_id, resolved_dataset, resolution_note = resolve_dataset_context(
                dataset_id=body.dataset_id,
                dataset_name=body.dataset_name,
                question=body.question,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    payload = smart_query(
        dataset_id=resolved_dataset_id,
        question=body.question,
        filters=body.filters,
        top_k=body.top_k,
    )
    if "source_url" not in resolved_dataset:
        resolved_dataset["source_url"] = payload.get("dataset_url")
    payload["resolved_dataset"] = resolved_dataset
    if resolution_note:
        payload["resolution_note"] = resolution_note
    return QueryResponse(**payload)


@router.get("/highlights/{highlight_id}", response_model=HighlightResponse)
def highlight_endpoint(highlight_id: str):
    result = get_highlight(highlight_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Highlight not found.")
    return result

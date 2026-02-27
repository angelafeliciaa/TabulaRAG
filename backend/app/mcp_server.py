import os
import re
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from app.routes_tables import list_tables, get_table_slice
from app.retrieval import get_highlight, smart_query

mcp = FastMCP(
    "TabulaRAG",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False
    )
)


def _normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _public_api_base_url() -> str:
    base = (
        os.getenv("PUBLIC_API_BASE_URL")
        or os.getenv("API_PUBLIC_BASE_URL")
        or os.getenv("BACKEND_PUBLIC_URL")
        or "http://localhost:8000"
    ).strip()
    return base.rstrip("/")


def _score_dataset_match(table: Dict[str, Any], dataset_name: str, question: str) -> float:
    score = 0.0
    normalized_name = _normalize_name(table.get("name", ""))
    normalized_file = _normalize_name(str(table.get("source_filename") or "").rsplit(".", 1)[0])
    normalized_question = _normalize_name(question)
    normalized_dataset_name = _normalize_name(dataset_name)

    if normalized_dataset_name:
        if normalized_dataset_name == normalized_name:
            score += 200
        elif normalized_dataset_name == normalized_file:
            score += 190
        elif normalized_dataset_name in normalized_name:
            score += 140
        elif normalized_dataset_name in normalized_file:
            score += 130

    if normalized_question:
        if normalized_name and normalized_name in normalized_question:
            score += 90
        if normalized_file and normalized_file in normalized_question:
            score += 80

    score += float(table.get("row_count") or 0) * 0.01
    return score


def _resolve_dataset_id(
    dataset_id: Optional[int],
    dataset_name: Optional[str],
    question: str,
) -> int:
    tables: List[Dict[str, Any]] = list_tables()
    if not tables:
        raise ValueError("No ingested tables found. Upload a CSV/TSV first.")

    if dataset_id is not None:
        if any(int(t["dataset_id"]) == int(dataset_id) for t in tables):
            return int(dataset_id)
        raise ValueError(f"Dataset ID {dataset_id} was not found.")

    ranked = sorted(
        tables,
        key=lambda table: (
            _score_dataset_match(table, dataset_name or "", question),
            int(table.get("row_count") or 0),
            int(table["dataset_id"]),
        ),
        reverse=True,
    )
    return int(ranked[0]["dataset_id"])


def _table_meta(dataset_id: int) -> Dict[str, Any]:
    for table in list_tables():
        if int(table["dataset_id"]) == dataset_id:
            return {
                "dataset_id": dataset_id,
                "name": table.get("name"),
                "source_filename": table.get("source_filename"),
                "row_count": table.get("row_count"),
                "column_count": table.get("column_count"),
                "source_url": f"{_public_api_base_url()}/tables/{dataset_id}/slice?offset=0&limit=30",
            }
    return {
        "dataset_id": dataset_id,
        "name": None,
        "source_filename": None,
        "row_count": None,
        "column_count": None,
        "source_url": f"{_public_api_base_url()}/tables/{dataset_id}/slice?offset=0&limit=30",
    }


@mcp.tool()
def ping() -> dict:
    """Check connectivity."""
    return {"status": "ok"}

@mcp.tool()
def mcp_list_tables() -> list:
    """List all ingested tables."""
    return list_tables()

@mcp.tool()
def mcp_get_table_slice(dataset_id: int, offset: int = 0, limit: int = 30) -> dict:
    """Get a slice of rows from a table by dataset_id."""
    return get_table_slice(dataset_id, offset, limit)

@mcp.tool()
def mcp_query(
    question: str,
    dataset_id: Optional[int] = None,
    dataset_name: Optional[str] = None,
    top_k: int = 10,
) -> dict:
    """Answer natural-language table questions with direct answer text, SQL-equivalent plan, and source URLs."""
    resolved_dataset_id = _resolve_dataset_id(
        dataset_id=dataset_id,
        dataset_name=dataset_name,
        question=question,
    )
    payload = smart_query(
        dataset_id=resolved_dataset_id,
        question=question,
        top_k=top_k,
    )
    payload["resolved_dataset"] = _table_meta(resolved_dataset_id)
    if dataset_id is None:
        payload["resolution_note"] = (
            f"Resolved dataset_id={resolved_dataset_id}. "
            "Pass dataset_id explicitly to force a specific table."
        )
    return payload

@mcp.tool()
def mcp_get_highlight(highlight_id: str) -> dict:
    """Get a specific highlighted cell by its highlight ID."""
    result = get_highlight(highlight_id)
    if not result:
        raise ValueError("Highlight not found")
    return result

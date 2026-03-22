import os
import base64
import json
import re
from typing import Any, Dict, List, Literal, Optional, Union
from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.query_input_schemas import (
    AggregateRequest,
    FilterCondition,
    FilterRequest,
    FilterRowIndicesRequest,
    QueryRequest,
    UNIFIED_QUERY_OPENAPI_EXAMPLES,
    UnifiedQueryRequest,
)
from app.retrieval import get_highlight, hybrid_search, resolve_dataset_context, smart_query
from app.routes_tables import list_tables, get_cols_for_dataset
import app.db as app_db
from app.db import SessionLocal
from app.name_guard import sanitize_dataset_name
from app.normalization import (
    flatten_row_data_to_normalized,
    flatten_row_data_to_original,
    get_normalized_value,
    get_column_currency,
    get_column_unit,
    parse_number,
    strip_internal_fields,
)

router = APIRouter()
_ISO_DATE_VALUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _strip_money(value: str) -> str:
    """Strip currency symbols and thousands separators from a user-supplied value, keeping numeric characters."""
    return re.sub(r"[^0-9.\-]", "", value)


def _is_sqlite() -> bool:
    return app_db.engine.dialect.name == "sqlite"


def _column_json_text_expr(column_name: str) -> str:
    """SQL expression for the normalized value of a column from row_data (supports {original, normalized} shape and legacy plain values)."""
    escaped = column_name.replace("'", "''")
    if _is_sqlite():
        json_key = column_name.replace("\\", "\\\\").replace('"', '\\"')
        # Prefer .normalized for new shape; fallback to plain value for legacy
        return f"COALESCE(json_extract(row_data, '$.\"{json_key}\".normalized'), json_extract(row_data, '$.\"{json_key}\"'))"
    return f"COALESCE((row_data::jsonb -> '{escaped}') ->> 'normalized', row_data::jsonb ->> '{escaped}')"


def _column_null_check_expr(column_name: str) -> str:
    """SQL expression for IS NULL / IS NOT NULL: must be SQL NULL when normalized is JSON null, not the whole object. For legacy plain values, use the plain value."""
    escaped = column_name.replace("'", "''")
    if _is_sqlite():
        json_key = column_name.replace("\\", "\\\\").replace('"', '\\"')
        # When cell is an object, use .normalized only (so JSON null => SQL NULL). When legacy plain value, use it.
        return (
            f"CASE WHEN json_type(json_extract(row_data, '$.\"{json_key}\"')) = 'object' "
            f"THEN json_extract(row_data, '$.\"{json_key}\".normalized') "
            f"ELSE json_extract(row_data, '$.\"{json_key}\"') END"
        )
    # When cell is object use only .normalized (so JSON null => SQL NULL); else legacy scalar
    return (
        f"CASE WHEN jsonb_typeof(row_data::jsonb -> '{escaped}') = 'object' "
        f"THEN (row_data::jsonb -> '{escaped}') ->> 'normalized' "
        f"ELSE row_data::jsonb ->> '{escaped}' END"
    )


def _group_by_date_part_expr(
    col_expr: str, part: Literal["month", "quarter", "year"]
) -> str:
    """SQL expression that groups an ISO date column by month (YYYY-MM), quarter (YYYY-QN), or year (YYYY)."""
    if _is_sqlite():
        if part == "month":
            return f"strftime('%Y-%m', {col_expr})"
        if part == "year":
            return f"strftime('%Y', {col_expr})"
        # quarter: YYYY-Q1..Q4
        return (
            f"strftime('%Y', {col_expr}) || '-Q' || ((cast(strftime('%m', {col_expr}) as integer) + 2) / 3)"
        )
    # PostgreSQL
    if part == "month":
        return f"SUBSTRING({col_expr} FROM 1 FOR 7)"
    if part == "year":
        return f"SUBSTRING({col_expr} FROM 1 FOR 4)"
    return f"to_char(({col_expr})::date, 'YYYY-\"Q\"Q')"


def _numeric_sql_expr(col: str) -> str:
    """SQL expression that casts a text column to double precision after stripping currency/formatting chars."""
    if _is_sqlite():
        cleaned = (
            f"REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM({col}), '$', ''), ',', ''), '€', ''), '£', ''), '¥', '')"
        )
        return f"CAST(NULLIF({cleaned}, '') AS REAL)"
    return f"NULLIF(REGEXP_REPLACE(TRIM({col}), '[^0-9.\\-]', '', 'g'), '')::double precision"


def _numeric_bind_expr(param_name: str) -> str:
    if _is_sqlite():
        return f"CAST(:{param_name} AS REAL)"
    return f"CAST(:{param_name} AS double precision)"


def _sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    escaped = str(value).replace("'", "''")
    return f"'{escaped}'"


def _render_sql(sql_template: str, params: Dict[str, Any]) -> str:
    rendered = sql_template
    for key in sorted(params.keys(), key=len, reverse=True):
        rendered = rendered.replace(f":{key}", _sql_literal(params[key]))
    return "\n".join(line.rstrip() for line in rendered.strip().splitlines())


def _coerce_row_data_dict(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, str):
                parsed = json.loads(parsed)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _is_iso_date_value(value: Any) -> bool:
    if value is None:
        return False
    text_value = str(value).strip()
    return bool(_ISO_DATE_VALUE_RE.match(text_value))


def _infer_column_kinds(
    dataset_id: int, valid_columns: set[str], sample_rows: int = 200
) -> Dict[str, Literal["text", "number", "date"]]:
    kind_scores: Dict[str, Dict[str, int]] = {
        col: {"text": 0, "number": 0, "date": 0} for col in valid_columns
    }
    params = {"dataset_id": dataset_id, "sample_rows": max(1, min(sample_rows, 1000))}

    with SessionLocal() as db:
        sample_rows_raw = db.execute(
            text(
                """
                SELECT row_data
                FROM dataset_rows
                WHERE dataset_id = :dataset_id
                ORDER BY row_index ASC
                LIMIT :sample_rows
                """
            ),
            params,
        ).fetchall()

    for row in sample_rows_raw:
        row_data = _coerce_row_data_dict(row[0] if row else None)
        if not row_data:
            continue

        typed = row_data.get("__typed__")
        if isinstance(typed, dict):
            for col, item in typed.items():
                if col not in valid_columns or not isinstance(item, dict):
                    continue
                item_type = item.get("type")
                if item_type == "date":
                    kind_scores[col]["date"] += 2
                elif item_type in {"number", "money", "measurement"}:
                    kind_scores[col]["number"] += 2

        for col in valid_columns:
            normalized_value = get_normalized_value(row_data, col)
            if normalized_value is None:
                continue
            if _is_iso_date_value(normalized_value):
                kind_scores[col]["date"] += 1
            elif parse_number(normalized_value) is not None:
                kind_scores[col]["number"] += 1
            else:
                kind_scores[col]["text"] += 1

    kinds: Dict[str, Literal["text", "number", "date"]] = {}
    for col, scores in kind_scores.items():
        winner = max(scores.items(), key=lambda item: (item[1], item[0]))[0]
        kinds[col] = winner  # type: ignore[assignment]
    return kinds


def _build_where_clauses(
    filters: Optional[List["FilterCondition"]],
    valid_columns: set[str],
    params: Dict[str, Any],
    column_kinds: Optional[Dict[str, Literal["text", "number", "date"]]] = None,
) -> List[str]:
    where_clauses = ["dataset_id = :dataset_id"]

    def col_expr(column_name: str) -> str:
        return _column_json_text_expr(column_name)

    def num_col_expr(column_name: str) -> str:
        return _numeric_sql_expr(col_expr(column_name))

    def is_date_column(column_name: str) -> bool:
        return bool(column_kinds and column_kinds.get(column_name) == "date")

    if not filters:
        return where_clauses

    filter_expressions: List[str] = []
    filter_joiners: List[str] = []

    for i, f in enumerate(filters):
        if f.column not in valid_columns:
            raise HTTPException(400, detail=f"Invalid filter column: {f.column}")

        vp = f"fval_{i}"
        col = col_expr(f.column)
        current_expr = ""

        if f.operator in ("IS NULL", "IS NOT NULL"):
            null_col = _column_null_check_expr(f.column)
            current_expr = f"({null_col} {f.operator})"
        elif f.operator == "IN":
            if not f.value:
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter value is required for operator IN on column {f.column}.",
                )
            values = [v.strip() for v in f.value.split(",") if v.strip()]
            if not values:
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter value is required for operator IN on column {f.column}.",
                )
            in_params = {f"fval_{i}_{j}": v for j, v in enumerate(values)}
            params.update(in_params)
            placeholders = ", ".join(f":{k}" for k in in_params)
            current_expr = f"{col} IN ({placeholders})"
        elif f.operator == "BETWEEN":
            if not f.value:
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter value is required for operator BETWEEN on column {f.column}.",
                )
            if "," in f.value:
                parts = [v.strip() for v in f.value.split(",", maxsplit=1)]
            else:
                parts = [v.strip() for v in f.value.split("AND", maxsplit=1)]

            if len(parts) != 2 or not parts[0] or not parts[1]:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"BETWEEN filter on column {f.column} must provide two bounds, "
                        "for example '3,6' or '3 AND 6'."
                    ),
                )
            low_key = f"fval_{i}_low"
            high_key = f"fval_{i}_high"
            if is_date_column(f.column):
                params[low_key] = parts[0]
                params[high_key] = parts[1]
                current_expr = f"{col} BETWEEN :{low_key} AND :{high_key}"
            else:
                params[low_key] = _strip_money(parts[0])
                params[high_key] = _strip_money(parts[1])
                current_expr = (
                    f"{num_col_expr(f.column)} BETWEEN "
                    f"{_numeric_bind_expr(low_key)} AND {_numeric_bind_expr(high_key)}"
                )
        else:
            if f.value is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter value is required for operator {f.operator} on column {f.column}.",
                )

            if f.operator in ("CONTAINS", "NOT CONTAINS"):
                params[vp] = f"%{f.value}%"
                like_op = "NOT LIKE" if f.operator == "NOT CONTAINS" else "LIKE"
                current_expr = f"LOWER({col}) {like_op} LOWER(:{vp})"
            elif f.operator in ("LIKE", "NOT LIKE"):
                params[vp] = f.value
                current_expr = f"{col} {f.operator} :{vp}"
            elif f.operator in (">", ">=", "<", "<="):
                if is_date_column(f.column):
                    params[vp] = f.value
                    current_expr = f"{col} {f.operator} :{vp}"
                else:
                    params[vp] = _strip_money(f.value)
                    current_expr = (
                        f"{num_col_expr(f.column)} {f.operator} {_numeric_bind_expr(vp)}"
                    )
            else:
                params[vp] = f.value
                current_expr = f"{col} {f.operator} :{vp}"

        filter_expressions.append(current_expr)
        if i > 0:
            filter_joiners.append(f.logical_operator.upper())

    if filter_expressions:
        combined = filter_expressions[0]
        for i in range(1, len(filter_expressions)):
            joiner = filter_joiners[i - 1]
            combined = f"({combined} {joiner} {filter_expressions[i]})"
        where_clauses.append(combined)

    return where_clauses



# ── Request / Response models ──────────────────────────────────────
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


RESPONSE_URL_REQUIREMENT_TEXT = (
    "MANDATORY: In every user-facing response, include the exact `url` value as the source link. "
    "This is required any time table data is returned."
)


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
    url: str = Field(
        description=(
            "Canonical source URL for this query response. ALWAYS include this URL in user-facing responses."
        ),
    )
    final_response: str = Field(
        description=(
            "MANDATORY user-facing answer that already includes the source link. "
            "Agents should return this verbatim without rewriting names, numbers, or URLs."
        ),
    )
    response_instructions: str = Field(
        default=RESPONSE_URL_REQUIREMENT_TEXT,
        description="Strict response contract for MCP clients.",
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
#     url: Optional[str] = Field(
#         default=None,
#         description=(
#             "Canonical citation URL for this answer. Points to the highlighted cell "
#             "when available, otherwise the table view. Return this to users as the source link."
#         ),
#     )


class AggregateResponse(BaseModel):
    dataset_id: int
    metric_column: Optional[str]
    metrics: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description=(
            "Optional multi-metric descriptor when request includes metrics[]. "
            "Each entry includes agg, column, and output_key."
        ),
    )
    group_by_column: Optional[str]
    group_by_date_part: Optional[str] = None
    metric_currency: Optional[str] = Field(
        default=None,
        description="Currency code for the metric column when it is money (e.g. USD, EUR). Use when phrasing the answer.",
    )
    metric_unit: Optional[str] = Field(
        default=None,
        description="Standard unit for the metric column when it is a measurement (e.g. kg, m). Use when displaying aggregate values.",
    )
    rowsResult: List[Dict[str, Any]] = Field(
        description="Result of the aggregate query. In your response, mention both the group_value and aggregate_value."
    )
    sql_query: str
    url: str = Field(
        description="ALWAYS include this URL in your response as the source link."
    )
    final_response: str = Field(
        description=(
            "MANDATORY user-facing answer that already includes the source link. "
            "Agents should return this verbatim."
        ),
    )
    response_instructions: str = Field(
        default=RESPONSE_URL_REQUIREMENT_TEXT,
        description="Strict response contract for MCP clients.",
    )


class FilterResponse(BaseModel):
    dataset_id: int
    rowsResult: List[Dict[str, Any]]
    row_count: int
    sql_query: str
    url: str = Field(
        description="ALWAYS include this URL in your response as the source link."
    )
    final_response: str = Field(
        description=(
            "MANDATORY user-facing answer that already includes the source link. "
            "Agents should return this verbatim."
        ),
    )
    response_instructions: str = Field(
        default=RESPONSE_URL_REQUIREMENT_TEXT,
        description="Strict response contract for MCP clients.",
    )


class FilterRowIndicesResponse(BaseModel):
    dataset_id: int
    row_indices: List[int]
    total_match_count: int
    truncated: bool
    sql_query: str
    url: str = Field(
        description="ALWAYS include this URL in your response as the source link."
    )
    final_response: str = Field(
        description=(
            "MANDATORY user-facing answer that already includes the source link. "
            "Agents should return this verbatim."
        ),
    )
    response_instructions: str = Field(
        default=RESPONSE_URL_REQUIREMENT_TEXT,
        description="Strict response contract for MCP clients.",
    )


UnifiedQueryResponse = Union[
    QueryResponse,
    AggregateResponse,
    FilterResponse,
    FilterRowIndicesResponse,
]


class HighlightResponse(BaseModel):
    highlight_id: str
    dataset_id: int
    row_index: int
    column: str
    value: Any
    row_context: Dict[str, Any]


PUBLIC_UI_BASE_URL = os.getenv("PUBLIC_UI_BASE_URL", "http://localhost:5173")


def build_dataset_table_url(dataset_id: int) -> str:
    return f"{PUBLIC_UI_BASE_URL}/tables/{dataset_id}"


def build_virtual_table_url(body: AggregateRequest, rows: List[Dict[str, Any]]) -> str:
    if not rows:
        highlight_index = 0
    elif body.operation == "max":
        highlight_index = 0
    elif body.operation == "min":
        highlight_index = max(0, len(rows) - 1)
    else:
        highlight_index = 0
    payload = {
        "dataset_id": body.dataset_id,
        "operation": body.operation,
        "metric_column": body.metric_column,
        "metrics": body.metrics,
        "group_by": body.group_by,
        "group_by_date_part": body.group_by_date_part,
        # Keep filters as a list (not null) so older clients/validators that require
        # a list keep working when they replay this payload back to /aggregate.
        "filters": [f.model_dump() for f in body.filters] if body.filters else [],
        "highlight_index": highlight_index,
        "limit": 500,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    # Put payload in both query and hash so link still works if query string is stripped (e.g. by some clients after normalization)
    return f"{PUBLIC_UI_BASE_URL}/tables/virtual?q={encoded}#q={encoded}"


def build_filter_virtual_table_url(body: FilterRequest) -> str:
    limit = max(1, min(int(body.limit), 500))
    offset = max(0, int(body.offset))
    payload = {
        "mode": "filter",
        "dataset_id": body.dataset_id,
        "filters": [f.model_dump() for f in body.filters] if body.filters else [],
        "columns": body.columns,
        "sort_by": body.sort_by,
        "sort_order": body.sort_order,
        "sort_as": body.sort_as,
        "limit": limit,
        "offset": offset,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"{PUBLIC_UI_BASE_URL}/tables/virtual?q={encoded}#q={encoded}"


def _with_mandatory_source_link(
    final_response: Optional[str], url: str, fallback_message: str
) -> str:
    base = (final_response or "").strip()
    if not base:
        base = fallback_message.strip()
    if url in base:
        return base
    if base:
        return f"{base}\nSource link: {url}"
    return f"Source link: {url}"

def _enforce_list_tables_first() -> bool:
    return os.getenv("QUERY_ENFORCE_LIST_TABLES_FIRST", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _require_dataset_name_when_multiple() -> bool:
    return os.getenv("QUERY_REQUIRE_DATASET_NAME_WHEN_MULTIPLE", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _list_tables_compact(include_ids: bool = True) -> List[Dict[str, Any]]:
    tables = list_tables(include_pending=False, offset=0, limit=200)
    compact: List[Dict[str, Any]] = []
    for table in tables:
        item = {
            "name": table.get("name"),
            "source_filename": table.get("source_filename"),
            "row_count": table.get("row_count"),
            "column_count": table.get("column_count"),
        }
        if include_ids:
            item["dataset_id"] = int(table["dataset_id"])
        compact.append(item)
    return compact


def _strict_lookup_error(status_code: int, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "message": message,
            "guidance": (
                "Call GET /tables first. If more than one dataset could match, do not guess: "
                "ask the user to confirm a single dataset_name from available_tables, then call POST /query."
            ),
            "available_tables": _list_tables_compact(include_ids=True),
        },
    )


# ── Internal query handlers ────────────────────────────────────────

def _run_semantic_query(body: QueryRequest) -> QueryResponse:
    if _enforce_list_tables_first():
        resolved_dataset_id = _resolve_structured_dataset_id(
            dataset_id=body.dataset_id,
            dataset_name=body.dataset_name,
            mode_label="Semantic",
        )
        body.dataset_id = resolved_dataset_id

        tables = _list_tables_compact(include_ids=True)
        by_id = {int(table["dataset_id"]): table for table in tables}
        if resolved_dataset_id not in by_id:
            raise _strict_lookup_error(
                status_code=404,
                message=f"Dataset was not found.",
            )
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
    dataset_url = payload.get("dataset_url") or build_dataset_table_url(resolved_dataset_id)
    payload["dataset_url"] = dataset_url
    if "source_url" not in resolved_dataset:
        resolved_dataset["source_url"] = dataset_url

    canonical_url = dataset_url
    results = payload.get("results")
    if isinstance(results, list) and results:
        first = results[0]
        if isinstance(first, dict):
            canonical_url = (
                first.get("highlight_url")
                or first.get("source_url")
                or dataset_url
            )
    payload["url"] = canonical_url
    payload["final_response"] = _with_mandatory_source_link(
        payload.get("final_response"),
        canonical_url,
        "Query completed.",
    )

    payload["resolved_dataset"] = resolved_dataset
    if resolution_note:
        payload["resolution_note"] = resolution_note
    return QueryResponse(**payload)


def _ensure_dataset_exists(dataset_id: int) -> None:
    with SessionLocal() as db:
        row = db.execute(
            text("SELECT id FROM datasets WHERE id = :id"),
            {"id": dataset_id},
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found.")


def _resolve_structured_dataset_id(
    *,
    dataset_id: Optional[int],
    dataset_name: Optional[str],
    mode_label: str,
) -> int:
    raw_name = (dataset_name or "").strip()

    # Backward-compatible path: explicit dataset_id without dataset_name.
    if dataset_id is not None and not raw_name:
        resolved_from_id = int(dataset_id)
        _ensure_dataset_exists(resolved_from_id)
        if _require_dataset_name_when_multiple():
            tables_for_id = _list_tables_compact(include_ids=True)
            if len(tables_for_id) > 1:
                raise _strict_lookup_error(
                    status_code=409,
                    message=(
                        f"{mode_label} query requires dataset_name when multiple datasets are available."
                    ),
                )
        return resolved_from_id

    tables = _list_tables_compact(include_ids=True)
    if not tables:
        raise HTTPException(
            status_code=404,
            detail={
                "message": "No datasets are available. Upload a dataset first.",
                "guidance": "Upload a CSV/TSV, then retry your query.",
                "available_tables": [],
            },
        )

    if raw_name:
        normalized = sanitize_dataset_name(raw_name)
        needle = re.sub(r"[^a-z0-9]+", " ", (normalized or raw_name).lower()).strip()

        def _name_token(value: Optional[str]) -> str:
            return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()

        exact_matches: List[Dict[str, Any]] = []
        partial_matches: List[Dict[str, Any]] = []

        for table in tables:
            name_token = _name_token(str(table.get("name") or ""))
            file_token = _name_token(str(table.get("source_filename") or "").rsplit(".", 1)[0])
            if needle and (needle == name_token or needle == file_token):
                exact_matches.append(table)
            elif needle and (
                needle in name_token or needle in file_token
            ):
                partial_matches.append(table)

        candidates = exact_matches or partial_matches
        if not candidates:
            raise _strict_lookup_error(
                status_code=404,
                message=f"Dataset name '{raw_name}' was not found.",
            )

        if len(candidates) > 1:
            choices = ", ".join(str(item.get("name") or "") for item in candidates[:5])
            raise _strict_lookup_error(
                status_code=409,
                message=(
                    f"Dataset name '{raw_name}' is ambiguous. "
                    f"Please be more specific. Matches: {choices}"
                ),
            )

        match_id = candidates[0].get("dataset_id")
        if match_id is None:
            raise _strict_lookup_error(
                status_code=404,
                message=f"Dataset name '{raw_name}' was not found.",
            )
        resolved_by_name = int(match_id)

        if dataset_id is not None and int(dataset_id) != resolved_by_name:
            raise _strict_lookup_error(
                status_code=409,
                message=(
                    f"dataset_id={dataset_id} does not match dataset_name '{raw_name}'. "
                    "Use one dataset selection."
                ),
            )

        return resolved_by_name

    if len(tables) == 1:
        only = tables[0].get("dataset_id")
        if only is not None:
            return int(only)

    raise _strict_lookup_error(
        status_code=409,
        message=(
            f"{mode_label} query requires dataset_name when multiple datasets are available."
        ),
    )


def _metric_output_key(
    agg: str, column: Optional[str], index: int, used: set[str]
) -> str:
    if column:
        base = f"{agg}_{re.sub(r'[^a-zA-Z0-9]+', '_', column).strip('_').lower()}"
    else:
        base = agg
    if not base:
        base = f"metric_{index + 1}"
    key = base
    suffix = 2
    while key in used:
        key = f"{base}_{suffix}"
        suffix += 1
    used.add(key)
    return key


def _run_aggregate_query(body: AggregateRequest) -> AggregateResponse:
    resolved_dataset_id = _resolve_structured_dataset_id(
        dataset_id=body.dataset_id,
        dataset_name=body.dataset_name,
        mode_label="Aggregate",
    )
    body.dataset_id = resolved_dataset_id

    cols_payload = get_cols_for_dataset(resolved_dataset_id)
    valid_columns = {col["normalized_name"] for col in cols_payload["columns"]}
    if not valid_columns:
        raise HTTPException(status_code=400, detail="Dataset has no columns.")

    if body.metric_column and body.metric_column not in valid_columns:
        raise HTTPException(status_code=400, detail="Invalid metric_column.")

    if body.group_by and body.group_by not in valid_columns:
        raise HTTPException(status_code=400, detail="Invalid group_by column.")

    column_kinds = _infer_column_kinds(resolved_dataset_id, valid_columns)

    metric_specs: List[Dict[str, Optional[str]]] = []
    if body.metrics:
        for metric in body.metrics:
            agg = str(metric.get("agg", "")).strip().lower()
            metric_col_raw = metric.get("column")
            metric_column = (
                str(metric_col_raw).strip()
                if metric_col_raw is not None
                else None
            )
            if metric_column is not None and metric_column not in valid_columns:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid metric column: {metric_column}",
                )
            if agg != "count" and not metric_column:
                raise HTTPException(
                    status_code=400,
                    detail=f"Metric agg '{agg}' requires a column.",
                )
            metric_specs.append({"agg": agg, "column": metric_column})
    else:
        operation = body.operation or "count"
        metric_specs.append({"agg": operation, "column": body.metric_column})

    if not metric_specs:
        raise HTTPException(status_code=400, detail="At least one metric is required.")

    limit = max(1, min(body.limit, 500))

    params: Dict[str, Any] = {"dataset_id": resolved_dataset_id, "limit": limit}

    def col_expr(column_name: str) -> str:
        return _column_json_text_expr(column_name)

    select_parts = []
    metric_aliases: List[str] = []
    metric_metadata: List[Dict[str, Any]] = []
    used_output_keys: set[str] = set()

    group_by_sql = ""
    order_by_sql = ""
    if body.group_by:
        base_col_expr = col_expr(body.group_by)
        if body.group_by_date_part:
            group_expr = _group_by_date_part_expr(base_col_expr, body.group_by_date_part)
        else:
            group_expr = base_col_expr
        select_parts.append(f"{group_expr} AS group_value")
        group_by_sql = f" GROUP BY {group_expr}"
        order_by_sql = (
            " ORDER BY aggregate_value DESC NULLS LAST"
            if not _is_sqlite()
            else " ORDER BY aggregate_value DESC"
        )
    else:
        order_by_sql = ""

    for i, metric in enumerate(metric_specs):
        agg = str(metric.get("agg") or "").lower()
        metric_column = metric.get("column")
        alias = "aggregate_value" if i == 0 else f"metric_{i}"
        metric_aliases.append(alias)

        if agg == "count":
            metric_expr = "COUNT(*)"
        else:
            numeric_expr = _numeric_sql_expr(col_expr(metric_column or ""))
            metric_expr = f"{agg.upper()}({numeric_expr})"

        select_parts.append(f"{metric_expr} AS {alias}")
        metric_metadata.append(
            {
                "agg": agg,
                "column": metric_column,
                "output_key": _metric_output_key(agg, metric_column, i, used_output_keys),
            }
        )

    where_clauses = _build_where_clauses(
        filters=body.filters,
        valid_columns=valid_columns,
        params=params,
        column_kinds=column_kinds,
    )

    sql = f"""
        SELECT {", ".join(select_parts)}
        FROM dataset_rows
        WHERE {" AND ".join(where_clauses)}
        {group_by_sql}
        {order_by_sql}
        LIMIT :limit
    """

    metric_currency: Optional[str] = None
    metric_unit: Optional[str] = None
    with SessionLocal() as db:
        rows_raw = db.execute(text(sql), params).mappings().all()

        first_metric_column = metric_specs[0].get("column")
        if first_metric_column:
            sample = db.execute(
                text("SELECT row_data FROM dataset_rows WHERE dataset_id = :dataset_id LIMIT 1"),
                {"dataset_id": resolved_dataset_id},
            ).fetchone()
            if sample and sample[0]:
                row_data = sample[0]
                if isinstance(row_data, str):
                    row_data = json.loads(row_data)
                if isinstance(row_data, dict):
                    metric_currency = get_column_currency(row_data, first_metric_column)
                    metric_unit = get_column_unit(row_data, first_metric_column)

    rows: List[Dict[str, Any]] = []
    for r in rows_raw:
        item = dict(r)
        # normalize non-grouped response shape
        if not body.group_by and "group_value" not in item:
            item["group_value"] = None

        if len(metric_specs) > 1:
            first_key = metric_metadata[0]["output_key"]
            if first_key != "aggregate_value":
                item[first_key] = item.get("aggregate_value")

            for i in range(1, len(metric_specs)):
                alias = metric_aliases[i]
                value = item.pop(alias, None)
                out_key = metric_metadata[i]["output_key"]
                item[out_key] = value

        rows.append(item)

    url = build_virtual_table_url(body, rows)

    first_metric_column = metric_specs[0].get("column")
    return AggregateResponse(
        dataset_id=resolved_dataset_id,
        metric_column=first_metric_column,
        metrics=metric_metadata if len(metric_specs) > 1 else None,
        group_by_column=body.group_by,
        group_by_date_part=body.group_by_date_part,
        metric_currency=metric_currency,
        metric_unit=metric_unit,
        rowsResult=rows,
        sql_query=_render_sql(sql, params),
        url=url,
        final_response=_with_mandatory_source_link(
            None,
            url,
            (
                f"Aggregate query completed with {len(rows)} row(s). "
                f"Operation: {metric_specs[0].get('agg') or 'count'}."
            ),
        ),
    )


def _run_filter_query(body: FilterRequest) -> FilterResponse:
    resolved_dataset_id = _resolve_structured_dataset_id(
        dataset_id=body.dataset_id,
        dataset_name=body.dataset_name,
        mode_label="Filter",
    )
    body.dataset_id = resolved_dataset_id

    cols_payload = get_cols_for_dataset(resolved_dataset_id)
    ordered_columns = [
        col["normalized_name"]
        for col in cols_payload["columns"]
        if col.get("normalized_name")
    ]
    valid_columns = set(ordered_columns)
    if not valid_columns:
        raise HTTPException(status_code=400, detail="Dataset has no columns.")

    projected_columns: Optional[List[str]] = None
    if body.columns:
        deduped_columns = list(dict.fromkeys(body.columns))
        invalid_projection = [col for col in deduped_columns if col not in valid_columns]
        if invalid_projection:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid projection columns: {', '.join(invalid_projection)}",
            )
        projected_columns = deduped_columns

    sort_by = body.sort_by
    if sort_by is not None and sort_by not in valid_columns:
        raise HTTPException(status_code=400, detail=f"Invalid sort_by column: {sort_by}")

    column_kinds = _infer_column_kinds(resolved_dataset_id, valid_columns)

    limit = max(1, min(body.limit, 500))
    offset = max(0, body.offset)
    params: Dict[str, Any] = {
        "dataset_id": resolved_dataset_id,
        "limit": limit,
        "offset": offset,
    }

    where_clauses = _build_where_clauses(
        filters=body.filters,
        valid_columns=valid_columns,
        params=params,
        column_kinds=column_kinds,
    )

    if sort_by:
        sort_kind = body.sort_as
        if sort_kind == "auto":
            inferred_kind = column_kinds.get(sort_by, "text")
            sort_kind = "number" if inferred_kind == "number" else inferred_kind

        sort_col = _column_json_text_expr(sort_by)
        if sort_kind == "number":
            sort_expr = _numeric_sql_expr(sort_col)
        else:
            # For dates we sort normalized ISO text (YYYY-MM-DD), which preserves chronology.
            sort_expr = sort_col

        sort_direction = "DESC" if body.sort_order == "desc" else "ASC"
        if _is_sqlite():
            order_sql = f"{sort_expr} {sort_direction}, row_index ASC"
        else:
            order_sql = f"{sort_expr} {sort_direction} NULLS LAST, row_index ASC"
    else:
        order_sql = "row_index ASC"

    sql = """
        SELECT row_index, row_data
        FROM dataset_rows
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT :limit
        OFFSET :offset
    """.format(where_sql=" AND ".join(where_clauses), order_sql=order_sql)

    count_sql = """
        SELECT COUNT(*) AS row_count
        FROM dataset_rows
        WHERE {where_sql}
    """.format(where_sql=" AND ".join(where_clauses))

    with SessionLocal() as db:
        rows_raw = db.execute(text(sql), params).mappings().all()
        row_count_raw = db.execute(text(count_sql), params).scalar_one()

    highlight_column = None
    if body.filters:
        for item in body.filters:
            candidate = item.column
            if candidate in valid_columns:
                highlight_column = candidate
                break
    if highlight_column is None:
        highlight_column = ordered_columns[0]

    rows: List[Dict[str, Any]] = []
    for r in rows_raw:
        item = dict(r)
        row_data = item.get("row_data")
        if isinstance(row_data, dict):
            flattened = flatten_row_data_to_original(row_data)
        elif isinstance(row_data, str):
            try:
                parsed = json.loads(row_data)
                if isinstance(parsed, str):
                    parsed = json.loads(parsed)
                flattened = (
                    flatten_row_data_to_original(parsed) if isinstance(parsed, dict) else {}
                )
            except Exception:
                flattened = {}
        else:
            flattened = {}

        if projected_columns is not None:
            item["row_data"] = {col: flattened.get(col) for col in projected_columns}
        else:
            item["row_data"] = flattened

        row_index = int(item.get("row_index", 0))
        item["highlight_id"] = f"d{resolved_dataset_id}_r{row_index}_{highlight_column}"
        rows.append(item)
    url = build_filter_virtual_table_url(body)

    return FilterResponse(
        dataset_id=resolved_dataset_id,
        rowsResult=rows,
        row_count=int(row_count_raw or 0),
        sql_query=_render_sql(sql, params),
        url=url,
        final_response=_with_mandatory_source_link(
            None,
            url,
            (
                f"Filter query completed with {len(rows)} row(s) in this page "
                f"out of {int(row_count_raw or 0)} total matching row(s)."
            ),
        ),
    )


def _run_filter_row_indices_query(
    body: FilterRowIndicesRequest,
) -> FilterRowIndicesResponse:
    resolved_dataset_id = _resolve_structured_dataset_id(
        dataset_id=body.dataset_id,
        dataset_name=body.dataset_name,
        mode_label="Filter row indices",
    )
    body.dataset_id = resolved_dataset_id

    cols_payload = get_cols_for_dataset(resolved_dataset_id)
    valid_columns = {col["normalized_name"] for col in cols_payload["columns"]}
    if not valid_columns:
        raise HTTPException(status_code=400, detail="Dataset has no columns.")

    column_kinds = _infer_column_kinds(resolved_dataset_id, valid_columns)

    max_rows = max(1, min(int(body.max_rows), 1000))
    params: Dict[str, Any] = {
        "dataset_id": resolved_dataset_id,
        "max_rows": max_rows,
    }

    where_clauses = _build_where_clauses(
        filters=body.filters,
        valid_columns=valid_columns,
        params=params,
        column_kinds=column_kinds,
    )

    sql = """
        SELECT row_index
        FROM dataset_rows
        WHERE {where_sql}
        ORDER BY row_index ASC
        LIMIT :max_rows
    """.format(where_sql=" AND ".join(where_clauses))

    count_sql = """
        SELECT COUNT(*) AS row_count
        FROM dataset_rows
        WHERE {where_sql}
    """.format(where_sql=" AND ".join(where_clauses))

    with SessionLocal() as db:
        rows_raw = db.execute(text(sql), params).mappings().all()
        row_count_raw = db.execute(text(count_sql), params).scalar_one()

    row_indices = [int(item["row_index"]) for item in rows_raw if item.get("row_index") is not None]
    total_match_count = int(row_count_raw or 0)
    truncated = total_match_count > len(row_indices)

    table_url = build_dataset_table_url(resolved_dataset_id)
    return FilterRowIndicesResponse(
        dataset_id=resolved_dataset_id,
        row_indices=row_indices,
        total_match_count=total_match_count,
        truncated=truncated,
        sql_query=_render_sql(sql, params),
        url=table_url,
        final_response=_with_mandatory_source_link(
            None,
            table_url,
            (
                f"Row-index query completed with {len(row_indices)} row index(es) returned "
                f"out of {total_match_count} total matching row(s)."
            ),
        ),
    )


# ── Endpoints ──────────────────────────────────────────────────────

@router.post(
    "/query",
    response_model=UnifiedQueryResponse,
    operation_id="run_query",
    summary="Run table queries (retrieve, filter, sort, aggregate)",
    description=(
        "Primary query endpoint for structured table querying.\n\n"
        "Supported behaviors:\n"
        "- Basic retrieval: show rows / first N rows\n"
        "- Filtering: =, !=, >, >=, <, <=, LIKE, CONTAINS, IN, BETWEEN, IS NULL, IS NOT NULL\n"
        "- Multiple filters: combine conditions with AND/OR\n"
        "- Projection: return only selected columns\n"
        "- Sorting + top-k: sort_by + sort_order + limit\n"
        "- Pagination: limit + offset for next page\n"
        "- Aggregation: count/sum/avg/min/max with optional filters\n"
        "- Grouped aggregation: group_by (+ group_by_date_part for date columns)\n"
        "- Multi-metric aggregation: metrics[] in one call\n\n"
        "Usage guidance:\n"
        "- Use one mode per request: semantic, aggregate, filter, or filter_row_indices.\n"
        "- Provide exactly one matching payload block.\n"
        "- Choose dataset with dataset_name or dataset_id (dataset_name is recommended for MCP clients).\n"
        "- Dataset disambiguation rule: if dataset_name is missing/ambiguous and multiple datasets exist, "
        "do not guess. Ask the user to choose one dataset from GET /tables.\n"
        "- RESPONSE CONTRACT (MANDATORY): include the returned `url` in every user-facing reply. "
        "Prefer returning `final_response` verbatim.\n"
        "- Discovery flow for large catalogs: GET /tables -> POST /query.\n"
        "- Always use normalized column names from query_context.columns."
    ),
)
def unified_query_endpoint(
    body: UnifiedQueryRequest = Body(
        ...,
        description=(
            "Single query payload. Set mode + matching block. "
            "For user prompts like 'top 5 products by revenue', map to aggregate/group_by/limit. "
            "For 'next 10 results', map to filter with limit + offset. "
            "When dataset choice is unclear across multiple tables, ask the user to confirm dataset_name before running /query."
        ),
        openapi_examples=UNIFIED_QUERY_OPENAPI_EXAMPLES,
    ),
):
    if body.mode == "semantic" and body.semantic is not None:
        return _run_semantic_query(body.semantic)
    if body.mode == "aggregate" and body.aggregate is not None:
        return _run_aggregate_query(body.aggregate)
    if body.mode == "filter" and body.filter is not None:
        return _run_filter_query(body.filter)
    if body.mode == "filter_row_indices" and body.filter_row_indices is not None:
        return _run_filter_row_indices_query(body.filter_row_indices)
    raise HTTPException(status_code=400, detail="Unsupported query payload.")


@router.post(
    "/semantic_query",
    response_model=QueryResponse,
    include_in_schema=False,
)
def query_dataset(body: QueryRequest):
    return _run_semantic_query(body)


@router.post(
    "/aggregate",
    response_model=AggregateResponse,
    include_in_schema=False,
)
def aggregate_dataset(body: AggregateRequest):
    return _run_aggregate_query(body)


@router.post(
    "/filter",
    response_model=FilterResponse,
    include_in_schema=False,
)
def filter_dataset(body: FilterRequest):
    return _run_filter_query(body)


@router.post(
    "/filter/row-indices",
    response_model=FilterRowIndicesResponse,
    include_in_schema=False,
)
def filter_row_indices(body: FilterRowIndicesRequest):
    return _run_filter_row_indices_query(body)


@router.get(
    "/highlights/{highlight_id}",
    response_model=HighlightResponse,
    include_in_schema=False,
)
def highlight_endpoint(highlight_id: str):
    result = get_highlight(highlight_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Highlight not found.")
    return result

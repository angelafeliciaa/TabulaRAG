import base64
import json
import os
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.attributes import flag_modified

from app.db import SessionLocal, engine
from app.index_jobs import clear_index_job, get_index_jobs
from app.indexing import upsert_dataset_row_index
from app.models import Dataset, DatasetColumn, DatasetRow, Folder, FolderGroupAccess, FolderPrivacy, UserGroupMembership, UserRole
from app.qdrant_client import delete_collection, get_collection_point_count
from app.normalization import (
    flatten_row_data_to_original,
    get_normalized_value,
    get_original_value,
    get_typed_value,
    infer_date_formats_for_columns,
    infer_measurement_columns,
    infer_money_columns,
    normalize_headers,
    normalize_row_obj,
    normalize_text_value,
    parse_date,
    parse_measurement,
    parse_money,
    parse_number,
    strip_internal_fields,
)
from app.name_guard import dataset_name_collision_key, normalize_dataset_name_or_raise
from app.auth import AuthUser, require_admin, require_auth

router = APIRouter()


def _scoped_enterprise_id(auth: AuthUser) -> Optional[int]:
    """API key may use None (all tenants). Interactive users must have an active workspace."""
    if auth.google_id == "api_key":
        return auth.enterprise_id
    if auth.enterprise_id is None:
        raise HTTPException(
            status_code=403,
            detail="Join or create a workspace to access tables.",
        )
    return auth.enterprise_id


PUBLIC_UI_BASE_URL = os.getenv("PUBLIC_UI_BASE_URL", "http://localhost:5173")
SLICE_RESPONSE_URL_REQUIREMENT_TEXT = (
    "MANDATORY: In every user-facing response, include the exact `url` value as the source link. "
    "This is required any time table data is returned."
)


class RenameRequest(BaseModel):
    name: str


class RowCellUpdateRequest(BaseModel):
    """Update one cell: `column` is the dataset normalized column name; `value` is the new raw text."""

    column: str
    value: str


class ColumnRenameRequest(BaseModel):
    column: str
    name: str


class DescriptionUpdateRequest(BaseModel):
    description: Optional[str] = None


ROW_EDIT_INFERENCE_SAMPLE_LIMIT = 2000


def _row_to_string_list(row_data: Dict[str, Any], headers: List[str]) -> List[str]:
    out: List[str] = []
    for h in headers:
        o = get_original_value(row_data, h)
        if o is None:
            out.append("")
        else:
            out.append(str(o))
    return out


def _inference_string_rows(
    db,
    dataset_id: int,
    headers: List[str],
    target_row_index: int,
    target_strings: List[str],
) -> List[List[str]]:
    rows_db = (
        db.execute(
            select(DatasetRow.row_index, DatasetRow.row_data)
            .where(DatasetRow.dataset_id == dataset_id)
            .order_by(DatasetRow.row_index)
            .limit(ROW_EDIT_INFERENCE_SAMPLE_LIMIT)
        )
        .all()
    )
    out: List[List[str]] = []
    replaced = False
    for ri, rd in rows_db:
        s = _row_to_string_list(_coerce_row_data_dict(rd), headers)
        if int(ri) == int(target_row_index):
            s = list(target_strings)
            replaced = True
        out.append(s)
    if not replaced:
        out.append(list(target_strings))
    return out


def _normalize_dataset_description(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    cleaned = "".join(
        ch for ch in str(raw) if ord(ch) >= 32 or ch in {"\n", "\t", "\r"}
    ).strip()
    if not cleaned:
        return None
    return cleaned[:100]


SEMANTIC_ROWS_BY_INDICES_MAX = 100


class RowsByIndicesRequest(BaseModel):
    """Fetch specific rows by row_index for semantic virtual table replay."""

    model_config = ConfigDict(extra="forbid")

    row_indices: List[int] = Field(..., min_length=1)
    columns: Optional[List[str]] = None

    @field_validator("row_indices")
    @classmethod
    def _non_negative(cls, value: List[int]) -> List[int]:
        for idx in value:
            if idx < 0:
                raise ValueError("row_indices must be non-negative")
        return value

    @model_validator(mode="after")
    def _cap_length(self) -> "RowsByIndicesRequest":
        if len(self.row_indices) > SEMANTIC_ROWS_BY_INDICES_MAX:
            raise ValueError(
                f"At most {SEMANTIC_ROWS_BY_INDICES_MAX} row_indices allowed."
            )
        return self


def _flatten_stored_row_data(row_data: Any) -> Dict[str, Any]:
    if isinstance(row_data, dict):
        return flatten_row_data_to_original(row_data)
    if isinstance(row_data, str):
        try:
            parsed = json.loads(row_data)
            if isinstance(parsed, str):
                parsed = json.loads(parsed)
            return flatten_row_data_to_original(parsed) if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


_QUERY_CONTEXT_TYPE_PRIORITY = {
    "unknown": 0,
    "text": 1,
    "number": 2,
    "date": 3,
    "measurement": 4,
    "money": 5,
}


def _slice_column_expr(column_name: str) -> str:
    """SQL expression for normalized value of a column from row_data (for ORDER BY in slice)."""
    escaped = column_name.replace("'", "''")
    if engine.dialect.name == "sqlite":
        json_key = column_name.replace("\\", "\\\\").replace('"', '\\"')
        return f"COALESCE(json_extract(row_data, '$.\"{json_key}\".normalized'), json_extract(row_data, '$.\"{json_key}\"'))"
    return f"COALESCE((row_data::jsonb -> '{escaped}') ->> 'normalized', row_data::jsonb ->> '{escaped}')"


def _slice_search_like_pattern(search: str) -> str:
    """Escape search string for use in a LIKE pattern (%, _, \\)."""
    s = (search or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{s}%"


def _slice_order_by_clause(sort_column: str, sort_direction: str) -> str:
    """ORDER BY clause for slice: numeric sort when value looks like a number, else text (so dates like 2022-01-04 sort correctly)."""
    col = _slice_column_expr(sort_column)
    dir_upper = sort_direction.upper()
    nulls = "NULLS LAST" if dir_upper == "ASC" else "NULLS FIRST"
    if engine.dialect.name == "sqlite":
        # SQLite: order by text only to avoid casting dates (e.g. 2022-01-04) to real
        return f"{col} {dir_upper}"
    # PostgreSQL: only cast to double when value matches numeric pattern; else NULL so we sort by text (dates, text)
    numeric_expr = f"(CASE WHEN TRIM({col}) ~ '^[-+]?[0-9]*\\.?[0-9]+$' THEN ({col}::double precision) ELSE NULL END)"
    return f"{numeric_expr} {dir_upper} {nulls}, {col} {dir_upper}"


def _build_dataset_table_url(dataset_id: int) -> str:
    return f"{PUBLIC_UI_BASE_URL}/tables/{dataset_id}"


def _build_slice_virtual_table_url(
    *,
    dataset_id: int,
    limit: int,
    offset: int,
    sort_column: Optional[str],
    sort_direction: str,
    result_title: str,
) -> str:
    payload = {
        "mode": "filter",
        "dataset_id": dataset_id,
        "filters": [],
        "columns": None,
        "sort_by": sort_column,
        "sort_order": sort_direction,
        "sort_as": "auto",
        "limit": max(1, int(limit)),
        "offset": max(0, int(offset)),
        "result_title": result_title,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"{PUBLIC_UI_BASE_URL}/tables/virtual?q={encoded}#q={encoded}"


def _with_source_link(final_response: Optional[str], url: str, fallback_message: str) -> str:
    base = (final_response or "").strip()
    if not base:
        base = fallback_message.strip()
    if url in base:
        return base
    if base:
        return f"{base}\nSource link: {url}"
    return f"Source link: {url}"


def _coerce_row_data_dict(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed: Any = json.loads(raw)
            if isinstance(parsed, str):
                parsed = json.loads(parsed)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _normalize_row_data(raw: Any) -> Dict[str, Any]:
    return strip_internal_fields(_coerce_row_data_dict(raw))


def _preview_cell_value(value: Any) -> Any:
    if isinstance(value, dict):
        if value.get("original") not in (None, ""):
            return value.get("original")
        if "normalized" in value:
            return value.get("normalized")
    return value


def _infer_value_type(value: Any) -> Optional[str]:
    text_value = normalize_text_value(value)
    if text_value is None:
        return None
    if parse_date(value) is not None:
        return "date"
    if parse_money(value) is not None:
        return "money"
    if parse_measurement(value) is not None:
        return "measurement"
    if parse_number(text_value) is not None:
        return "number"
    return "text"


def _finalize_column_type(type_counts: Dict[str, int]) -> str:
    observed = sum(type_counts.values())
    if observed <= 0:
        return "unknown"
    return max(
        type_counts.items(),
        key=lambda item: (item[1], _QUERY_CONTEXT_TYPE_PRIORITY.get(item[0], 0)),
    )[0]


def _infer_column_types_from_preview_rows(
    columns: List[Dict[str, Any]],
    sample_rows: List[Dict[str, Any]],
) -> Dict[str, str]:
    counts: Dict[str, Dict[str, int]] = {}
    for col in columns:
        normalized_name = str(col.get("normalized_name") or "").strip()
        if not normalized_name:
            continue
        counts[normalized_name] = {
            "text": 0,
            "number": 0,
            "date": 0,
            "money": 0,
            "measurement": 0,
        }

    for row in sample_rows:
        if not isinstance(row, dict):
            continue
        row_data = row.get("row_data")
        if not isinstance(row_data, dict):
            continue
        for normalized_name, score in counts.items():
            inferred = _infer_value_type(row_data.get(normalized_name))
            if inferred:
                score[inferred] += 1

    return {name: _finalize_column_type(score) for name, score in counts.items()}


def _infer_column_types_from_dataset_rows(
    column_names: List[str],
    raw_row_payloads: List[Any],
) -> Dict[str, str]:
    counts: Dict[str, Dict[str, int]] = {
        name: {"text": 0, "number": 0, "date": 0, "money": 0, "measurement": 0}
        for name in column_names
    }

    for payload in raw_row_payloads:
        row_data = _coerce_row_data_dict(payload)
        if not row_data:
            continue
        for column_name in column_names:
            typed_item = get_typed_value(row_data, column_name)
            typed_name = typed_item.get("type") if isinstance(typed_item, dict) else None
            if typed_name in {"date", "money", "measurement", "number"}:
                counts[column_name][typed_name] += 1
                continue
            inferred = _infer_value_type(get_normalized_value(row_data, column_name))
            if inferred:
                counts[column_name][inferred] += 1

    return {name: _finalize_column_type(score) for name, score in counts.items()}


def _enrich_columns_with_types(
    columns: List[Dict[str, Any]],
    fallback_types_by_name: Dict[str, str],
) -> List[Dict[str, Any]]:
    enriched: List[Dict[str, Any]] = []
    for col in columns:
        if not isinstance(col, dict):
            continue
        normalized_name = str(col.get("normalized_name") or "").strip()
        inferred_type = col.get("inferred_type")
        if inferred_type not in _QUERY_CONTEXT_TYPE_PRIORITY:
            inferred_type = fallback_types_by_name.get(normalized_name, "unknown")
        updated = dict(col)
        updated["inferred_type"] = inferred_type
        enriched.append(updated)
    return enriched


def _coerce_query_context(raw: Any, sample_rows: int) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    columns = raw.get("columns")
    rows = raw.get("sample_rows")
    if not isinstance(columns, list) or not isinstance(rows, list):
        return None
    sliced_rows = rows[:sample_rows]
    columns_payload: List[Dict[str, Any]] = [c for c in columns if isinstance(c, dict)]
    inferred_types = _infer_column_types_from_preview_rows(columns_payload, sliced_rows)
    return {
        "columns": _enrich_columns_with_types(columns_payload, inferred_types),
        "sample_rows": sliced_rows,
        "sample_row_count": len(sliced_rows),
    }


def _build_query_context_from_db(
    db,
    dataset_id: int,
    sample_rows: int,
) -> Dict[str, Any]:
    columns = (
        db.execute(
            select(DatasetColumn)
            .where(DatasetColumn.dataset_id == dataset_id)
            .order_by(DatasetColumn.column_index)
        )
        .scalars()
        .all()
    )
    rows = (
        db.execute(
            select(DatasetRow.row_index, DatasetRow.row_data)
            .where(DatasetRow.dataset_id == dataset_id)
            .order_by(DatasetRow.row_index)
            .limit(sample_rows)
        )
        .all()
    )
    inference_payloads = (
        db.execute(
            select(DatasetRow.row_data)
            .where(DatasetRow.dataset_id == dataset_id)
            .order_by(DatasetRow.row_index)
            .limit(max(sample_rows, 200))
        )
        .scalars()
        .all()
    )
    inferred_types = _infer_column_types_from_dataset_rows(
        [c.normalized_name for c in columns],
        inference_payloads,
    )
    sample = []
    for row_index, row_data in rows:
        normalized = _normalize_row_data(row_data)
        sample.append(
            {
                "row_index": int(row_index),
                "row_data": {
                    key: _preview_cell_value(value) for key, value in normalized.items()
                },
            }
        )
    return {
        "columns": [
            {
                "column_index": c.column_index,
                "original_name": c.original_name,
                "normalized_name": c.normalized_name,
                "inferred_type": inferred_types.get(c.normalized_name, "unknown"),
            }
            for c in columns
        ],
        "sample_rows": sample,
        "sample_row_count": len(sample),
    }


def _list_tables_payload(
    include_pending: bool,
    sample_rows: int,
    limit: Optional[int],
    enterprise_id: Optional[int] = None,
    role: Optional[UserRole] = None,
    user_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    is_admin = role in (UserRole.owner, UserRole.admin)
    with SessionLocal() as db:
        query = (
            select(Dataset)
            .options(joinedload(Dataset.folder))
            .order_by(Dataset.id.desc())
        )
        if not include_pending:
            query = query.where(Dataset.is_index_ready.is_(True))
        if enterprise_id is not None:
            query = query.where(Dataset.enterprise_id == enterprise_id)
        if not is_admin:
            # Compute protected folder IDs that have group restrictions
            # this querier cannot satisfy.
            blocked_folder_ids: List[int] = []
            if user_id is not None and enterprise_id is not None:
                protected_fids = db.execute(
                    select(Folder.id).where(
                        Folder.enterprise_id == enterprise_id,
                        Folder.privacy == FolderPrivacy.protected,
                    )
                ).scalars().all()
                for fid in protected_fids:
                    restriction_count = db.execute(
                        select(func.count(FolderGroupAccess.id))
                        .where(FolderGroupAccess.folder_id == fid)
                    ).scalar_one()
                    if restriction_count > 0:
                        user_ok = db.execute(
                            select(FolderGroupAccess.id)
                            .join(UserGroupMembership, UserGroupMembership.group_id == FolderGroupAccess.group_id)
                            .where(
                                FolderGroupAccess.folder_id == fid,
                                UserGroupMembership.user_id == user_id,
                            )
                            .limit(1)
                        ).scalar_one_or_none()
                        if user_ok is None:
                            blocked_folder_ids.append(fid)

            # Exclude private folders and any blocked protected folders.
            if blocked_folder_ids:
                query = query.outerjoin(Folder, Dataset.folder_id == Folder.id).where(
                    (Dataset.folder_id.is_(None)) | (
                        (Folder.privacy != FolderPrivacy.private) &
                        Dataset.folder_id.not_in(blocked_folder_ids)
                    )
                )
            else:
                # Unassigned datasets are always visible.
                query = query.outerjoin(Folder, Dataset.folder_id == Folder.id).where(
                    (Dataset.folder_id.is_(None)) | (Folder.privacy != FolderPrivacy.private)
                )
        if limit is not None:
            query = query.limit(limit)
        datasets = db.execute(query).scalars().unique().all()
        items = []
        for d in datasets:
            folder = d.folder
            item = {
                "dataset_id": d.id,
                "name": d.name,
                "description": d.description,
                "source_filename": d.source_filename,
                "row_count": d.row_count,
                "column_count": d.column_count,
                "created_at": d.created_at.isoformat(),
                "folder_id": folder.id if folder else None,
                "folder_name": folder.name if folder else None,
                "folder_privacy": _effective_privacy(d),
            }
            stored = _coerce_query_context(d.query_context, sample_rows)
            item["query_context"] = stored or _build_query_context_from_db(
                db,
                d.id,
                sample_rows,
            )
            items.append(item)
        return items


def _get_dataset_or_404(db, dataset_id: int, enterprise_id: Optional[int]) -> Dataset:
    stmt = (
        select(Dataset)
        .options(joinedload(Dataset.folder))
        .where(Dataset.id == dataset_id)
    )
    if enterprise_id is not None:
        stmt = stmt.where(Dataset.enterprise_id == enterprise_id)
    dataset = db.execute(stmt).scalar_one_or_none()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Table not found")
    return dataset


def _delete_collection_safe(dataset_id: int) -> None:
    try:
        delete_collection(dataset_id)
    except Exception:
        # Collection cleanup is best-effort and should not block API delete.
        pass


def _effective_privacy(dataset: Dataset) -> FolderPrivacy:
    """Unassigned datasets default to protected."""
    if dataset.folder_id is not None and dataset.folder is not None:
        return dataset.folder.privacy
    return FolderPrivacy.protected


def _assert_dataset_write(auth: AuthUser, dataset: Dataset) -> None:
    """Allow owners/admins always. Queriers may write only to datasets in a public folder."""
    if auth.role in (UserRole.owner, UserRole.admin):
        return
    if _effective_privacy(dataset) != FolderPrivacy.public:
        raise HTTPException(status_code=403, detail="Write access denied")


@router.get(
    "/tables",
    operation_id="list_tables",
    summary="List datasets for MCP discovery",
    description=(
        "Primary and only MCP discovery endpoint. Returns each dataset with metadata, "
        "column headers, and a 3-row query_context preview. Returns all ready datasets "
        "by default. Use optional limit to cap catalog size when needed. "
        "This endpoint is catalog-level discovery, while "
        "POST /query handles row-level pagination via filter.limit/filter.offset."
    ),
)
def list_tables(
    include_pending: bool = Query(
        default=False,
        description="Include datasets that are still indexing. Default false returns only ready datasets.",
    ),
    limit: Optional[int] = Query(
        default=None,
        ge=1,
        le=200,
        description="Optional cap on number of datasets returned. If omitted, returns all ready datasets.",
    ),
    current_user: AuthUser = Depends(require_auth),
):
    return _list_tables_payload(
        include_pending=include_pending,
        sample_rows=3,
        limit=limit,
        enterprise_id=_scoped_enterprise_id(current_user),
        role=current_user.role,
        user_id=current_user.id,
    )


def _get_cols_payload(dataset_id: int) -> dict:
    with SessionLocal() as db:
        dataset = db.execute(
            select(Dataset).where(Dataset.id == dataset_id)
        ).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="Dataset not found.")

        columns = (
            db.execute(
                select(DatasetColumn)
                .where(DatasetColumn.dataset_id == dataset_id)
                .order_by(DatasetColumn.column_index)
            )
            .scalars()
            .all()
        )

    return {
        "dataset_id": dataset_id,
        "columns": [
            {
                "column_index": c.column_index,
                "original_name": c.original_name,
                "normalized_name": c.normalized_name,
            }
            for c in columns
        ],
    }


@router.get(
    "/tables/{dataset_id}/columns",
    summary="List all columns for a dataset",
    description="Returns column names and indexes for a dataset. Always call this to understand the data structure and actual column names before querying.",
    include_in_schema=False,
)
def get_cols_for_dataset(dataset_id: int, current_user: AuthUser = Depends(require_auth)):
    with SessionLocal() as db:
        _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))
    return _get_cols_payload(dataset_id)


@router.post(
    "/tables/{dataset_id}/rows_by_indices",
    summary="Fetch dataset rows by row_index list",
    description=(
        "Returns full row payloads in the order of row_indices (for semantic search virtual table URLs). "
        f"At most {SEMANTIC_ROWS_BY_INDICES_MAX} indices per request."
    ),
    include_in_schema=False,
)
def post_rows_by_indices(dataset_id: int, body: RowsByIndicesRequest, current_user: AuthUser = Depends(require_auth)):
    ordered_indices = list(body.row_indices)
    unique_set = set(ordered_indices)
    with SessionLocal() as db:
        dataset = _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))

        columns_meta = (
            db.execute(
                select(DatasetColumn)
                .where(DatasetColumn.dataset_id == dataset_id)
                .order_by(DatasetColumn.column_index)
            )
            .scalars()
            .all()
        )
        ordered_column_names = [c.normalized_name for c in columns_meta]
        if not ordered_column_names:
            raise HTTPException(status_code=400, detail="Dataset has no columns.")
        highlight_column = ordered_column_names[0]

        valid_columns = set(ordered_column_names)
        projected: Optional[List[str]] = None
        if body.columns is not None:
            if len(body.columns) == 0:
                raise HTTPException(
                    status_code=400,
                    detail="columns, when set, must be a non-empty list.",
                )
            projected = [c for c in body.columns if c in valid_columns]
            invalid = [c for c in body.columns if c not in valid_columns]
            if invalid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unknown columns: {', '.join(invalid)}",
                )
            if not projected:
                raise HTTPException(
                    status_code=400,
                    detail="columns must list at least one valid column name.",
                )

        rows_db = (
            db.execute(
                select(DatasetRow).where(
                    DatasetRow.dataset_id == dataset_id,
                    DatasetRow.row_index.in_(unique_set),
                )
            )
            .scalars()
            .all()
        )

    by_index = {int(r.row_index): r for r in rows_db}
    missing = [i for i in unique_set if i not in by_index]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Row index(es) not found for this dataset: {', '.join(str(m) for m in sorted(missing)[:10])}"
            + ("…" if len(missing) > 10 else ""),
        )

    rows_out: List[Dict[str, Any]] = []
    for row_index in ordered_indices:
        row = by_index.get(row_index)
        if row is None:
            continue
        flattened = _flatten_stored_row_data(row.row_data)
        if projected is not None:
            row_data_out = {col: flattened.get(col) for col in projected}
        else:
            row_data_out = flattened
        rows_out.append(
            {
                "row_index": int(row_index),
                "row_data": row_data_out,
                "highlight_id": f"d{dataset_id}_r{int(row_index)}_{highlight_column}",
            }
        )

    in_list = ",".join(str(i) for i in sorted(unique_set))
    sql_display = (
        f"SELECT row_index, row_data FROM dataset_rows "
        f"WHERE dataset_id = {dataset_id} AND row_index IN ({in_list})"
    )

    return {
        "dataset_id": dataset_id,
        "rowsResult": rows_out,
        "row_count": len(rows_out),
        "sql_query": sql_display,
        "url": None,
    }


@router.get(
    "/tables/{dataset_id}/slice",
    operation_id="get_table_rows",
    summary="Get rows from one dataset",
    description=(
        "Returns paginated raw rows for a dataset. Supports optional search and sorting by a normalized column. "
        "Use this for previews or manual inspection."
    ),
)
def get_table_slice(
    dataset_id: int,
    offset: int = Query(
        default=0,
        description="Number of rows to skip. Use 0 to start from the beginning.",
    ),
    limit: int = Query(
        default=30, description="Number of rows to return. Default is 30."
    ),
    sort_column: Optional[str] = Query(
        default=None,
        description="Normalized column name to sort by. When set, rows are ordered by this column (multipage sort).",
    ),
    sort_direction: Optional[str] = Query(
        default="asc",
        description="Sort direction: 'asc' or 'desc'. Used only when sort_column is set.",
    ),
    search: Optional[str] = Query(
        default=None,
        description="When set, only rows where any cell (original or normalized value) contains this string (case-insensitive) are returned. Pagination applies to the filtered set.",
    ),
    current_user: AuthUser = Depends(require_auth),
):
    with SessionLocal() as db:
        dataset = _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))

        search_trimmed = search.strip() if search else None
        like_pattern = _slice_search_like_pattern(search_trimmed) if search_trimmed else None
        normalized_sort_direction = "asc"

        if engine.dialect.name == "sqlite":
            search_filter = (
                text("LOWER(CAST(row_data AS TEXT)) LIKE LOWER(:pattern) ESCAPE '\\'")
                if like_pattern is not None
                else None
            )
        else:
            search_filter = (
                text("LOWER(row_data::text) LIKE LOWER(:pattern) ESCAPE E'\\\\'")
                if like_pattern is not None
                else None
            )

        base_where = DatasetRow.dataset_id == dataset_id
        if search_filter is not None:
            base_query = select(DatasetRow).where(base_where).where(search_filter)
        else:
            base_query = select(DatasetRow).where(base_where)

        if search_trimmed and like_pattern is not None:
            count_query = (
                select(func.count())
                .select_from(DatasetRow)
                .where(base_where)
                .where(search_filter)
            )
            row_count = db.execute(count_query, {"pattern": like_pattern}).scalar() or 0
        else:
            row_count = dataset.row_count

        if sort_column and sort_direction:
            col_match = (
                db.execute(
                    select(DatasetColumn)
                    .where(DatasetColumn.dataset_id == dataset_id)
                    .where(DatasetColumn.normalized_name == sort_column)
                )
                .scalars()
                .first()
            )
            if not col_match:
                raise HTTPException(status_code=400, detail=f"Unknown sort_column: {sort_column}")
            dir_norm = sort_direction.lower() in ("desc", "descending") and "desc" or "asc"
            normalized_sort_direction = dir_norm
            order_sql = _slice_order_by_clause(sort_column, dir_norm)
            query = base_query.order_by(text(order_sql)).offset(offset).limit(limit)
            if like_pattern is not None:
                rows = db.execute(query, {"pattern": like_pattern}).scalars().all()
            else:
                rows = db.execute(query).scalars().all()
        else:
            query = base_query.order_by(DatasetRow.row_index).offset(offset).limit(limit)
            if like_pattern is not None:
                rows = db.execute(query, {"pattern": like_pattern}).scalars().all()
            else:
                rows = db.execute(query).scalars().all()

        columns = (
            db.execute(
                select(DatasetColumn)
                .where(DatasetColumn.dataset_id == dataset_id)
                .order_by(DatasetColumn.column_index)
            )
            .scalars()
            .all()
        )

        if rows:
            start_row_display = offset + 1
            end_row_display = offset + len(rows)
        else:
            start_row_display = 0
            end_row_display = 0
        slice_result_title = f"Table slice result: Rows {start_row_display}-{end_row_display}"

        if search_trimmed:
            table_url = _build_dataset_table_url(dataset_id)
        else:
            table_url = _build_slice_virtual_table_url(
                dataset_id=dataset_id,
                limit=limit,
                offset=offset,
                sort_column=sort_column,
                sort_direction=normalized_sort_direction,
                result_title=slice_result_title,
            )
        return {
            "dataset_id": dataset_id,
            "offset": offset,
            "limit": limit,
            "row_count": row_count,
            "column_count": dataset.column_count,
            "has_header": dataset.has_header,
            "rows": [
                {
                    "row_index": r.row_index,
                    "data": strip_internal_fields(r.row_data),
                }
                for r in rows
            ],
            "columns": [c.normalized_name for c in columns],
            "columns_meta": [
                {"original_name": c.original_name, "normalized_name": c.normalized_name}
                for c in columns
            ],
            "url": table_url,
            "final_response": _with_source_link(
                None,
                table_url,
                f"{slice_result_title}. Returned {len(rows)} row(s).",
            ),
            "response_instructions": SLICE_RESPONSE_URL_REQUIREMENT_TEXT,
        }


@router.get("/tables/index-status", include_in_schema=False)
def list_index_status(
    dataset_id: Optional[List[int]] = Query(default=None),
    current_user: AuthUser = Depends(require_auth),
):
    with SessionLocal() as db:
        query = select(Dataset.id, Dataset.row_count)
        if _scoped_enterprise_id(current_user) is not None:
            query = query.where(Dataset.enterprise_id == _scoped_enterprise_id(current_user))
        if dataset_id:
            query = query.where(Dataset.id.in_(dataset_id))
        dataset_rows = db.execute(query.order_by(Dataset.id.desc())).all()

    dataset_ids = [int(row[0]) for row in dataset_rows]
    tracked_statuses = get_index_jobs(dataset_ids)

    response = []
    for raw_dataset_id, raw_row_count in dataset_rows:
        current_dataset_id = int(raw_dataset_id)
        current_row_count = int(raw_row_count or 0)
        tracked = tracked_statuses.get(current_dataset_id)

        if tracked:
            item = dict(tracked)
            if int(item.get("total_rows", 0)) <= 0 and current_row_count > 0:
                item["total_rows"] = current_row_count
            response.append(item)
            continue

        point_count: Optional[int] = None
        try:
            point_count = get_collection_point_count(current_dataset_id)
        except Exception:
            point_count = None

        if (
            point_count is not None
            and current_row_count > 0
            and int(point_count) < current_row_count
        ):
            progress = float(point_count) / float(current_row_count) * 100.0
            response.append(
                {
                    "dataset_id": current_dataset_id,
                    "state": "indexing",
                    "progress": progress,
                    "processed_rows": int(point_count),
                    "total_rows": current_row_count,
                    "message": "Indexing vectors...",
                    "started_at": None,
                    "updated_at": None,
                    "finished_at": None,
                }
            )
            continue

        response.append(
            {
                "dataset_id": current_dataset_id,
                "state": "ready",
                "progress": 100.0,
                "processed_rows": current_row_count,
                "total_rows": current_row_count,
                "message": "Vector index is ready.",
                "started_at": None,
                "updated_at": None,
                "finished_at": None,
            }
        )

    return response


@router.delete("/tables/{dataset_id}", include_in_schema=False)
def delete_table(dataset_id: int, background_tasks: BackgroundTasks, current_user: AuthUser = Depends(require_auth)):
    with SessionLocal() as db:
        dataset = _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))
        _assert_dataset_write(current_user, dataset)
        # Use direct SQL deletes to avoid expensive ORM cascade object loading.
        db.execute(delete(DatasetRow).where(DatasetRow.dataset_id == dataset_id))
        db.execute(delete(DatasetColumn).where(DatasetColumn.dataset_id == dataset_id))
        db.execute(delete(Dataset).where(Dataset.id == dataset_id))
        db.commit()
    clear_index_job(dataset_id)
    background_tasks.add_task(_delete_collection_safe, dataset_id)
    return {"deleted": dataset_id}


@router.patch("/tables/{dataset_id}", include_in_schema=False)
def rename_table(dataset_id: int, body: RenameRequest, current_user: AuthUser = Depends(require_auth)):
    with SessionLocal() as db:
        dataset = _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))
        _assert_dataset_write(current_user, dataset)
        normalized_name = normalize_dataset_name_or_raise(body.name)
        target_key = dataset_name_collision_key(normalized_name)
        eid = _scoped_enterprise_id(current_user)
        ent_scope = Dataset.enterprise_id.is_(None) if eid is None else Dataset.enterprise_id == eid
        existing = db.execute(
            select(Dataset.id, Dataset.name).where(Dataset.id != dataset_id, ent_scope),
        ).all()
        conflict = next(
            (
                row
                for row in existing
                if row[1] is not None
                and dataset_name_collision_key(str(row[1])) == target_key
            ),
            None,
        )
        if conflict is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Dataset name '{normalized_name}' already exists in this workspace. "
                    "Use a unique table name."
                ),
            )
        dataset.name = normalized_name
        db.commit()
        return {"name": dataset.name}


@router.patch("/tables/{dataset_id}/rows/{row_index}", include_in_schema=False)
def patch_table_row_cell(
    dataset_id: int,
    row_index: int,
    body: RowCellUpdateRequest,
    current_user: AuthUser = Depends(require_auth),
):
    if row_index < 0:
        raise HTTPException(status_code=400, detail="row_index must be non-negative")

    column_key = (body.column or "").strip()
    if not column_key:
        raise HTTPException(status_code=400, detail="column is required")

    new_row_data: Optional[Dict[str, Any]] = None

    with SessionLocal() as db:
        dataset = _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))
        _assert_dataset_write(current_user, dataset)

        columns = (
            db.execute(
                select(DatasetColumn)
                .where(DatasetColumn.dataset_id == dataset_id)
                .order_by(DatasetColumn.column_index)
            )
            .scalars()
            .all()
        )
        headers = [c.normalized_name for c in columns]
        if column_key not in headers:
            raise HTTPException(status_code=400, detail=f"Unknown column: {column_key}")

        row = (
            db.execute(
                select(DatasetRow).where(
                    DatasetRow.dataset_id == dataset_id,
                    DatasetRow.row_index == row_index,
                )
            )
            .scalars()
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Row not found")

        current = _coerce_row_data_dict(row.row_data)
        target_strings = _row_to_string_list(current, headers)
        col_idx = headers.index(column_key)
        while len(target_strings) < len(headers):
            target_strings.append("")
        target_strings[col_idx] = body.value

        inference_rows = _inference_string_rows(
            db, dataset_id, headers, row_index, target_strings
        )
        date_format_by_column = infer_date_formats_for_columns(headers, inference_rows)
        money_columns = infer_money_columns(headers, inference_rows)
        measurement_columns = infer_measurement_columns(headers, inference_rows)

        new_row_data = normalize_row_obj(
            headers,
            target_strings,
            store_original=True,
            date_format_by_column=date_format_by_column,
            money_columns=money_columns,
            measurement_columns=measurement_columns,
        )
        row.row_data = new_row_data
        db.commit()

    try:
        upsert_dataset_row_index(dataset_id, row_index)
    except Exception:
        pass

    return {
        "dataset_id": dataset_id,
        "row_index": row_index,
        "column": column_key,
        "data": strip_internal_fields(new_row_data or {}),
    }


@router.patch("/tables/{dataset_id}/columns", include_in_schema=False)
def patch_table_column_name(dataset_id: int, body: ColumnRenameRequest, current_user: AuthUser = Depends(require_admin)):
    old_column = (body.column or "").strip()
    if not old_column:
        raise HTTPException(status_code=400, detail="column is required")

    requested_name = (body.name or "").strip()
    if not requested_name:
        raise HTTPException(status_code=400, detail="name is required")

    new_column = normalize_headers([requested_name])[0]

    with SessionLocal() as db:
        dataset = _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))

        columns = (
            db.execute(
                select(DatasetColumn)
                .where(DatasetColumn.dataset_id == dataset_id)
                .order_by(DatasetColumn.column_index)
            )
            .scalars()
            .all()
        )
        target = next((c for c in columns if c.normalized_name == old_column), None)
        if not target:
            raise HTTPException(status_code=400, detail=f"Unknown column: {old_column}")

        conflict = next(
            (c for c in columns if c.normalized_name == new_column and c.normalized_name != old_column),
            None,
        )
        if conflict:
            raise HTTPException(
                status_code=409,
                detail=f"Column '{new_column}' already exists.",
            )

        if old_column == new_column:
            target.original_name = requested_name
            db.commit()
            return {
                "dataset_id": dataset_id,
                "column": target.normalized_name,
                "original_name": target.original_name,
            }

        row_objs = (
            db.execute(
                select(DatasetRow)
                .where(DatasetRow.dataset_id == dataset_id)
                .order_by(DatasetRow.row_index)
            )
            .scalars()
            .all()
        )
        row_indices: List[int] = []
        for row in row_objs:
            row_data = _coerce_row_data_dict(row.row_data)
            if old_column in row_data:
                row_data[new_column] = row_data.pop(old_column)
            typed = row_data.get("__typed__")
            if isinstance(typed, dict) and old_column in typed:
                typed[new_column] = typed.pop(old_column)
            row.row_data = dict(row_data)
            flag_modified(row, "row_data")
            row_indices.append(int(row.row_index))

        target.normalized_name = new_column
        target.original_name = requested_name
        db.commit()

    for row_index in row_indices:
        try:
            upsert_dataset_row_index(dataset_id, row_index)
        except Exception:
            continue

    return {
        "dataset_id": dataset_id,
        "column": new_column,
        "original_name": requested_name,
    }


@router.patch("/tables/{dataset_id}/description", include_in_schema=False)
def patch_table_description(dataset_id: int, body: DescriptionUpdateRequest, current_user: AuthUser = Depends(require_auth)):
    normalized_description = _normalize_dataset_description(body.description)
    with SessionLocal() as db:
        dataset = _get_dataset_or_404(db, dataset_id, _scoped_enterprise_id(current_user))
        _assert_dataset_write(current_user, dataset)
        dataset.description = normalized_description
        db.commit()
        return {
            "dataset_id": dataset_id,
            "description": dataset.description,
        }

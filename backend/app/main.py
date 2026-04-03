import csv
import io
import json
import logging
import os
from typing import Iterable, List, Optional, Tuple
import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi_mcp.types import AuthConfig
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, insert, text, select
from contextlib import asynccontextmanager
from app.db import SessionLocal, engine
from app.dataset_state import (
    ensure_dataset_description_column,
    ensure_dataset_enterprise_id_column,
    ensure_dataset_folder_id_column,
    ensure_dataset_query_context_column,
    ensure_dataset_columns_normalized_columns,
    ensure_dataset_index_ready_column,
    ensure_enterprise_memberships_and_last_active,
    ensure_enterprise_name_non_unique,
    ensure_folders_table,
    ensure_mcp_access_tokens_table,
    ensure_querier_role_and_migrate_member,
    ensure_postgres_userrole_owner_enum,
    ensure_user_groups_tables,
    promote_legacy_admin_to_owner_per_enterprise,
    set_dataset_index_ready,
)
from app.index_jobs import (
    mark_index_job_error,
    mark_index_job_ready,
    queue_index_job,
    start_index_job,
    update_index_job,
)
from app.indexing import index_dataset
from app.index_worker import IndexWorker
from app.models import Base, Dataset, DatasetColumn, DatasetRow, EnterpriseMembership, Folder, FolderPrivacy, User, UserRole
from app.qdrant_client import get_collection_point_count
from fastapi_mcp import FastApiMCP
from app.mcp_connection import require_mcp_connection_auth
from app.routes_tables import router as tables_router
from app.routes_query import router as query_router
from app.routes_enterprises import router as enterprises_router
from app.routes_folders import router as folders_router
from app.normalization import (
    infer_date_formats_for_columns,
    infer_measurement_columns,
    infer_money_columns,
    normalize_headers,
    normalize_text_value,
    parse_date,
    parse_date_with_format,
    parse_measurement,
    parse_money,
    parse_number,
    normalize_row_obj,
)
from app.name_guard import dataset_name_collision_key, normalize_dataset_name_or_raise
from app.auth import (
    AuthUser,
    get_active_membership,
    GOOGLE_CLIENT_ID,
    mint_token_for_user,
    require_auth,
    exchange_google_code,
)


logger = logging.getLogger(__name__)
_index_worker: IndexWorker | None = None
INDEX_WORKER_CONCURRENCY = max(1, int(os.getenv("INDEX_WORKER_CONCURRENCY", "4")))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _index_worker
    Base.metadata.create_all(bind=engine)
    ensure_dataset_columns_normalized_columns()
    ensure_dataset_index_ready_column()
    ensure_dataset_description_column()
    ensure_dataset_query_context_column()
    ensure_dataset_enterprise_id_column()
    ensure_enterprise_memberships_and_last_active()
    ensure_enterprise_name_non_unique()
    ensure_querier_role_and_migrate_member()
    ensure_postgres_userrole_owner_enum()
    promote_legacy_admin_to_owner_per_enterprise()
    ensure_mcp_access_tokens_table()
    ensure_folders_table()
    ensure_dataset_folder_id_column()
    ensure_user_groups_tables()
    try:
        from app.embeddings import get_model
        get_model()
    except Exception:
        pass

    _index_worker = IndexWorker(
        _index_dataset_safe,
        worker_count=INDEX_WORKER_CONCURRENCY,
    )
    _index_worker.start()
    _resume_incomplete_index_jobs()

    yield


app = FastAPI(title="TabulaRAG API", lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(tables_router)
app.include_router(query_router)
app.include_router(enterprises_router)
app.include_router(folders_router)


@app.get("/health", include_in_schema=False)
def health():
    return {"status": "ok"}


@app.get("/health/deps", include_in_schema=False)
def health_deps():
    postgres_ok = False
    qdrant_ok = False

    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        postgres_ok = True
    except Exception:
        postgres_ok = False

    qdrant_url = os.getenv("QDRANT_URL", "http://qdrant:6333")
    try:
        response = httpx.get(f"{qdrant_url}/healthz", timeout=2.0)
        qdrant_ok = response.status_code == 200
    except Exception:
        qdrant_ok = False

    all_ok = postgres_ok and qdrant_ok
    return {
        "status": "ok" if all_ok else "degraded",
        "postgres": "ok" if postgres_ok else "down",
        "qdrant": "ok" if qdrant_ok else "down",
    }


# checks if file is a csv or tsv based on file extension, raises HTTPException if not
def validate_filename(filename: str) -> None:
    if not filename.lower().endswith((".csv", ".tsv")):
        raise HTTPException(
            status_code=400, detail="File must have a .csv or .tsv extension."
        )


def _normalize_dataset_description(raw: str | None) -> str | None:
    if raw is None:
        return None
    # Remove control characters while preserving common whitespace like spaces/newlines.
    cleaned = "".join(
        ch for ch in raw if ord(ch) >= 32 or ch in {"\n", "\t", "\r"}
    ).strip()
    if not cleaned:
        return None
    # Keep descriptions lightweight for storage/indexing.
    return cleaned[:100]


QUERY_CONTEXT_SAMPLE_ROWS = max(1, int(os.getenv("QUERY_CONTEXT_SAMPLE_ROWS", "5")))
QUERY_CONTEXT_TYPE_SCAN_ROWS = max(1, int(os.getenv("QUERY_CONTEXT_TYPE_SCAN_ROWS", "500")))

_QUERY_CONTEXT_TYPE_PRIORITY = {
    "unknown": 0,
    "text": 1,
    "number": 2,
    "date": 3,
    "measurement": 4,
    "money": 5,
}


def _infer_query_context_column_types(
    normalized_headers: List[str],
    rows: List[List[str]],
    *,
    date_format_by_column: Optional[dict] = None,
    money_columns: Optional[set] = None,
    measurement_columns: Optional[set] = None,
    max_rows: int = QUERY_CONTEXT_TYPE_SCAN_ROWS,
) -> dict[int, str]:
    scores = {
        i: {"text": 0, "number": 0, "date": 0, "money": 0, "measurement": 0}
        for i in range(len(normalized_headers))
    }

    for row in rows[:max_rows]:
        for i in range(len(normalized_headers)):
            raw = row[i] if i < len(row) else None
            text_value = normalize_text_value(raw)
            if text_value is None:
                continue

            fmt = (date_format_by_column or {}).get(i)
            if parse_date_with_format(raw, fmt) is not None:
                scores[i]["date"] += 1
                continue

            is_money_col = money_columns is not None and i in money_columns
            if parse_money(raw) is not None and (money_columns is None or is_money_col):
                scores[i]["money"] += 1
                continue
            if is_money_col and parse_number(text_value) is not None:
                scores[i]["money"] += 1
                continue

            is_measurement_col = (
                measurement_columns is not None and i in measurement_columns
            )
            if (
                is_measurement_col
                and parse_measurement(raw) is not None
            ):
                scores[i]["measurement"] += 1
                continue

            if parse_number(text_value) is not None:
                scores[i]["number"] += 1
                continue

            scores[i]["text"] += 1

    inferred: dict[int, str] = {}
    for i, type_scores in scores.items():
        observed = sum(type_scores.values())
        if observed <= 0:
            inferred[i] = "unknown"
            continue
        inferred[i] = max(
            type_scores.items(),
            key=lambda item: (item[1], _QUERY_CONTEXT_TYPE_PRIORITY.get(item[0], 0)),
        )[0]
    return inferred


def _build_dataset_query_context(
    raw_headers: List[str],
    normalized_headers: List[str],
    rows: List[List[str]],
    inferred_types_by_column: Optional[dict[int, str]] = None,
    sample_rows: int = QUERY_CONTEXT_SAMPLE_ROWS,
) -> dict:
    columns = [
        {
            "column_index": i,
            "original_name": (raw_headers[i] or None) if i < len(raw_headers) else None,
            "normalized_name": normalized_headers[i],
            "inferred_type": (inferred_types_by_column or {}).get(i, "unknown"),
        }
        for i in range(len(normalized_headers))
    ]

    preview_rows = []
    for row_index, row in enumerate(rows[:sample_rows]):
        row_data = {}
        for i, col_name in enumerate(normalized_headers):
            value = row[i] if i < len(row) else None
            row_data[col_name] = value if value not in ("", None) else None
        preview_rows.append({"row_index": row_index, "row_data": row_data})

    return {
        "columns": columns,
        "sample_rows": preview_rows,
        "sample_row_count": len(preview_rows),
    }


ROW_INSERT_BATCH_SIZE = int(os.getenv("ROW_INSERT_BATCH_SIZE", "20000"))
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
FILE_SNIFF_BYTES = int(os.getenv("FILE_SNIFF_BYTES", "65536"))
BLOCKED_UPLOAD_CONTENT_TYPE_PREFIXES = (
    "application/pdf",
    "application/zip",
    "application/x-zip",
    "application/x-rar",
    "application/octet-stream",
    "image/",
    "audio/",
    "video/",
)


def _detect_delimiter(filename: str | None) -> str:
    if filename and filename.lower().endswith(".tsv"):
        return "\t"
    if filename and filename.lower().endswith(".csv"):
        return ","
    return ","


def _cell_looks_like_data(cell: Optional[str]) -> bool:
    """True if the cell plausibly holds a typed data value (number, date, money), not a column label."""
    if cell is None:
        return False
    s = str(cell).strip()
    if not s:
        return False
    if parse_number(s) is not None:
        return True
    if parse_date(s) is not None:
        return True
    if parse_money(s) is not None:
        return True
    return False


def _infer_has_header_single_row(row: List[str]) -> bool:
    """
    Single-line file: ambiguous. Prefer header when the line looks like names only (no data-like
    cells), so header-only CSVs yield 0 data rows; otherwise treat as one data row (headerless).
    """
    cells = [(c or "").strip() for c in row]
    if not any(cells):
        return True
    if any(_cell_looks_like_data(c) for c in cells):
        return False
    return True


def _row_data_fraction(row: List[str]) -> float:
    cells = [(c or "").strip() for c in row]
    if not cells:
        return 0.0
    return sum(1 for c in cells if _cell_looks_like_data(c)) / len(cells)


def _infer_has_header_two_rows(row1: List[str], row2: List[str]) -> bool:
    """Compare first data line to second: header row is usually more label-like, less data-like."""
    n = max(len(row1), len(row2))
    r1 = [row1[i] if i < len(row1) else "" for i in range(n)]
    r2 = [row2[i] if i < len(row2) else "" for i in range(n)]
    header_votes = 0
    for j in range(n):
        a, b = r1[j], r2[j]
        da, db = _cell_looks_like_data(a), _cell_looks_like_data(b)
        if not da and db:
            header_votes += 1
    if header_votes >= 1:
        return True
    f1, f2 = _row_data_fraction(r1), _row_data_fraction(r2)
    # Ambiguous all-text files (no number/date/money signals in either row) are
    # usually standard CSVs with a header row (e.g. "city\\nParis\\n...").
    # Prefer header=True to keep name-based filtering/grouping stable.
    if f1 == 0.0 and f2 == 0.0:
        return True
    if f1 >= 0.4 and f2 >= 0.4 and abs(f1 - f2) <= 0.18:
        return False
    if f2 - f1 >= 0.18:
        return True
    return False


def _infer_has_header_from_sample(row1: List[str], row2: Optional[List[str]]) -> bool:
    if not row1:
        return True
    if row2 is None:
        return _infer_has_header_single_row(row1)
    return _infer_has_header_two_rows(row1, row2)


_HEADER_SNIFF_BYTES = 256 * 1024


def _peek_infer_has_header(upload: UploadFile) -> bool:
    """Read the first two CSV rows from a prefix of the file, then reset for _iter_rows."""
    validate_filename(upload.filename or "")
    _validate_upload_content(upload)
    delim = _detect_delimiter(upload.filename)
    if delim not in [",", "\t"]:
        raise HTTPException(status_code=400, detail="Delimiter must be comma or tab.")
    upload.file.seek(0)
    chunk = upload.file.read(_HEADER_SNIFF_BYTES)
    upload.file.seek(0)
    text = chunk.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    try:
        row1 = next(reader)
    except StopIteration:
        raise HTTPException(status_code=400, detail="Empty file.")
    row2 = next(reader, None)
    return _infer_has_header_from_sample(row1, row2)


def _validate_upload_content(upload: UploadFile) -> None:
    content_type = (upload.content_type or "").strip().lower()
    if any(content_type.startswith(prefix) for prefix in BLOCKED_UPLOAD_CONTENT_TYPE_PREFIXES):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content type '{content_type}' for CSV/TSV upload.",
        )

    # Enforce a hard file-size cap to reduce parser/DB abuse.
    upload.file.seek(0, io.SEEK_END)
    size = upload.file.tell()
    upload.file.seek(0)
    if size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File is too large. Maximum size is {MAX_UPLOAD_BYTES} bytes.",
        )

    head = upload.file.read(FILE_SNIFF_BYTES)
    upload.file.seek(0)

    # Empty-file handling remains in _iter_rows for existing behavior/messages.
    if not head:
        return

    if b"\x00" in head:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file appears to be binary. Please upload a valid CSV/TSV file.",
        )

    try:
        head.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file must be UTF-8 encoded text.",
        ) from exc


def _iter_rows(
    upload: UploadFile,
    has_header: bool,
) -> Tuple[List[str], List[str], Iterable[List[str]], str]:
    """Return (raw_headers, normalized_headers, rows_iter, delimiter)."""
    validate_filename(upload.filename or "")
    _validate_upload_content(upload)
    detected_delimiter = _detect_delimiter(upload.filename)
    if detected_delimiter not in [",", "\t"]:
        raise HTTPException(status_code=400, detail="Delimiter must be comma or tab.")

    text_stream = io.TextIOWrapper(upload.file, encoding="utf-8-sig", newline="")
    reader = csv.reader(text_stream, delimiter=detected_delimiter)

    try:
        first_row = next(reader)
    except StopIteration:
        raise HTTPException(status_code=400, detail="Empty file.")

    if has_header:
        raw_headers = [str(h) if h is not None else "" for i, h in enumerate(first_row)]
        normalized_headers = normalize_headers(first_row)
        rows_iter = reader
    else:
        raw_headers = [f"col_{i + 1}" for i in range(len(first_row))]
        normalized_headers = normalize_headers(raw_headers)

        def row_iter() -> Iterable[List[str]]:
            yield first_row
            yield from reader

        rows_iter = row_iter()

    return raw_headers, normalized_headers, rows_iter, detected_delimiter


def _build_row_obj(
    normalized_headers: List[str],
    row: List[str],
    date_format_by_column: Optional[dict] = None,
    money_columns: Optional[set] = None,
    measurement_columns: Optional[set] = None,
) -> dict:
    return normalize_row_obj(
        normalized_headers,
        row,
        store_original=True,
        date_format_by_column=date_format_by_column,
        money_columns=money_columns,
        measurement_columns=measurement_columns,
    )


def _insert_rows_postgres_copy(
    dataset_id: int,
    headers: List[str],
    rows_iter: Iterable[List[str]],
    date_format_by_column: Optional[dict] = None,
    money_columns: Optional[set] = None,
    measurement_columns: Optional[set] = None,
) -> int:
    """Fast path for PostgreSQL ingestion using COPY."""
    row_count = 0
    raw_connection = engine.raw_connection()
    try:
        with raw_connection.cursor() as cursor:
            with cursor.copy(
                "COPY dataset_rows (dataset_id, row_index, row_data) FROM STDIN"
            ) as copy:
                for row_index, row in enumerate(rows_iter):
                    row_obj = _build_row_obj(
                        headers,
                        row,
                        date_format_by_column,
                        money_columns,
                        measurement_columns,
                    )
                    copy.write_row(
                        (
                            dataset_id,
                            row_index,
                            json.dumps(row_obj, ensure_ascii=False),
                        )
                    )
                    row_count += 1
        raw_connection.commit()
        return row_count
    except Exception:
        raw_connection.rollback()
        raise
    finally:
        raw_connection.close()


def _insert_rows_batched(
    dataset_id: int,
    headers: List[str],
    rows_iter: Iterable[List[str]],
    date_format_by_column: Optional[dict] = None,
    money_columns: Optional[set] = None,
    measurement_columns: Optional[set] = None,
) -> int:
    """Fallback ingestion path (works for SQLite and non-Postgres)."""
    row_count = 0
    with SessionLocal() as db:
        batch_rows = []
        for row_index, row in enumerate(rows_iter):
            row_obj = _build_row_obj(
                headers,
                row,
                date_format_by_column,
                money_columns,
                measurement_columns,
            )
            batch_rows.append(
                {
                    "dataset_id": dataset_id,
                    "row_index": row_index,
                    "row_data": row_obj,
                }
            )
            if len(batch_rows) >= ROW_INSERT_BATCH_SIZE:
                db.execute(insert(DatasetRow), batch_rows)
                row_count += len(batch_rows)
                batch_rows.clear()

        if batch_rows:
            db.execute(insert(DatasetRow), batch_rows)
            row_count += len(batch_rows)
        db.commit()
    return row_count


def _index_dataset_safe(dataset_id: int, total_rows: int) -> None:
    start_index_job(dataset_id, total_rows)

    try:
        index_dataset(
            dataset_id,
            progress_callback=lambda processed, total: update_index_job(
                dataset_id, processed, total
            ),
            expected_total_rows=total_rows,
        )
        set_dataset_index_ready(dataset_id, True)
        mark_index_job_ready(dataset_id, total_rows)
    except Exception as exc:
        logger.exception("Indexing failed for dataset_id=%s", dataset_id)
        set_dataset_index_ready(dataset_id, False)
        mark_index_job_error(dataset_id, total_rows, f"Indexing failed: {exc}")


def _enqueue_index_job(dataset_id: int, total_rows: int) -> None:
    if _index_worker is None:
        _index_dataset_safe(dataset_id, total_rows)
        return
    _index_worker.enqueue(dataset_id, total_rows)


def _resume_incomplete_index_jobs() -> None:
    if _index_worker is None:
        return

    with SessionLocal() as db:
        datasets = db.execute(
            select(Dataset.id, Dataset.row_count, Dataset.is_index_ready).order_by(
                Dataset.id.asc()
            )
        ).all()

    for dataset_id_raw, row_count_raw, is_index_ready_raw in datasets:
        dataset_id = int(dataset_id_raw)
        row_count = int(row_count_raw or 0)
        is_index_ready = bool(is_index_ready_raw)
        if row_count <= 0:
            if not is_index_ready:
                set_dataset_index_ready(dataset_id, True)
            continue

        try:
            point_count = get_collection_point_count(dataset_id)
        except Exception:
            point_count = None

        if point_count is not None and int(point_count) >= row_count:
            if not is_index_ready:
                set_dataset_index_ready(dataset_id, True)
            continue
        if point_count is None and is_index_ready:
            continue

        if is_index_ready:
            set_dataset_index_ready(dataset_id, False)
        queue_index_job(dataset_id, row_count)
        _index_worker.enqueue(dataset_id, row_count)


@app.post("/auth/verify", include_in_schema=False)
def auth_verify(credentials: None = Depends(require_auth)) -> dict:
    return {"valid": True}


@app.get("/auth/google", include_in_schema=False)
def auth_google_redirect():
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Google OAuth not configured")
    return {"client_id": GOOGLE_CLIENT_ID}


@app.post("/auth/google/callback", include_in_schema=False)
async def auth_google_callback(body: dict):
    code = body.get("code")
    redirect_uri = body.get("redirect_uri")
    if not code or not redirect_uri:
        raise HTTPException(status_code=400, detail="Missing code or redirect_uri parameter")
    google_user = await exchange_google_code(code, redirect_uri)

    google_id = str(google_user["id"])
    login = google_user["email"]

    with SessionLocal() as db:
        user = db.execute(select(User).where(User.google_id == google_id)).scalar_one_or_none()
        if user is None:
            user = User(google_id=google_id, login=login)
            db.add(user)
        elif user.login != login:
            user.login = login
        db.commit()
        db.refresh(user)
        membership_count = db.execute(
            select(func.count()).where(EnterpriseMembership.user_id == user.id),
        ).scalar_one()
        m = get_active_membership(db, user)
        enterprise_id = m.enterprise_id if m else None
        role = m.role.value if m else None
        token = mint_token_for_user(db, user, google_user)

    return {
        "token": token,
        "user": {
            "login": google_user["email"],
            "name": google_user.get("name") or google_user["email"],
            "avatar_url": google_user.get("picture", ""),
            "role": role,
            "enterprise_id": enterprise_id,
        },
        "onboarding_required": membership_count == 0,
    }


@app.post("/ingest", include_in_schema=False)
def ingest_table(
    file: UploadFile = File(...),
    dataset_name: str | None = Form(None),
    dataset_description: str | None = Form(None),
    has_header: Optional[bool] = Form(None),
    folder_id: Optional[int] = Form(None),
    current_user: AuthUser = Depends(require_auth),
):
    if current_user.google_id != "api_key" and current_user.enterprise_id is None:
        raise HTTPException(
            status_code=403,
            detail="Join or create a workspace before uploading.",
        )

    # Queriers may only upload into a public folder.
    resolved_folder_id: Optional[int] = None
    if folder_id is not None:
        with SessionLocal() as db:
            stmt = select(Folder).where(Folder.id == folder_id)
            if current_user.enterprise_id is not None:
                stmt = stmt.where(Folder.enterprise_id == current_user.enterprise_id)
            folder = db.execute(stmt).scalar_one_or_none()
            if folder is None:
                raise HTTPException(status_code=404, detail="Folder not found")
            if current_user.role not in (UserRole.owner, UserRole.admin):
                if folder.privacy != FolderPrivacy.public:
                    raise HTTPException(
                        status_code=403,
                        detail="You can only upload into a public folder.",
                    )
            resolved_folder_id = folder.id
    elif current_user.role not in (UserRole.owner, UserRole.admin):
        raise HTTPException(
            status_code=403,
            detail="You must specify a public folder to upload into.",
        )

    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")
    validate_filename(file.filename)

    if has_header is None:
        has_header = _peek_infer_has_header(file)

    raw_headers, normalized_headers, rows_iter, detected_delimiter = _iter_rows(file, has_header)

    dataset_display_name = normalize_dataset_name_or_raise(
        dataset_name or os.path.splitext(file.filename)[0]
    )
    dataset_description_value = _normalize_dataset_description(dataset_description)
    rows_list = list(rows_iter)
    date_format_by_column = infer_date_formats_for_columns(normalized_headers, rows_list)
    money_columns = infer_money_columns(normalized_headers, rows_list)
    measurement_columns = infer_measurement_columns(normalized_headers, rows_list)
    inferred_types_by_column = _infer_query_context_column_types(
        normalized_headers=normalized_headers,
        rows=rows_list,
        date_format_by_column=date_format_by_column,
        money_columns=money_columns,
        measurement_columns=measurement_columns,
    )
    dataset_query_context = _build_dataset_query_context(
        raw_headers=raw_headers,
        normalized_headers=normalized_headers,
        rows=rows_list,
        inferred_types_by_column=inferred_types_by_column,
    )

    with SessionLocal() as db:
        requested_key = dataset_name_collision_key(dataset_display_name)
        eid = current_user.enterprise_id
        scope = (
            Dataset.enterprise_id.is_(None)
            if eid is None
            else Dataset.enterprise_id == eid
        )
        existing_rows = db.execute(select(Dataset.id, Dataset.name).where(scope)).all()
        conflicting = next(
            (
                (int(row[0]), str(row[1]))
                for row in existing_rows
                if row[1] is not None
                and dataset_name_collision_key(str(row[1])) == requested_key
            ),
            None,
        )
        if conflicting is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Dataset name '{dataset_display_name}' already exists in this workspace. "
                    "Use a unique table name."
                ),
            )

        dataset = Dataset(
            name=dataset_display_name,
            description=dataset_description_value,
            query_context=dataset_query_context,
            source_filename=file.filename,
            delimiter=detected_delimiter,
            has_header=has_header,
            column_count=len(normalized_headers),
            is_index_ready=False,
            enterprise_id=current_user.enterprise_id,
            folder_id=resolved_folder_id,
        )
        db.add(dataset)
        db.flush()

        db.add_all(
            [
                DatasetColumn(
                    dataset_id=dataset.id,
                    column_index=i,
                    original_name=raw_headers[i] or None,
                    normalized_name=normalized_headers[i],
                )
                for i in range(len(normalized_headers))
            ]
        )
        db.commit()
        dataset_id = dataset.id
        dataset_name_value = dataset.name
        dataset_description_value = dataset.description
        dataset_query_context_value = dataset.query_context
        dataset_delimiter = dataset.delimiter
        dataset_has_header = dataset.has_header

    row_count = 0
    try:
        if engine.dialect.name == "postgresql":
            row_count = _insert_rows_postgres_copy(
                dataset_id,
                normalized_headers,
                rows_list,
                date_format_by_column,
                money_columns,
                measurement_columns,
            )
        else:
            row_count = _insert_rows_batched(
                dataset_id,
                normalized_headers,
                rows_list,
                date_format_by_column,
                money_columns,
                measurement_columns,
            )
    except Exception as exc:
        with SessionLocal() as db:
            db.execute(text("DELETE FROM datasets WHERE id = :id"), {"id": dataset_id})
            db.commit()
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {exc}") from exc
    # update the row count for the dataset after all rows have been inserted, using a raw SQL UPDATE statement for efficiency
    # look at database in __init__.py
    with SessionLocal() as db:
        db.execute(
            text("UPDATE datasets SET row_count = :row_count WHERE id = :id"),
            {"row_count": row_count, "id": dataset_id},
        )
        db.commit()

    if row_count <= 0:
        set_dataset_index_ready(dataset_id, True)
        mark_index_job_ready(dataset_id, row_count)
    else:
        # Start vector indexing after response so uploads don't block on embedding/Qdrant upserts.
        queue_index_job(dataset_id, row_count)
        _enqueue_index_job(dataset_id, row_count)

    return {
        "dataset_id": dataset_id,
        "name": dataset_name_value,
        "rows": row_count,
        "columns": len(normalized_headers),
        "delimiter": dataset_delimiter,
        "has_header": dataset_has_header,
        "description": dataset_description_value,
        "query_context": dataset_query_context_value,
    }



mcp = FastApiMCP(
    app,
    name="TabulaRAG",
    auth_config=AuthConfig(dependencies=[Depends(require_mcp_connection_auth)]),
)
mcp.mount_http()
# Cursor and other clients often try SSE after streamable HTTP; without these routes they get 404
# and mis-parse FastAPI's {"detail":"Not Found"} as an OAuth error response.
mcp.mount_sse(mount_path="/sse")
mcp.mount_sse(mount_path="/mcp/sse")

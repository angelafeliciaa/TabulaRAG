import json
import math
import os
from typing import Any, Callable, Dict, List, Optional

from qdrant_client import models
from sqlalchemy import text

from app.db import SessionLocal
from app.embeddings import embed_texts, row_to_text
from app.qdrant_client import (
    collection_name,
    ensure_collection,
    finalize_collection_after_ingest,
    get_client,
    prepare_collection_for_bulk_ingest,
    upsert_vectors,
)

EMBED_BATCH_SIZE = max(64, int(os.getenv("INDEX_EMBED_BATCH_SIZE", "768")))
INDEX_EMBED_MIN_BATCH_SIZE = max(16, int(os.getenv("INDEX_EMBED_MIN_BATCH_SIZE", "64")))
INDEX_PROGRESS_TARGET_UPDATES = max(
    4, int(os.getenv("INDEX_PROGRESS_TARGET_UPDATES", "12"))
)


def _effective_embed_batch_size(total_rows: int) -> int:
    """Choose a batch size that keeps indexing throughput high while reporting progress steadily."""
    if total_rows <= 0:
        return EMBED_BATCH_SIZE
    target = int(math.ceil(total_rows / INDEX_PROGRESS_TARGET_UPDATES))
    return max(INDEX_EMBED_MIN_BATCH_SIZE, min(EMBED_BATCH_SIZE, target))


def _deserialize_row_data(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        data = json.loads(raw)
        if isinstance(data, str):
            data = json.loads(data)
        if isinstance(data, dict):
            return data
    return {}


def index_dataset(
    dataset_id: int,
    progress_callback: Optional[Callable[[int, int], None]] = None,
    expected_total_rows: Optional[int] = None,
) -> None:
    """Read all rows for a dataset from PG, embed them, and upsert into Qdrant.

    Uses row_index as the Qdrant point ID (unique per collection).
    Stores row_data and the serialized text in the Qdrant payload so that
    search results can be returned without an extra PG round-trip.
    """
    ensure_collection(dataset_id)
    prepare_collection_for_bulk_ingest(dataset_id)

    total_rows = max(expected_total_rows or 0, 0)
    if total_rows <= 0:
        with SessionLocal() as db:
            total_rows = int(
                db.execute(
                    text("SELECT row_count FROM datasets WHERE id = :dataset_id"),
                    {"dataset_id": dataset_id},
                ).scalar()
                or 0
            )

    effective_embed_batch_size = _effective_embed_batch_size(total_rows)

    processed_rows = 0
    if progress_callback:
        progress_callback(processed_rows, total_rows)

    batch_indices: List[int] = []
    batch_texts: List[str] = []
    batch_row_datas: List[Dict[str, Any]] = []

    def flush_batch() -> None:
        nonlocal processed_rows
        if not batch_texts:
            return
        vectors = embed_texts(batch_texts)
        points = [
            models.PointStruct(
                id=idx,
                vector=vec,
                payload={"row_data": rd, "text": txt},
            )
            for idx, vec, rd, txt in zip(
                batch_indices,
                vectors,
                batch_row_datas,
                batch_texts,
            )
        ]
        upsert_vectors(dataset_id, points)
        processed_rows += len(batch_texts)
        if progress_callback:
            progress_callback(processed_rows, total_rows)
        batch_indices.clear()
        batch_texts.clear()
        batch_row_datas.clear()

    with SessionLocal() as db:
        result = db.execute(
            text(
                "SELECT row_index, row_data FROM dataset_rows "
                "WHERE dataset_id = :dataset_id ORDER BY row_index"
            ).execution_options(stream_results=True),
            {"dataset_id": dataset_id},
        )

        for row in result:
            row_index = row[0]
            row_data = _deserialize_row_data(row[1])
            serialized = row_to_text(row_data)
            if not serialized:
                continue
            batch_indices.append(row_index)
            batch_texts.append(serialized)
            batch_row_datas.append(row_data)

            if len(batch_texts) >= effective_embed_batch_size:
                flush_batch()

    flush_batch()
    finalize_collection_after_ingest(dataset_id)


def _delete_dataset_row_point(dataset_id: int, row_index: int) -> None:
    """Remove one Qdrant point when a row no longer produces embeddable text (matches index_dataset skip)."""
    client = get_client()
    name = collection_name(dataset_id)
    if not client.collection_exists(name):
        return
    client.delete(
        collection_name=name,
        points_selector=models.PointIdsList(points=[row_index]),
        wait=False,
    )


def upsert_dataset_row_index(dataset_id: int, row_index: int) -> None:
    """Re-embed and upsert a single row after a cell edit (or delete the point if text is empty)."""
    ensure_collection(dataset_id)
    with SessionLocal() as db:
        row = db.execute(
            text(
                "SELECT row_data FROM dataset_rows WHERE dataset_id = :dataset_id AND row_index = :row_index"
            ),
            {"dataset_id": dataset_id, "row_index": row_index},
        ).first()
    if not row:
        return
    row_data = _deserialize_row_data(row[0])
    serialized = row_to_text(row_data)
    if not serialized:
        _delete_dataset_row_point(dataset_id, row_index)
        return
    vectors = embed_texts([serialized])
    points = [
        models.PointStruct(
            id=row_index,
            vector=vectors[0],
            payload={"row_data": row_data, "text": serialized},
        )
    ]
    upsert_vectors(dataset_id, points)

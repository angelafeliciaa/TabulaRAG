import io
import json

from sqlalchemy import text


def _ingest_dataset(client, dataset_name: str = "people_context"):
    csv_content = (
        b"name,city,age\n"
        b"Alice,London,30\n"
        b"Bob,Paris,25\n"
        b"Carol,Tokyo,40\n"
    )
    response = client.post(
        "/ingest",
        files={"file": ("people.csv", io.BytesIO(csv_content), "text/csv")},
        data={
            "dataset_name": dataset_name,
            "dataset_description": "People by city",
        },
    )
    assert response.status_code == 200
    return response.json()["dataset_id"]


def _find_dataset(payload, dataset_id: int):
    for item in payload:
        if int(item["dataset_id"]) == dataset_id:
            return item
    return None


def test_tables_includes_columns_and_sample_rows(client):
    dataset_id = _ingest_dataset(client)

    response = client.get("/tables")
    assert response.status_code == 200
    item = _find_dataset(response.json(), dataset_id)
    assert item is not None
    assert item["description"] == "People by city"
    assert "query_context" in item

    context = item["query_context"]
    assert isinstance(context["columns"], list)
    assert isinstance(context["sample_rows"], list)
    assert len(context["columns"]) == 3
    assert len(context["sample_rows"]) == 3
    assert int(context["sample_row_count"]) == 3
    assert context["columns"][0]["normalized_name"] == "name"
    assert context["sample_rows"][0]["row_data"]["city"] == "London"


def test_tables_supports_limit_and_offset_pagination(client):
    first_id = _ingest_dataset(client, dataset_name="people_one")
    second_id = _ingest_dataset(client, dataset_name="people_two")
    third_id = _ingest_dataset(client, dataset_name="people_three")

    page_one = client.get("/tables?limit=1&offset=0")
    page_two = client.get("/tables?limit=1&offset=1")

    assert page_one.status_code == 200
    assert page_two.status_code == 200

    first_page_items = page_one.json()
    second_page_items = page_two.json()
    assert len(first_page_items) == 1
    assert len(second_page_items) == 1
    assert int(first_page_items[0]["dataset_id"]) == third_id
    assert int(second_page_items[0]["dataset_id"]) == second_id
    assert first_id not in [int(item["dataset_id"]) for item in first_page_items]


def test_tables_rejects_invalid_limit(client):
    _ingest_dataset(client)
    response = client.get("/tables?limit=0")
    assert response.status_code == 422


def test_ingest_stores_query_context_in_db(client, test_engine):
    dataset_id = _ingest_dataset(client)
    with test_engine.connect() as conn:
        row = conn.execute(
            text("SELECT query_context FROM datasets WHERE id = :id"),
            {"id": dataset_id},
        ).fetchone()

    assert row is not None
    raw = row.query_context
    parsed = json.loads(raw) if isinstance(raw, str) else raw
    assert isinstance(parsed, dict)
    assert "columns" in parsed
    assert "sample_rows" in parsed
    assert parsed["columns"][0]["normalized_name"] == "name"


def test_tables_fallback_when_stored_context_missing(client, test_engine):
    dataset_id = _ingest_dataset(client)
    with test_engine.connect() as conn:
        conn.execute(
            text("UPDATE datasets SET query_context = NULL WHERE id = :id"),
            {"id": dataset_id},
        )
        conn.commit()

    response = client.get("/tables")
    assert response.status_code == 200
    item = _find_dataset(response.json(), dataset_id)
    assert item is not None
    assert len(item["query_context"]["sample_rows"]) == 3
    assert item["query_context"]["columns"][1]["normalized_name"] == "city"


def test_legacy_context_endpoints_are_removed(client):
    dataset_id = _ingest_dataset(client)

    legacy_bulk = client.get("/tables/context")
    legacy_single = client.get(f"/tables/{dataset_id}/context")

    assert legacy_bulk.status_code in {404, 405}
    assert legacy_single.status_code in {404, 405}

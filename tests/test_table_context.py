import base64
import io
import json
from urllib.parse import parse_qs, urlparse

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


def _column_by_name(columns, normalized_name: str):
    for col in columns:
        if col.get("normalized_name") == normalized_name:
            return col
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
    assert _column_by_name(context["columns"], "name")["inferred_type"] == "text"
    assert _column_by_name(context["columns"], "age")["inferred_type"] == "number"
    assert context["sample_rows"][0]["row_data"]["city"] == "London"


def test_tables_returns_all_datasets_by_default(client):
    first_id = _ingest_dataset(client, dataset_name="people_one")
    second_id = _ingest_dataset(client, dataset_name="people_two")
    third_id = _ingest_dataset(client, dataset_name="people_three")

    response = client.get("/tables")
    assert response.status_code == 200
    ids = [int(item["dataset_id"]) for item in response.json()]
    assert third_id in ids
    assert second_id in ids
    assert first_id in ids


def test_tables_supports_optional_limit(client):
    _ingest_dataset(client, dataset_name="people_one")
    _ingest_dataset(client, dataset_name="people_two")

    response = client.get("/tables?limit=1")
    assert response.status_code == 200
    assert len(response.json()) == 1


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
    assert _column_by_name(item["query_context"]["columns"], "age")["inferred_type"] == "number"


def test_tables_infers_types_for_date_money_and_number(client):
    csv_content = (
        b"sale_date,amount,units\n"
        b"2024-01-10,$12.50,3\n"
        b"2024-02-01,$15.00,4\n"
    )
    response = client.post(
        "/ingest",
        files={"file": ("typed.csv", io.BytesIO(csv_content), "text/csv")},
        data={"dataset_name": "typed_table"},
    )
    assert response.status_code == 200
    dataset_id = response.json()["dataset_id"]

    tables = client.get("/tables")
    assert tables.status_code == 200
    item = _find_dataset(tables.json(), dataset_id)
    assert item is not None
    columns = item["query_context"]["columns"]
    assert _column_by_name(columns, "sale_date")["inferred_type"] == "date"
    assert _column_by_name(columns, "amount")["inferred_type"] == "money"
    assert _column_by_name(columns, "units")["inferred_type"] == "number"


def test_legacy_context_endpoints_are_removed(client):
    dataset_id = _ingest_dataset(client)

    legacy_bulk = client.get("/tables/context")
    legacy_single = client.get(f"/tables/{dataset_id}/context")

    assert legacy_bulk.status_code in {404, 405}
    assert legacy_single.status_code in {404, 405}


def test_table_slice_includes_source_link_contract(client):
    dataset_id = _ingest_dataset(client)

    response = client.get(f"/tables/{dataset_id}/slice?offset=0&limit=2")
    assert response.status_code == 200

    body = response.json()
    assert body["dataset_id"] == dataset_id
    assert body["url"].startswith("http://localhost:5173/tables/virtual?q=")
    parsed = urlparse(body["url"])
    encoded = parse_qs(parsed.query).get("q", [None])[0]
    assert encoded is not None
    pad = "=" * (-len(encoded) % 4)
    payload = json.loads(
        base64.urlsafe_b64decode((encoded + pad).encode("utf-8")).decode("utf-8")
    )
    assert payload["mode"] == "filter"
    assert payload["dataset_id"] == dataset_id
    assert payload["filters"] == []
    assert payload["limit"] == 2
    assert payload["offset"] == 0
    assert payload["result_title"] == "Table slice result: Rows 1-2"
    assert isinstance(body.get("final_response"), str)
    assert "Table slice result: Rows 1-2" in body["final_response"]
    assert body["url"] in body["final_response"]
    assert isinstance(body.get("response_instructions"), str)


def test_table_slice_search_link_falls_back_to_table_url(client):
    dataset_id = _ingest_dataset(client)

    response = client.get(f"/tables/{dataset_id}/slice?offset=0&limit=2&search=London")
    assert response.status_code == 200
    body = response.json()
    assert body["url"] == f"http://localhost:5173/tables/{dataset_id}"

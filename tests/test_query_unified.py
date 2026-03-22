from unittest.mock import patch


def _ingest_people(client):
    csv_content = b"name,city,age\nAlice,London,30\nBob,Paris,25\n"
    resp = client.post(
        "/ingest",
        files={"file": ("people.csv", csv_content, "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["dataset_id"]


def _ingest_sales(client):
    csv_content = (
        b"Sales Person,Boxes Shipped,Country\n"
        b"Karlen McCaffrey,778,Australia\n"
        b"Alice,100,UK\n"
        b"Bob,300,Canada\n"
        b"Bob,50,Canada\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("sales.csv", csv_content, "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["dataset_id"]


def test_unified_query_semantic_explicit_and_inferred_match(client):
    dataset_id = _ingest_people(client)
    payload = {"question": "Who lives in London?", "dataset_id": dataset_id}
    mock_hits = [
        {
            "id": 0,
            "score": 0.92,
            "payload": {
                "row_data": {"name": "Alice", "city": "London", "age": "30"},
                "text": "name: Alice | city: London | age: 30",
            },
        },
    ]

    with patch("app.retrieval.search_vectors", return_value=mock_hits), patch(
        "app.retrieval.embed_texts", return_value=[[0.1] * 384]
    ):
        explicit_resp = client.post(
            "/query",
            json={"mode": "semantic", "semantic": payload},
        )
        inferred_resp = client.post("/query", json={"semantic": payload})

    assert explicit_resp.status_code == 200
    assert inferred_resp.status_code == 200
    assert explicit_resp.json() == inferred_resp.json()
    assert explicit_resp.json()["url"].startswith("http")


def test_unified_query_aggregate_explicit_and_inferred_match(client):
    dataset_id = _ingest_sales(client)
    payload = {
        "dataset_id": dataset_id,
        "operation": "sum",
        "metric_column": "Boxes Shipped",
        "group_by": "Sales Person",
        "limit": 50,
    }

    explicit_resp = client.post(
        "/query",
        json={"mode": "aggregate", "aggregate": payload},
    )
    inferred_resp = client.post("/query", json={"aggregate": payload})

    assert explicit_resp.status_code == 200
    assert inferred_resp.status_code == 200
    assert explicit_resp.json() == inferred_resp.json()


def test_unified_query_filter_explicit_and_inferred_match(client):
    dataset_id = _ingest_people(client)
    payload = {
        "dataset_id": dataset_id,
        "filters": [{"column": "city", "operator": "=", "value": "London"}],
        "limit": 10,
        "offset": 0,
    }

    explicit_resp = client.post(
        "/query",
        json={"mode": "filter", "filter": payload},
    )
    inferred_resp = client.post("/query", json={"filter": payload})

    assert explicit_resp.status_code == 200
    assert inferred_resp.status_code == 200
    assert explicit_resp.json() == inferred_resp.json()
    assert explicit_resp.json()["url"].startswith("http")


def test_unified_query_filter_row_indices_explicit_and_inferred_match(client):
    dataset_id = _ingest_people(client)
    payload = {
        "dataset_id": dataset_id,
        "filters": [{"column": "city", "operator": "=", "value": "London"}],
        "max_rows": 1000,
    }

    explicit_resp = client.post(
        "/query",
        json={"mode": "filter_row_indices", "filter_row_indices": payload},
    )
    inferred_resp = client.post("/query", json={"filter_row_indices": payload})

    assert explicit_resp.status_code == 200
    assert inferred_resp.status_code == 200
    assert explicit_resp.json() == inferred_resp.json()
    assert explicit_resp.json()["url"].startswith("http")


def test_query_table_alias_matches_query(client):
    dataset_id = _ingest_people(client)
    payload = {
        "mode": "filter",
        "filter": {
            "dataset_id": dataset_id,
            "filters": [{"column": "city", "operator": "=", "value": "London"}],
            "limit": 10,
            "offset": 0,
        },
    }
    resp_query = client.post("/query", json=payload)
    resp_alias = client.post("/query_table", json=payload)

    assert resp_query.status_code == 200
    assert resp_alias.status_code == 200
    assert resp_alias.json() == resp_query.json()


def test_unified_query_requires_one_payload(client):
    resp = client.post("/query", json={"mode": "filter"})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert any(item.get("type") == "value_error" for item in detail)


def test_unified_query_mode_payload_mismatch(client):
    dataset_id = _ingest_people(client)
    resp = client.post(
        "/query",
        json={
            "mode": "aggregate",
            "filter": {
                "dataset_id": dataset_id,
                "filters": [{"column": "city", "operator": "=", "value": "London"}],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert any(item.get("type") == "value_error" for item in detail)


def test_openapi_exposes_unified_query_only(client):
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    paths = resp.json().get("paths", {})
    assert "/query" in paths
    assert "/query_table" not in paths
    assert "/semantic_query" not in paths
    assert "/aggregate" not in paths
    assert "/filter" not in paths
    assert "/filter/row-indices" not in paths

    post_query = paths["/query"]["post"]
    assert post_query.get("operationId") == "run_query"
    description = (post_query.get("description") or "").lower()
    assert "filtering" in description
    assert "pagination" in description
    assert "contains" in description
    request_body = post_query["requestBody"]["content"]["application/json"]
    assert "examples" in request_body
    assert "semantic_question" in request_body["examples"]
    assert "filter_top_k_sorted" in request_body["examples"]
    schema = request_body["schema"]
    assert "$ref" in schema


def test_unified_query_infers_mode_from_single_payload(client):
    dataset_id = _ingest_people(client)
    payload = {
        "aggregate": {
            "dataset_id": dataset_id,
            "operation": "count",
            "group_by": "city",
            "filters": None,
        }
    }
    resp = client.post("/query", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["dataset_id"] == dataset_id
    assert body["group_by_column"] == "city"


def test_unified_query_accepts_legacy_aggregate_shape(client):
    dataset_id = _ingest_people(client)
    resp = client.post(
        "/query",
        json={
            "aggregate": {
                "aggregate": {
                    "dataset_id": dataset_id,
                    "operation": {
                        "group_by": ["city"],
                        "metrics": [{"column": "age", "agg": "sum"}],
                    },
                }
            }
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dataset_id"] == dataset_id
    assert body["group_by_column"] == "city"
    assert body["metric_column"] == "age"


def test_unified_query_filter_resolves_dataset_name(client):
    dataset_id = _ingest_people(client)
    resp = client.post(
        "/query",
        json={
            "mode": "filter",
            "filter": {
                "dataset_name": "people",
                "filters": [{"column": "city", "operator": "=", "value": "London"}],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dataset_id"] == dataset_id
    assert body["row_count"] == 1


def test_unified_query_aggregate_resolves_dataset_name(client):
    dataset_id = _ingest_sales(client)
    resp = client.post(
        "/query",
        json={
            "mode": "aggregate",
            "aggregate": {
                "dataset_name": "sales",
                "operation": "count",
                "group_by": "Sales Person",
                "limit": 50,
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dataset_id"] == dataset_id
    assert body["group_by_column"] == "Sales Person"


def test_unified_query_filter_missing_dataset_prompts_with_guidance(client):
    _ingest_people(client)
    _ingest_sales(client)
    resp = client.post(
        "/query",
        json={
            "mode": "filter",
            "filter": {
                "filters": [{"column": "city", "operator": "=", "value": "London"}],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "dataset_name" in detail["message"]
    assert "guidance" in detail
    assert isinstance(detail.get("available_tables"), list)


def test_unified_query_filter_auto_resolves_single_dataset_without_name(client):
    dataset_id = _ingest_people(client)
    resp = client.post(
        "/query",
        json={
            "mode": "filter",
            "filter": {
                "filters": [{"column": "city", "operator": "=", "value": "London"}],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dataset_id"] == dataset_id
    assert body["row_count"] == 1


def test_unified_query_filter_dataset_id_works_when_multiple_by_default(client):
    people_id = _ingest_people(client)
    _ingest_sales(client)
    resp = client.post(
        "/query",
        json={
            "mode": "filter",
            "filter": {
                "dataset_id": people_id,
                "filters": [{"column": "city", "operator": "=", "value": "London"}],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dataset_id"] == people_id
    assert body["row_count"] == 1


def test_unified_query_filter_dataset_id_requires_name_when_multiple_when_strict(client, monkeypatch):
    people_id = _ingest_people(client)
    _ingest_sales(client)
    monkeypatch.setenv("QUERY_REQUIRE_DATASET_NAME_WHEN_MULTIPLE", "true")
    resp = client.post(
        "/query",
        json={
            "mode": "filter",
            "filter": {
                "dataset_id": people_id,
                "filters": [{"column": "city", "operator": "=", "value": "London"}],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "dataset_name" in detail["message"]


def test_unified_query_filter_dataset_id_and_name_mismatch(client):
    people_id = _ingest_people(client)
    _ingest_sales(client)
    resp = client.post(
        "/query",
        json={
            "mode": "filter",
            "filter": {
                "dataset_id": people_id,
                "dataset_name": "sales",
                "filters": [{"column": "city", "operator": "=", "value": "London"}],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "does not match dataset_name" in detail["message"]


import base64
import json
from urllib.parse import parse_qs, urlparse


def _ingest(client):
    csv_content = b"name,city,age\nAlice,London,30\nBob,Paris,25\n"
    resp = client.post(
        "/ingest",
        files={"file": ("people.csv", csv_content, "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["dataset_id"]


def _query_filter(client, payload):
    return client.post(
        "/query",
        json={"mode": "filter", "filter": payload},
    )


def _query_filter_row_indices(client, payload):
    return client.post(
        "/query",
        json={"mode": "filter_row_indices", "filter_row_indices": payload},
    )


def test_filter_rows_success(client):
    dataset_id = _ingest(client)

    resp = _query_filter(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [{"column": "city", "operator": "=", "value": "London"}],
            "limit": 10,
            "offset": 0,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["dataset_id"] == dataset_id
    assert data["row_count"] == 1
    assert len(data["rowsResult"]) == 1
    assert data["rowsResult"][0]["row_data"]["city"] == "London"
    assert data["rowsResult"][0]["highlight_id"] == f"d{dataset_id}_r0_city"
    assert data["url"].startswith("http://localhost:5173/tables/virtual?q=")


def test_filter_between_numeric(client):
    csv_content = (
        b"name,number_of_rooms\n"
        b"A,2\n"
        b"B,3\n"
        b"C,5\n"
        b"D,7\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("rooms.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_filter(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [{"column": "number_of_rooms", "operator": "BETWEEN", "value": "3,6"}],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["row_count"] == 2
    names = [row["row_data"]["name"] for row in data["rowsResult"]]
    assert names == ["B", "C"]


def test_filter_not_like(client):
    csv_content = (
        b"city\n"
        b"Paris\n"
        b"Tokyo\n"
        b"Berlin\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("cities.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_filter(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [{"column": "city", "operator": "NOT LIKE", "value": "%is"}],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    cities = [row["row_data"]["city"] for row in data["rowsResult"]]
    assert cities == ["Tokyo", "Berlin"]


def test_filter_or_conditions(client):
    csv_content = (
        b"city,year_listed\n"
        b"Paris,2010\n"
        b"London,2014\n"
        b"Rome,2008\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("listings.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_filter(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [
                {"column": "city", "operator": "=", "value": "Paris"},
                {
                    "column": "year_listed",
                    "operator": ">",
                    "value": "2012",
                    "logical_operator": "OR",
                },
            ],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    cities = [row["row_data"]["city"] for row in data["rowsResult"]]
    assert cities == ["Paris", "London"]


def test_filter_dataset_not_found(client):
    resp = _query_filter(
        client,
        {
            "dataset_id": 999999,
            "filters": [{"column": "city", "operator": "=", "value": "London"}],
        },
    )
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


def test_filter_accepts_null_filters(client):
    dataset_id = _ingest(client)

    resp = _query_filter(
        client,
        {
            "dataset_id": dataset_id,
            "filters": None,
            "limit": 10,
            "offset": 0,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["dataset_id"] == dataset_id
    assert data["row_count"] == 2


def test_filter_virtual_url_uses_list_filters_for_compatibility(client):
    dataset_id = _ingest(client)

    resp = _query_filter(
        client,
        {
            "dataset_id": dataset_id,
            "filters": None,
            "limit": 3,
            "offset": 1,
        },
    )
    assert resp.status_code == 200
    url = resp.json()["url"]
    assert isinstance(url, str)

    parsed = urlparse(url)
    encoded = parse_qs(parsed.query).get("q", [None])[0]
    assert encoded is not None
    pad = "=" * (-len(encoded) % 4)
    payload = json.loads(
        base64.urlsafe_b64decode((encoded + pad).encode("utf-8")).decode("utf-8")
    )
    assert payload["filters"] == []
    assert payload["limit"] == 3
    assert payload["offset"] == 1

    replay_resp = _query_filter(client, payload)
    assert replay_resp.status_code == 200


def test_filter_virtual_url_preserves_sort_and_limit(client):
    dataset_id = _ingest(client)

    resp = _query_filter(
        client,
        {
            "dataset_id": dataset_id,
            "filters": None,
            "sort_by": "age",
            "sort_order": "desc",
            "limit": 1,
            "offset": 0,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["rowsResult"]) == 1
    assert body["rowsResult"][0]["row_data"]["name"] == "Alice"

    parsed = urlparse(body["url"])
    encoded = parse_qs(parsed.query).get("q", [None])[0]
    assert encoded is not None
    pad = "=" * (-len(encoded) % 4)
    payload = json.loads(
        base64.urlsafe_b64decode((encoded + pad).encode("utf-8")).decode("utf-8")
    )
    assert payload["sort_by"] == "age"
    assert payload["sort_order"] == "desc"
    assert payload["limit"] == 1
    assert payload["offset"] == 0

    replay_resp = _query_filter(client, payload)
    assert replay_resp.status_code == 200
    replay_rows = replay_resp.json()["rowsResult"]
    assert len(replay_rows) == 1
    assert replay_rows[0]["row_data"]["name"] == "Alice"


def test_filter_row_indices_success(client):
    dataset_id = _ingest(client)

    resp = _query_filter_row_indices(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [{"column": "city", "operator": "=", "value": "London"}],
            "max_rows": 1000,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["dataset_id"] == dataset_id
    assert data["row_indices"] == [0]
    assert data["total_match_count"] == 1
    assert data["truncated"] is False


def test_filter_row_indices_or_conditions(client):
    csv_content = (
        b"city,year_listed\n"
        b"Paris,2010\n"
        b"London,2014\n"
        b"Rome,2008\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("listings.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_filter_row_indices(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [
                {"column": "city", "operator": "=", "value": "Paris"},
                {
                    "column": "year_listed",
                    "operator": ">",
                    "value": "2012",
                    "logical_operator": "OR",
                },
            ],
            "max_rows": 1000,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["row_indices"] == [0, 1]
    assert data["total_match_count"] == 2
    assert data["truncated"] is False


def test_filter_row_indices_truncated(client):
    csv_content = (
        b"name,city\n"
        b"A,London\n"
        b"B,London\n"
        b"C,London\n"
        b"D,Paris\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("people.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_filter_row_indices(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [{"column": "city", "operator": "=", "value": "London"}],
            "max_rows": 2,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["row_indices"] == [0, 1]
    assert data["total_match_count"] == 3
    assert data["truncated"] is True


def test_filter_row_indices_is_null(client):
    csv_content = (
        b"name,team\n"
        b"Alice,Alpha\n"
        b"Bob\n"
        b"Carol,Gamma\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("teams.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_filter_row_indices(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [{"column": "team", "operator": "IS NULL"}],
            "max_rows": 1000,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["row_indices"] == [1]
    assert data["total_match_count"] == 1
    assert data["truncated"] is False


def test_filter_row_indices_dataset_not_found(client):
    resp = _query_filter_row_indices(
        client,
        {
            "dataset_id": 999999,
            "filters": [{"column": "city", "operator": "=", "value": "London"}],
        },
    )
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


def test_filter_row_indices_invalid_column(client):
    dataset_id = _ingest(client)
    resp = _query_filter_row_indices(
        client,
        {
            "dataset_id": dataset_id,
            "filters": [{"column": "unknown_col", "operator": "=", "value": "x"}],
        },
    )
    assert resp.status_code == 400
    assert "Invalid filter column" in resp.json()["detail"]


import base64
import json
from urllib.parse import parse_qs, urlparse


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


def _query_aggregate(client, payload):
    return client.post(
        "/query",
        json={"mode": "aggregate", "aggregate": payload},
    )


def test_aggregate_count_success(client):
    dataset_id = _ingest_sales(client)

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "count",
            "filters": [{"column": "Country", "operator": "=", "value": "Canada"}],
            "limit": 50,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["dataset_id"] == dataset_id
    assert data["group_by_column"] is None
    assert len(data["rowsResult"]) == 1
    assert int(data["rowsResult"][0]["aggregate_value"]) == 2
    assert isinstance(data["url"], str)
    assert isinstance(data.get("final_response"), str)
    assert data["url"] in data["final_response"]
    assert "MANDATORY" in data.get("response_instructions", "")


def test_aggregate_sum_group_by_success(client):
    dataset_id = _ingest_sales(client)

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "sum",
            "metric_column": "Boxes Shipped",
            "group_by": "Sales Person",
            "limit": 50,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["dataset_id"] == dataset_id
    assert data["group_by_column"] == "Sales Person"
    assert len(data["rowsResult"]) >= 1
    top = data["rowsResult"][0]
    assert top["group_value"] == "Karlen McCaffrey"
    assert float(top["aggregate_value"]) == 778.0


def test_aggregate_invalid_metric_column(client):
    dataset_id = _ingest_sales(client)

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "sum",
            "metric_column": "NotAColumn",
            "limit": 50,
        },
    )

    assert resp.status_code == 400
    assert "metric_column" in resp.json()["detail"]


def test_aggregate_count_group_by_orders_desc(client):
    dataset_id = _ingest_sales(client)

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "count",
            "group_by": "Sales Person",
            "limit": 50,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["group_by_column"] == "Sales Person"
    assert len(data["rowsResult"]) >= 1
    top = data["rowsResult"][0]
    assert top["group_value"] == "Bob"
    assert int(top["aggregate_value"]) == 2
    assert isinstance(data["url"], str)
    assert data["url"].startswith("http://localhost:5173/tables/virtual?q=")


def test_aggregate_group_by_date_part_month(client):
    csv_content = (
        b"sale_date,amount\n"
        b"2024-01-05,40\n"
        b"2024-01-22,10\n"
        b"2024-02-03,30\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("monthly.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "sum",
            "metric_column": "amount",
            "group_by": "sale_date",
            "group_by_date_part": "month",
            "limit": 50,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["group_by_column"] == "sale_date"
    assert data["group_by_date_part"] == "month"
    assert len(data["rowsResult"]) == 2
    assert data["rowsResult"][0]["group_value"] == "2024-01"
    assert float(data["rowsResult"][0]["aggregate_value"]) == 50.0


def test_aggregate_group_by_counts_include_rows_with_missing_values(client):
    csv_content = (
        b"name,country\n"
        b"Alice,Canada\n"
        b"Bob\n"
        b"Carol,Canada\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("countries.csv", csv_content, "text/csv")},
    )
    dataset_id = resp.json()["dataset_id"]

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "count",
            "group_by": "country",
            "limit": 50,
        },
    )

    assert resp.status_code == 200
    rows = resp.json()["rowsResult"]
    counts = [int(row["aggregate_value"]) for row in rows]
    assert sum(counts) == 3
    canada_rows = [row for row in rows if row["group_value"] == "Canada"]
    assert len(canada_rows) == 1
    assert int(canada_rows[0]["aggregate_value"]) == 2


def test_aggregate_invalid_group_by_column(client):
    dataset_id = _ingest_sales(client)

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "count",
            "group_by": "NotAColumn",
            "limit": 50,
        },
    )

    assert resp.status_code == 400
    assert "group_by" in resp.json()["detail"]


def test_aggregate_dataset_not_found(client):
    resp = _query_aggregate(
        client,
        {
            "dataset_id": 999999,
            "operation": "count",
            "limit": 50,
        },
    )

    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


def test_aggregate_no_matches_count_returns_zero_row(client):
    dataset_id = _ingest_sales(client)

    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "count",
            "filters": [{"column": "Country", "operator": "=", "value": "Nowhere"}],
            "limit": 50,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert len(data["rowsResult"]) == 1
    assert data["rowsResult"][0]["group_value"] is None
    assert int(data["rowsResult"][0]["aggregate_value"]) == 0
    assert isinstance(data["url"], str)


def test_aggregate_accepts_null_filters(client):
    dataset_id = _ingest_sales(client)
    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "count",
            "filters": None,
            "limit": 50,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["dataset_id"] == dataset_id
    assert len(data["rowsResult"]) == 1


def test_aggregate_virtual_url_uses_list_filters_for_compatibility(client):
    dataset_id = _ingest_sales(client)
    resp = _query_aggregate(
        client,
        {
            "dataset_id": dataset_id,
            "operation": "sum",
            "metric_column": "Boxes Shipped",
            "group_by": "Sales Person",
            "filters": None,
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

    # Replay payload exactly as the frontend virtual view does.
    replay_resp = _query_aggregate(client, payload)
    assert replay_resp.status_code == 200

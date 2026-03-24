"""PATCH /tables/{dataset_id}/rows/{row_index} updates a single cell."""

from unittest.mock import patch


def test_patch_table_cell_updates_normalized_value(client):
    csv_content = b"name,age\nAlice,30\nBob,25\n"
    resp = client.post(
        "/ingest",
        files={"file": ("t.csv", csv_content, "text/csv")},
    )
    assert resp.status_code == 200
    dataset_id = resp.json()["dataset_id"]

    with patch("app.routes_tables.upsert_dataset_row_index"):
        r = client.patch(
            f"/tables/{dataset_id}/rows/0",
            json={"column": "name", "value": "Alicia"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["row_index"] == 0
    assert body["column"] == "name"

    slice_resp = client.get(f"/tables/{dataset_id}/slice?offset=0&limit=10")
    assert slice_resp.status_code == 200
    row0 = slice_resp.json()["rows"][0]["data"]
    name_cell = row0["name"]
    if isinstance(name_cell, dict) and "normalized" in name_cell:
        assert name_cell["normalized"] == "Alicia"
    else:
        assert name_cell == "Alicia"


def test_patch_table_cell_unknown_column(client):
    csv_content = b"a,b\n1,2\n"
    resp = client.post(
        "/ingest",
        files={"file": ("t.csv", csv_content, "text/csv")},
    )
    assert resp.status_code == 200
    dataset_id = resp.json()["dataset_id"]

    with patch("app.routes_tables.upsert_dataset_row_index"):
        r = client.patch(
            f"/tables/{dataset_id}/rows/0",
            json={"column": "nope", "value": "x"},
        )
    assert r.status_code == 400


def test_patch_table_column_name_updates_slice_columns(client):
    csv_content = b"name,age\nAlice,30\nBob,25\n"
    resp = client.post(
        "/ingest",
        files={"file": ("t.csv", csv_content, "text/csv")},
    )
    assert resp.status_code == 200
    dataset_id = resp.json()["dataset_id"]

    with patch("app.routes_tables.upsert_dataset_row_index"):
        r = client.patch(
            f"/tables/{dataset_id}/columns",
            json={"column": "name", "name": "full name"},
        )
    assert r.status_code == 200

    slice_resp = client.get(f"/tables/{dataset_id}/slice?offset=0&limit=10")
    assert slice_resp.status_code == 200
    payload = slice_resp.json()
    assert "full_name" in payload["columns"]
    row0 = payload["rows"][0]["data"]
    assert "full_name" in row0

import io
import json
import pytest
from sqlalchemy import text

from app.typed_values import (
    normalize_text_value,
    normalize_column_name,
    normalize_cell_value,
    normalize_row_obj,
    strip_internal_fields,
    INTERNAL_NORMALIZED_KEY,
)


# ── normalize_text_value ──────────────────────────────────────────

def test_normalize_text_value_basic():
    assert normalize_text_value("Alice") == "Alice"
    assert normalize_text_value("  hello  world  ") == "hello world"


def test_normalize_text_value_none_and_nulls():
    assert normalize_text_value(None) is None
    assert normalize_text_value("") is None
    assert normalize_text_value("null") is None
    assert normalize_text_value("None") is None
    assert normalize_text_value("NA") is None
    assert normalize_text_value("N/A") is None
    assert normalize_text_value("nan") is None
    assert normalize_text_value("-") is None
    assert normalize_text_value("missing") is None
    assert normalize_text_value("unknown") is None
    assert normalize_text_value("undefined") is None


def test_normalize_text_value_unicode():
    # Non-breaking space
    assert normalize_text_value("hello\xa0world") == "hello world"
    # Zero-width space
    assert normalize_text_value("hello\u200bworld") == "helloworld"
    # BOM
    assert normalize_text_value("\ufeffhello") == "hello"


def test_normalize_text_value_smart_quotes():
    assert normalize_text_value("\u201cHello\u201d") == '"Hello"'
    assert normalize_text_value("it\u2019s") == "it's"


def test_normalize_text_value_dashes():
    assert normalize_text_value("2020\u20132021") == "2020-2021"
    assert normalize_text_value("value\u2014other") == "value-other"


# ── normalize_column_name ─────────────────────────────────────────

def test_normalize_column_name_basic():
    assert normalize_column_name("Name") == "name"
    assert normalize_column_name("First Name") == "first_name"
    assert normalize_column_name("  Total Sales  ") == "total_sales"


def test_normalize_column_name_accents():
    assert normalize_column_name("Résumé") == "resume"
    assert normalize_column_name("naïve") == "naive"
    assert normalize_column_name("Ängström") == "angstrom"
    assert normalize_column_name("café") == "cafe"


def test_normalize_column_name_special_chars():
    assert normalize_column_name("Sales ($)") == "sales"
    assert normalize_column_name("profit/loss") == "profit_loss"
    assert normalize_column_name("col.name") == "col_name"
    assert normalize_column_name("data--value") == "data_value"


def test_normalize_column_name_empty():
    assert normalize_column_name("") == "col"
    assert normalize_column_name("   ") == "col"
    assert normalize_column_name("!!!") == "col"


def test_normalize_column_name_preserves_numbers():
    assert normalize_column_name("col1") == "col1"
    assert normalize_column_name("2024 Revenue") == "2024_revenue"


# ── normalize_cell_value ──────────────────────────────────────────

def test_normalize_cell_value_basic():
    assert normalize_cell_value("Alice") == "alice"
    assert normalize_cell_value("  Hello  World  ") == "hello world"


def test_normalize_cell_value_none():
    assert normalize_cell_value(None) is None
    assert normalize_cell_value("") is None
    assert normalize_cell_value("NULL") is None


def test_normalize_cell_value_accents():
    assert normalize_cell_value("São Paulo") == "sao paulo"
    assert normalize_cell_value("Zürich") == "zurich"
    assert normalize_cell_value("Ångström") == "angstrom"


def test_normalize_cell_value_preserves_numbers():
    assert normalize_cell_value("$1,234.56") == "$1,234.56"
    assert normalize_cell_value("100%") == "100%"


def test_normalize_cell_value_smart_quotes():
    assert normalize_cell_value("\u201cHello\u201d") == '"hello"'


# ── normalize_row_obj ─────────────────────────────────────────────

def test_normalize_row_obj_includes_normalized():
    result = normalize_row_obj(["Name", "City"], ["Alice", "London"])
    assert result["Name"] == "Alice"
    assert result["City"] == "London"
    assert INTERNAL_NORMALIZED_KEY in result
    normalized = result[INTERNAL_NORMALIZED_KEY]
    assert normalized["name"] == "alice"
    assert normalized["city"] == "london"


def test_normalize_row_obj_with_explicit_normalized_headers():
    result = normalize_row_obj(
        ["First Name", "Last Name"],
        ["José", "García"],
        normalized_headers=["first_name", "last_name"],
    )
    assert result["First Name"] == "José"
    assert result["Last Name"] == "García"
    normalized = result[INTERNAL_NORMALIZED_KEY]
    assert normalized["first_name"] == "jose"
    assert normalized["last_name"] == "garcia"


def test_normalize_row_obj_null_values():
    result = normalize_row_obj(["A", "B"], ["hello", "N/A"])
    assert result["A"] == "hello"
    assert result["B"] is None
    normalized = result[INTERNAL_NORMALIZED_KEY]
    assert normalized["a"] == "hello"
    assert normalized["b"] is None


def test_strip_internal_fields_removes_normalized():
    result = normalize_row_obj(["Name"], ["Alice"])
    stripped = strip_internal_fields(result)
    assert "Name" in stripped
    assert INTERNAL_NORMALIZED_KEY not in stripped
    assert "__typed__" not in stripped


# ── Integration: DatasetColumn.normalized_name ────────────────────

def make_csv(content: str, filename: str = "test.csv"):
    return {"file": (filename, io.BytesIO(content.encode("utf-8")), "text/csv")}


def test_db_columns_have_normalized_name(client, test_engine):
    client.post("/ingest", files=make_csv("First Name,Last Name,Age\n1,2,3\n"))
    with test_engine.connect() as conn:
        cols = conn.execute(
            text("SELECT name, normalized_name FROM dataset_columns ORDER BY column_index")
        ).fetchall()
    assert [c.name for c in cols] == ["First Name", "Last Name", "Age"]
    assert [c.normalized_name for c in cols] == ["first_name", "last_name", "age"]


def test_db_columns_normalized_accents(client, test_engine):
    client.post("/ingest", files=make_csv("Résumé,naïve\n1,2\n"))
    with test_engine.connect() as conn:
        cols = conn.execute(
            text("SELECT name, normalized_name FROM dataset_columns ORDER BY column_index")
        ).fetchall()
    assert [c.name for c in cols] == ["Résumé", "naïve"]
    assert [c.normalized_name for c in cols] == ["resume", "naive"]


def test_normalized_row_data_stored(client, test_engine):
    client.post("/ingest", files=make_csv("City,Country\nSão Paulo,Brasil\n"))
    with test_engine.connect() as conn:
        rows = conn.execute(text("SELECT row_data FROM dataset_rows")).fetchall()
    data = json.loads(rows[0].row_data)
    # Display values preserved
    assert data["City"] == "São Paulo"
    assert data["Country"] == "Brasil"
    # Normalized values lowercased + accent-stripped
    assert data["__normalized__"]["city"] == "sao paulo"
    assert data["__normalized__"]["country"] == "brasil"


def test_columns_endpoint_returns_normalized_name(client):
    resp = client.post("/ingest", files=make_csv("Sales Person,Boxes Shipped\n1,2\n"))
    dataset_id = resp.json()["dataset_id"]
    resp = client.get(f"/tables/{dataset_id}/columns")
    assert resp.status_code == 200
    columns = resp.json()["columns"]
    assert columns[0]["name"] == "Sales Person"
    assert columns[0]["normalized_name"] == "sales_person"
    assert columns[1]["name"] == "Boxes Shipped"
    assert columns[1]["normalized_name"] == "boxes_shipped"


def test_duplicate_normalized_names_are_unique(client, test_engine):
    """Headers that normalize to the same string get unique normalized names."""
    client.post("/ingest", files=make_csv("Name,name\nAlice,Bob\n"))
    with test_engine.connect() as conn:
        cols = conn.execute(
            text("SELECT name, normalized_name FROM dataset_columns ORDER BY column_index")
        ).fetchall()
    normalized_names = [c.normalized_name for c in cols]
    assert len(normalized_names) == len(set(normalized_names))

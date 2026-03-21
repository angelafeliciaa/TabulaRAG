from typing import Any, Dict, List, Optional

import pytest


def _query_endpoint(client) -> str:
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    paths = resp.json().get("paths", {})
    if "/query_table" in paths:
        return "/query_table"
    assert "/query" in paths
    return "/query"


def _component_properties(client, schema_name: str) -> Dict[str, Any]:
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    return (
        resp.json()
        .get("components", {})
        .get("schemas", {})
        .get(schema_name, {})
        .get("properties", {})
    )


def _supports_filter_field(client, field_name: str) -> bool:
    return field_name in _component_properties(client, "FilterRequest")


def _supports_sorting(client) -> bool:
    props = _component_properties(client, "FilterRequest")
    return ("sort_by" in props and "sort_order" in props) or ("order_by" in props and "order" in props)


def _post_query_table(client, body: Dict[str, Any]):
    return client.post(_query_endpoint(client), json=body)


def build_query(mode: str, dataset_id: int, **kwargs: Any) -> Dict[str, Any]:
    payload = {"dataset_id": dataset_id, **kwargs}
    return {"mode": mode, mode: payload}


def assert_rows_equal(actual_rows: List[Any], expected_rows: List[Any]) -> None:
    assert actual_rows == expected_rows


def assert_sorted(values: List[Any], reverse: bool = False) -> None:
    assert values == sorted(values, reverse=reverse)


def _filter_query(
    client,
    dataset_id: int,
    filters: Optional[List[Dict[str, Any]]] = None,
    limit: int = 50,
    offset: int = 0,
):
    body = build_query(
        mode="filter",
        dataset_id=dataset_id,
        filters=filters,
        limit=limit,
        offset=offset,
    )
    return _post_query_table(client, body)


def _aggregate_query(
    client,
    dataset_id: int,
    operation: str,
    metric_column: Optional[str] = None,
    group_by: Optional[str] = None,
    filters: Optional[List[Dict[str, Any]]] = None,
    limit: int = 50,
):
    body = build_query(
        mode="aggregate",
        dataset_id=dataset_id,
        operation=operation,
        metric_column=metric_column,
        group_by=group_by,
        filters=filters,
        limit=limit,
    )
    return _post_query_table(client, body)


@pytest.fixture
def query_table_dataset_id(client):
    csv_content = (
        b"product,revenue,region,date\n"
        b"Widget,100,North,20240115\n"
        b"Widget,200,South,20240210\n"
        b"Gadget,150,North,20240305\n"
        b"Gizmo,50,East,20240120\n"
        b"Gizmo,,West,20240401\n"
        b"Widget,120,East,20231231\n"
    )
    resp = client.post(
        "/ingest",
        files={"file": ("query_table.csv", csv_content, "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["dataset_id"]


class TestBasicRetrieval:
    def test_query_no_filters_returns_rows(self, client, query_table_dataset_id):
        # Arrange
        dataset_id = query_table_dataset_id

        # Act
        resp = _filter_query(client, dataset_id=dataset_id, filters=None, limit=100)

        # Assert
        assert resp.status_code == 200
        body = resp.json()
        assert body["dataset_id"] == dataset_id
        assert body["row_count"] == 6
        assert len(body["rowsResult"]) == 6

    def test_query_with_limit_returns_correct_size(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(client, dataset_id=dataset_id, filters=None, limit=2)

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 6
        assert len(body["rowsResult"]) == 2


class TestFiltering:
    def test_filter_equals(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "region", "operator": "=", "value": "North"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 2
        products = [r["row_data"]["product"] for r in body["rowsResult"]]
        assert_rows_equal(products, ["Widget", "Gadget"])

    def test_filter_greater_than(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "revenue", "operator": ">", "value": "120"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 2
        revenues = [row["row_data"]["revenue"] for row in body["rowsResult"]]
        assert_rows_equal(revenues, ["200", "150"])

    def test_filter_less_than(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "revenue", "operator": "<", "value": "100"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 2
        products = [row["row_data"]["product"] for row in body["rowsResult"]]
        assert_rows_equal(products, ["Gizmo", "Gizmo"])

    def test_filter_multiple_conditions_and(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[
                {"column": "region", "operator": "=", "value": "East"},
                {"column": "revenue", "operator": ">", "value": "60", "logical_operator": "AND"},
            ],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 1
        assert body["rowsResult"][0]["row_data"]["product"] == "Widget"


class TestProjection:
    def test_select_specific_columns(self, client, query_table_dataset_id):
        if not _supports_filter_field(client, "columns"):
            pytest.skip("Projection is not exposed in FilterRequest schema.")

        dataset_id = query_table_dataset_id
        body = build_query(
            mode="filter",
            dataset_id=dataset_id,
            filters=None,
            columns=["product", "revenue"],
            limit=10,
            offset=0,
        )
        resp = _post_query_table(client, body)

        assert resp.status_code == 200
        row_data = resp.json()["rowsResult"][0]["row_data"]
        assert set(row_data.keys()) == {"product", "revenue"}

    def test_select_single_column(self, client, query_table_dataset_id):
        if not _supports_filter_field(client, "columns"):
            pytest.skip("Projection is not exposed in FilterRequest schema.")

        dataset_id = query_table_dataset_id
        body = build_query(
            mode="filter",
            dataset_id=dataset_id,
            filters=None,
            columns=["product"],
            limit=10,
            offset=0,
        )
        resp = _post_query_table(client, body)

        assert resp.status_code == 200
        row_data = resp.json()["rowsResult"][0]["row_data"]
        assert set(row_data.keys()) == {"product"}


class TestSorting:
    def test_sort_ascending(self, client, query_table_dataset_id):
        if not _supports_sorting(client):
            pytest.skip("Explicit sorting is not exposed in FilterRequest schema.")

        dataset_id = query_table_dataset_id
        body = build_query(
            mode="filter",
            dataset_id=dataset_id,
            filters=None,
            sort_by="revenue",
            sort_order="asc",
            limit=50,
            offset=0,
        )
        resp = _post_query_table(client, body)

        assert resp.status_code == 200
        revenues = [float(r["row_data"]["revenue"]) for r in resp.json()["rowsResult"] if r["row_data"]["revenue"] is not None]
        assert_sorted(revenues, reverse=False)

    def test_sort_descending(self, client, query_table_dataset_id):
        if not _supports_sorting(client):
            pytest.skip("Explicit sorting is not exposed in FilterRequest schema.")

        dataset_id = query_table_dataset_id
        body = build_query(
            mode="filter",
            dataset_id=dataset_id,
            filters=None,
            sort_by="revenue",
            sort_order="desc",
            limit=50,
            offset=0,
        )
        resp = _post_query_table(client, body)

        assert resp.status_code == 200
        revenues = [float(r["row_data"]["revenue"]) for r in resp.json()["rowsResult"] if r["row_data"]["revenue"] is not None]
        assert_sorted(revenues, reverse=True)


class TestLimit:
    def test_limit_results(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(client, dataset_id=dataset_id, filters=None, limit=3)

        assert resp.status_code == 200
        assert len(resp.json()["rowsResult"]) == 3

    def test_limit_after_filter(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "region", "operator": "=", "value": "North"}],
            limit=1,
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 2
        assert len(body["rowsResult"]) == 1


class TestAggregation:
    def test_sum_metric(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="sum",
            metric_column="revenue",
        )

        assert resp.status_code == 200
        value = float(resp.json()["rowsResult"][0]["aggregate_value"])
        assert value == pytest.approx(620.0)

    def test_avg_metric(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="avg",
            metric_column="revenue",
        )

        assert resp.status_code == 200
        value = float(resp.json()["rowsResult"][0]["aggregate_value"])
        assert value == pytest.approx(103.33333333333333)

    def test_count_rows(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="count",
        )

        assert resp.status_code == 200
        value = int(resp.json()["rowsResult"][0]["aggregate_value"])
        assert value == 6


class TestGrouping:
    def test_group_by_single_column(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="count",
            group_by="region",
        )

        assert resp.status_code == 200
        rows = resp.json()["rowsResult"]
        grouped = {row["group_value"]: int(row["aggregate_value"]) for row in rows}
        assert grouped["North"] == 2
        assert grouped["East"] == 2
        assert grouped["South"] == 1
        assert grouped["West"] == 1

    def test_group_by_with_sum(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="sum",
            metric_column="revenue",
            group_by="region",
        )

        assert resp.status_code == 200
        rows = resp.json()["rowsResult"]
        grouped = {row["group_value"]: row["aggregate_value"] for row in rows}
        assert float(grouped["North"]) == pytest.approx(250.0)
        assert float(grouped["East"]) == pytest.approx(170.0)
        assert float(grouped["South"]) == pytest.approx(200.0)
        assert float(grouped["West"]) == pytest.approx(0.0)

    def test_group_by_with_avg(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="avg",
            metric_column="revenue",
            group_by="region",
        )

        assert resp.status_code == 200
        rows = resp.json()["rowsResult"]
        grouped = {row["group_value"]: row["aggregate_value"] for row in rows}
        assert float(grouped["North"]) == pytest.approx(125.0)
        assert float(grouped["East"]) == pytest.approx(85.0)
        assert float(grouped["South"]) == pytest.approx(200.0)
        assert float(grouped["West"]) == pytest.approx(0.0)


class TestGroupSortLimit:
    def test_top_k_grouped_results(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="count",
            group_by="product",
            limit=2,
        )

        assert resp.status_code == 200
        rows = resp.json()["rowsResult"]
        assert len(rows) == 2
        counts = [int(r["aggregate_value"]) for r in rows]
        assert_sorted(counts, reverse=True)
        top_products = [r["group_value"] for r in rows]
        assert_rows_equal(top_products, ["Widget", "Gizmo"])

    def test_group_sort_limit_combination(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="sum",
            metric_column="revenue",
            group_by="product",
            limit=1,
        )

        assert resp.status_code == 200
        rows = resp.json()["rowsResult"]
        assert len(rows) == 1
        assert rows[0]["group_value"] == "Widget"
        assert float(rows[0]["aggregate_value"]) == pytest.approx(420.0)


class TestCombinedQueries:
    def test_filter_group_aggregate(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="sum",
            metric_column="revenue",
            group_by="product",
            filters=[{"column": "region", "operator": "=", "value": "North"}],
        )

        assert resp.status_code == 200
        rows = resp.json()["rowsResult"]
        grouped = {row["group_value"]: float(row["aggregate_value"]) for row in rows}
        assert grouped == {"Gadget": 150.0, "Widget": 100.0}

    def test_filter_sort_limit(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "region", "operator": "=", "value": "North"}],
            limit=1,
            offset=0,
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 2
        assert len(body["rowsResult"]) == 1
        assert body["rowsResult"][0]["row_data"]["product"] == "Widget"

    def test_full_pipeline_query(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="sum",
            metric_column="revenue",
            group_by="product",
            filters=[
                {"column": "date", "operator": ">", "value": "2023"},
                {"column": "region", "operator": "!=", "value": "West", "logical_operator": "AND"},
            ],
            limit=2,
        )

        assert resp.status_code == 200
        rows = resp.json()["rowsResult"]
        assert len(rows) == 2
        grouped = {row["group_value"]: float(row["aggregate_value"]) for row in rows}
        assert grouped == {"Widget": 300.0, "Gadget": 150.0}


class TestTimeBasedFiltering:
    def test_filter_date_after(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "date", "operator": ">", "value": "2023"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 5

    def test_filter_date_before(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "date", "operator": "<", "value": "2024"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 1


class TestStringMatching:
    def test_filter_contains_string(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "product", "operator": "LIKE", "value": "%get%"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 4
        assert all("get" in row["row_data"]["product"].lower() for row in body["rowsResult"])


class TestEdgeCases:
    def test_invalid_column_returns_error(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "unknown_column", "operator": "=", "value": "x"}],
        )

        assert resp.status_code == 400
        assert "Invalid filter column" in resp.json()["detail"]

    def test_invalid_operator_returns_error(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "region", "operator": "CONTAINS", "value": "No"}],
        )

        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert any("operator" in str(item.get("loc", [])) for item in detail)

    def test_empty_result_returns_empty_list(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "region", "operator": "=", "value": "Antarctica"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 0
        assert body["rowsResult"] == []

    def test_null_values_handled_correctly(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(
            client,
            dataset_id=dataset_id,
            filters=[{"column": "revenue", "operator": "IS NULL"}],
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 1
        assert body["rowsResult"][0]["row_data"]["region"] == "West"


class TestTypeHandling:
    def test_numeric_sorting_correct(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _aggregate_query(
            client,
            dataset_id=dataset_id,
            operation="sum",
            metric_column="revenue",
            group_by="product",
        )

        assert resp.status_code == 200
        values = [float(row["aggregate_value"]) for row in resp.json()["rowsResult"] if row["aggregate_value"] is not None]
        assert_sorted(values, reverse=True)

    def test_string_sorting_correct(self, client, query_table_dataset_id):
        if not _supports_sorting(client):
            pytest.skip("Explicit string sorting is not exposed in FilterRequest schema.")

        dataset_id = query_table_dataset_id
        body = build_query(
            mode="filter",
            dataset_id=dataset_id,
            filters=None,
            sort_by="product",
            sort_order="asc",
            limit=50,
            offset=0,
        )
        resp = _post_query_table(client, body)
        assert resp.status_code == 200
        products = [row["row_data"]["product"] for row in resp.json()["rowsResult"]]
        assert_sorted(products, reverse=False)

    def test_date_sorting_correct(self, client, query_table_dataset_id):
        if not _supports_sorting(client):
            pytest.skip("Explicit date sorting is not exposed in FilterRequest schema.")

        dataset_id = query_table_dataset_id
        body = build_query(
            mode="filter",
            dataset_id=dataset_id,
            filters=None,
            sort_by="date",
            sort_order="asc",
            limit=50,
            offset=0,
        )
        resp = _post_query_table(client, body)
        assert resp.status_code == 200
        dates = [row["row_data"]["date"] for row in resp.json()["rowsResult"]]
        assert_sorted(dates, reverse=False)


class TestResponseStructure:
    def test_response_has_columns_and_data(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(client, dataset_id=dataset_id, filters=None, limit=1)

        assert resp.status_code == 200
        body = resp.json()
        assert "dataset_id" in body
        assert "rowsResult" in body
        assert "row_count" in body
        assert "sql_query" in body
        row_data = body["rowsResult"][0]["row_data"]
        for expected_col in ("product", "revenue", "region", "date"):
            assert expected_col in row_data

    def test_row_count_matches_result(self, client, query_table_dataset_id):
        dataset_id = query_table_dataset_id
        resp = _filter_query(client, dataset_id=dataset_id, filters=None, limit=2)

        assert resp.status_code == 200
        body = resp.json()
        assert body["row_count"] == 6
        assert len(body["rowsResult"]) == 2

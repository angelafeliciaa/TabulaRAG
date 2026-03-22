from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


FilterOperator = Literal[
    "=",
    "!=",
    ">",
    ">=",
    "<",
    "<=",
    "LIKE",
    "NOT LIKE",
    "CONTAINS",
    "NOT CONTAINS",
    "IN",
    "BETWEEN",
    "IS NULL",
    "IS NOT NULL",
]

QueryMode = Literal["semantic", "aggregate", "filter", "filter_row_indices"]
AggregateOperator = Literal["count", "sum", "avg", "min", "max"]


class FilterCondition(BaseModel):
    column: str = Field(
        description="Column name. Use normalized_name from GET /tables/context query_context.columns (not original_name)."
    )
    operator: FilterOperator = Field(
        description=(
            "Filter operator. Supported operators: =, !=, >, >=, <, <=, LIKE, NOT LIKE, "
            "CONTAINS, NOT CONTAINS, IN, BETWEEN, IS NULL, IS NOT NULL."
        )
    )
    value: Optional[str] = Field(
        default=None,
        description=(
            "Filter value. Not used for IS NULL / IS NOT NULL. "
            "For IN use comma-separated values (for example: 'US,CA'). "
            "For BETWEEN use 'low,high' or 'low AND high'."
        ),
    )
    logical_operator: Literal["AND", "OR"] = Field(
        default="AND",
        description="Join operator to previous filter when multiple filters are provided.",
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_operator_aliases(cls, raw: Any) -> Any:
        if not isinstance(raw, dict):
            return raw
        data = dict(raw)

        operator_raw = data.get("operator")
        if isinstance(operator_raw, str):
            token = " ".join(operator_raw.strip().replace("_", " ").split()).upper()
            aliases = {
                "==": "=",
                "EQ": "=",
                "<>": "!=",
                "NE": "!=",
                "NEQ": "!=",
                "GT": ">",
                "GTE": ">=",
                "LT": "<",
                "LTE": "<=",
                "CONTAINS": "CONTAINS",
                "NOT CONTAINS": "NOT CONTAINS",
                "DOES NOT CONTAIN": "NOT CONTAINS",
                "ISNULL": "IS NULL",
                "NOT NULL": "IS NOT NULL",
            }
            data["operator"] = aliases.get(token, token)

        logical_raw = data.get("logical_operator")
        if isinstance(logical_raw, str):
            data["logical_operator"] = logical_raw.strip().upper()

        return data


class QueryRequest(BaseModel):
    question: str = Field(description="Natural language question to search the dataset with")
    dataset_id: Optional[int] = Field(
        default=None,
        description=(
            "Optional dataset ID. Deterministic dataset selector when known. "
            "You may also provide dataset_name for readability/disambiguation."
        ),
    )
    dataset_name: Optional[str] = Field(
        default=None,
        description=(
            "Optional dataset name (for example 'Chocolate'). Recommended for MCP clients, "
            "especially when many datasets exist."
        ),
    )
    top_k: int = Field(default=10, ge=1, le=100)
    filters: Optional[Dict[str, str]] = None


class AggregateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    dataset_id: Optional[int] = Field(
        default=None,
        description=(
            "Optional dataset ID. Deterministic dataset selector when known. "
            "You may also provide dataset_name for readability/disambiguation."
        ),
    )
    dataset_name: Optional[str] = Field(
        default=None,
        description=(
            "Optional dataset name to resolve to an ID when dataset_id is omitted. "
            "Recommended for MCP clients when many datasets exist."
        ),
    )
    filters: Optional[List[FilterCondition]] = Field(default=None)
    operation: Optional[AggregateOperator] = None
    metric_column: Optional[str] = Field(
        default=None,
        description="Column to aggregate (sum/avg/min/max). Use normalized_name from GET /tables/context query_context.columns.",
    )
    metrics: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description=(
            "Optional multi-metric aggregate spec. Each item should look like "
            "{ column: <normalized_name>, agg: sum|avg|min|max|count }. "
            "When provided, one /query call can return multiple aggregate columns."
        ),
    )
    group_by: Optional[str] = Field(
        default=None,
        description="Column to group by. Use normalized_name from GET /tables/context query_context.columns.",
    )
    group_by_date_part: Optional[Literal["month", "quarter", "year"]] = Field(
        default=None,
        description="When group_by is a date column (ISO YYYY-MM-DD), group by this part instead of full date: month (YYYY-MM), quarter (YYYY-QN), or year (YYYY).",
    )
    highlight_index: Optional[int] = Field(
        default=None,
        description=(
            "Optional UI hint for virtual table highlighting. Ignored by the aggregate query execution."
        ),
    )
    limit: int = 50

    @model_validator(mode="before")
    @classmethod
    def _normalize_legacy_shape(cls, raw: Any) -> Any:
        if not isinstance(raw, dict):
            return raw

        data = dict(raw)
        op_value = data.get("operation")
        if isinstance(op_value, dict):
            group_by_value = op_value.get("group_by")
            if isinstance(group_by_value, list):
                if len(group_by_value) > 1:
                    raise ValueError(
                        "group_by must contain one column when passed as a list."
                    )
                data["group_by"] = group_by_value[0] if group_by_value else None
            elif isinstance(group_by_value, str):
                data["group_by"] = group_by_value

            metrics = op_value.get("metrics")
            if isinstance(metrics, list):
                data["metrics"] = metrics
                if len(metrics) >= 1 and isinstance(metrics[0], dict):
                    first_metric = metrics[0]
                    agg = first_metric.get("agg")
                    column = first_metric.get("column")
                    if isinstance(agg, str):
                        data["operation"] = agg.lower()
                    if column is not None and "metric_column" not in data:
                        data["metric_column"] = column
            else:
                raise ValueError(
                    "Legacy aggregate shape requires operation.metrics as a list."
                )

        group_by = data.get("group_by")
        if data.get("metric_column") is None and data.get("column") is not None:
            data["metric_column"] = data.get("column")
        if isinstance(group_by, list):
            if len(group_by) > 1:
                raise ValueError("group_by must be a single column name.")
            data["group_by"] = group_by[0] if group_by else None

        return data

    @model_validator(mode="after")
    def _validate_metric_requirements(self) -> "AggregateRequest":
        if self.metrics:
            normalized_metrics: List[Dict[str, Any]] = []
            for metric in self.metrics:
                if not isinstance(metric, dict):
                    raise ValueError(
                        "Each metrics item must be an object with agg and optional column."
                    )
                agg_raw = str(metric.get("agg", "")).strip().lower()
                if agg_raw not in {"count", "sum", "avg", "min", "max"}:
                    raise ValueError(
                        f"Unsupported metric agg '{agg_raw}'. Use count/sum/avg/min/max."
                    )
                column_raw = metric.get("column")
                if agg_raw != "count" and not column_raw:
                    raise ValueError(
                        f"Metric agg '{agg_raw}' requires a column."
                    )
                normalized_metrics.append(
                    {
                        "agg": agg_raw,
                        "column": str(column_raw) if column_raw is not None else None,
                    }
                )
            self.metrics = normalized_metrics
            if self.operation is None:
                self.operation = normalized_metrics[0]["agg"]  # type: ignore[assignment]
            if self.metric_column is None:
                self.metric_column = normalized_metrics[0].get("column")
            return self

        if self.operation is None:
            raise ValueError("operation is required when metrics is not provided.")
        if self.operation != "count" and not self.metric_column:
            raise ValueError(
                "metric_column is required for operation sum/avg/min/max."
            )
        return self


class FilterRequest(BaseModel):
    dataset_id: Optional[int] = Field(
        default=None,
        description=(
            "Optional dataset ID. Deterministic dataset selector when known. "
            "You may also provide dataset_name for readability/disambiguation."
        ),
    )
    dataset_name: Optional[str] = Field(
        default=None,
        description=(
            "Optional dataset name to resolve to an ID when dataset_id is omitted. "
            "Recommended for MCP clients when many datasets exist."
        ),
    )
    filters: Optional[List[FilterCondition]] = Field(default=None)
    columns: Optional[List[str]] = Field(
        default=None,
        description=(
            "Optional projection list. When provided, response rows include only these normalized column names."
        ),
    )
    sort_by: Optional[str] = Field(
        default=None,
        description="Optional sort column (normalized_name).",
    )
    sort_order: Literal["asc", "desc"] = Field(
        default="asc",
        description="Sort direction when sort_by is provided.",
    )
    sort_as: Literal["auto", "text", "number", "date"] = Field(
        default="auto",
        description=(
            "How to sort values: auto (infer), text, number, or date."
        ),
    )
    limit: int = Field(
        default=50,
        description="Top-k row count to return (server clamps to safe bounds).",
    )
    offset: int = Field(
        default=0,
        description="Pagination offset for the next page of rows.",
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_aliases(cls, raw: Any) -> Any:
        if not isinstance(raw, dict):
            return raw
        data = dict(raw)

        if data.get("columns") is None and data.get("select") is not None:
            data["columns"] = data.get("select")

        if data.get("sort_by") is None and data.get("order_by") is not None:
            data["sort_by"] = data.get("order_by")
        if data.get("sort_order") is None and data.get("order") is not None:
            data["sort_order"] = str(data.get("order")).lower()

        return data


class FilterRowIndicesRequest(BaseModel):
    dataset_id: Optional[int] = Field(
        default=None,
        description=(
            "Optional dataset ID. Deterministic dataset selector when known. "
            "You may also provide dataset_name for readability/disambiguation."
        ),
    )
    dataset_name: Optional[str] = Field(
        default=None,
        description=(
            "Optional dataset name to resolve to an ID when dataset_id is omitted. "
            "Recommended for MCP clients when many datasets exist."
        ),
    )
    filters: Optional[List[FilterCondition]] = None
    max_rows: int = Field(
        default=1000,
        description="Maximum row indices to return in one call (for lightweight pagination/selection flows).",
    )


class UnifiedQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Optional[QueryMode] = Field(
        default=None,
        description=(
            "Query mode. Use semantic for natural-language retrieval, aggregate for metrics "
            "(count/sum/avg/min/max with optional group_by), filter for row filtering/projection/sorting/pagination, "
            "and filter_row_indices for row-id resolution. Optional when exactly one payload block is provided."
        ),
    )
    semantic: Optional[QueryRequest] = Field(
        default=None,
        description="Payload for semantic mode.",
    )
    aggregate: Optional[AggregateRequest] = Field(
        default=None,
        description="Payload for aggregate mode.",
    )
    filter: Optional[FilterRequest] = Field(
        default=None,
        description="Payload for filter mode.",
    )
    filter_row_indices: Optional[FilterRowIndicesRequest] = Field(
        default=None,
        description="Payload for filter_row_indices mode.",
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_wrapped_payloads(cls, raw: Any) -> Any:
        if not isinstance(raw, dict):
            return raw
        data = dict(raw)
        for key in ("semantic", "aggregate", "filter", "filter_row_indices"):
            nested = data.get(key)
            if (
                isinstance(nested, dict)
                and len(data) <= 2
                and key in nested
                and isinstance(nested[key], dict)
            ):
                # Accept accidental double-wrapping used by some tool clients.
                data[key] = nested[key]
        return data

    @model_validator(mode="after")
    def _validate_mode_and_payload(self) -> "UnifiedQueryRequest":
        payload_map = {
            "semantic": self.semantic,
            "aggregate": self.aggregate,
            "filter": self.filter,
            "filter_row_indices": self.filter_row_indices,
        }
        provided = [key for key, payload in payload_map.items() if payload is not None]

        if self.mode is None:
            if len(provided) == 1:
                self.mode = provided[0]  # type: ignore[assignment]
                return self
            raise ValueError(
                "Provide mode or exactly one payload block (semantic/aggregate/filter/filter_row_indices)."
            )

        if len(provided) == 0:
            raise ValueError(f"Mode '{self.mode}' requires the '{self.mode}' payload.")
        if len(provided) > 1:
            raise ValueError(
                "Provide exactly one payload block matching mode."
            )
        if provided[0] != self.mode:
            raise ValueError(f"Mode '{self.mode}' requires the '{self.mode}' payload.")

        return self


UNIFIED_QUERY_OPENAPI_EXAMPLES: Dict[str, Dict[str, Any]] = {
    "semantic_question": {
        "summary": "Semantic lookup",
        "description": "Find rows relevant to a natural-language question.",
        "value": {
            "mode": "semantic",
            "semantic": {
                "question": "Who lives in London?",
                "dataset_name": "people",
                "top_k": 10,
            },
        },
    },
    "aggregate_sum_by_group": {
        "summary": "Aggregate by group",
        "description": "Compute grouped totals for a numeric column.",
        "value": {
            "mode": "aggregate",
            "aggregate": {
                "dataset_name": "sales",
                "operation": "sum",
                "metric_column": "revenue",
                "group_by": "country",
                "limit": 50,
            },
        },
    },
    "filter_top_k_sorted": {
        "summary": "Top-k rows after filtering",
        "description": "Example: top 5 products where revenue > 1000, sorted descending.",
        "value": {
            "mode": "filter",
            "filter": {
                "dataset_name": "sales",
                "filters": [
                    {"column": "revenue", "operator": ">", "value": "1000"},
                ],
                "columns": ["product", "revenue"],
                "sort_by": "revenue",
                "sort_order": "desc",
                "limit": 5,
                "offset": 0,
            },
        },
    },
    "filter_multiple_conditions": {
        "summary": "Multiple filters with AND/OR",
        "description": "Example: revenue > 1000 AND region = US.",
        "value": {
            "mode": "filter",
            "filter": {
                "dataset_name": "sales",
                "filters": [
                    {"column": "revenue", "operator": ">", "value": "1000"},
                    {
                        "column": "region",
                        "operator": "=",
                        "value": "US",
                        "logical_operator": "AND",
                    },
                ],
                "limit": 50,
                "offset": 0,
            },
        },
    },
    "filter_date_range": {
        "summary": "Date range filter",
        "description": "Example: between January and March using BETWEEN.",
        "value": {
            "mode": "filter",
            "filter": {
                "dataset_name": "sales",
                "filters": [
                    {
                        "column": "date",
                        "operator": "BETWEEN",
                        "value": "2024-01-01,2024-03-31",
                    }
                ],
                "limit": 50,
                "offset": 0,
            },
        },
    },
    "filter_contains": {
        "summary": "String contains filter",
        "description": "Example: product contains 'phone'.",
        "value": {
            "mode": "filter",
            "filter": {
                "dataset_name": "products",
                "filters": [
                    {"column": "product", "operator": "CONTAINS", "value": "phone"},
                ],
                "limit": 50,
                "offset": 0,
            },
        },
    },
    "aggregate_total_revenue": {
        "summary": "Aggregate without grouping",
        "description": "Example: total revenue.",
        "value": {
            "mode": "aggregate",
            "aggregate": {
                "dataset_name": "sales",
                "operation": "sum",
                "metric_column": "revenue",
                "limit": 1,
            },
        },
    },
    "aggregate_top_groups": {
        "summary": "Group + aggregate + limit",
        "description": "Example: top 5 products by revenue.",
        "value": {
            "mode": "aggregate",
            "aggregate": {
                "dataset_name": "sales",
                "operation": "sum",
                "metric_column": "revenue",
                "group_by": "product",
                "limit": 5,
            },
        },
    },
    "aggregate_multiple_metrics": {
        "summary": "Multiple metrics per group",
        "description": "Example: sum and average revenue per product.",
        "value": {
            "mode": "aggregate",
            "aggregate": {
                "dataset_name": "sales",
                "group_by": "product",
                "metrics": [
                    {"column": "revenue", "agg": "sum"},
                    {"column": "revenue", "agg": "avg"},
                ],
                "limit": 50,
            },
        },
    },
    "filter_pagination": {
        "summary": "Pagination",
        "description": "Example: next 10 results with offset.",
        "value": {
            "mode": "filter",
            "filter": {
                "dataset_name": "sales",
                "filters": None,
                "limit": 10,
                "offset": 10,
            },
        },
    },
    "aggregate_legacy_shape": {
        "summary": "Aggregate legacy shape (accepted)",
        "description": "Compatibility input where operation is an object with metrics.",
        "value": {
            "aggregate": {
                "dataset_id": 12,
                "operation": {
                    "group_by": ["sales_person"],
                    "metrics": [{"column": "amount", "agg": "sum"}],
                },
            }
        },
    },
    "filter_rows": {
        "summary": "Filter rows",
        "description": "Return matching rows using structured conditions.",
        "value": {
            "mode": "filter",
            "filter": {
                "dataset_name": "sales",
                "filters": [
                    {"column": "city", "operator": "=", "value": "London"},
                ],
                "limit": 50,
                "offset": 0,
            },
        },
    },
    "filter_row_indices": {
        "summary": "Filter row indices",
        "description": "Return only row indices for matching rows.",
        "value": {
            "mode": "filter_row_indices",
            "filter_row_indices": {
                "dataset_name": "sales",
                "filters": [
                    {"column": "city", "operator": "=", "value": "London"},
                ],
                "max_rows": 1000,
            },
        },
    },
}

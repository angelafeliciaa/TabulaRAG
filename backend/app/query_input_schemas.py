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
    operator: FilterOperator
    value: Optional[str] = None  # None for IS NULL / IS NOT NULL
    logical_operator: Literal["AND", "OR"] = "AND"


class QueryRequest(BaseModel):
    question: str = Field(description="Natural language question to search the dataset with")
    dataset_id: Optional[int] = Field(
        default=None,
        description=(
            "Preferred dataset ID. For best tool reliability, call GET /tables/context first and pass dataset_id."
        ),
    )
    dataset_name: Optional[str] = Field(
        default=None,
        description="Optional dataset name (for example 'Chocolate'). Helps automatic dataset resolution.",
    )
    top_k: int = Field(default=10, ge=1, le=100)
    filters: Optional[Dict[str, str]] = None


class AggregateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    dataset_id: int = Field(
        description="ID of the dataset to aggregate. Call GET /tables/context first to discover valid IDs and columns."
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
    dataset_id: int = Field(
        description="ID of the dataset to filter. Call GET /tables/context first to discover valid IDs and columns."
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
    limit: int = 50
    offset: int = 0

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
    dataset_id: int = Field(
        description="ID of the dataset to filter. Call GET /tables/context first to discover valid IDs and columns."
    )
    filters: Optional[List[FilterCondition]] = None
    max_rows: int = 1000


class UnifiedQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Optional[QueryMode] = Field(
        default=None,
        description=(
            "Query mode. Use semantic for natural-language lookup, aggregate for grouped metrics, "
            "filter for row retrieval, and filter_row_indices for row id resolution. "
            "Optional when exactly one payload block is provided."
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
                "dataset_id": 12,
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
                "dataset_id": 12,
                "operation": "sum",
                "metric_column": "revenue",
                "group_by": "country",
                "limit": 50,
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
                "dataset_id": 12,
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
                "dataset_id": 12,
                "filters": [
                    {"column": "city", "operator": "=", "value": "London"},
                ],
                "max_rows": 1000,
            },
        },
    },
}

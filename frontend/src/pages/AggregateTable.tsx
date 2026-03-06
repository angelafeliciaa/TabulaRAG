import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  aggregate,
  filterRows,
  type AggregateResponse,
  type FilterResponse,
} from "../api";
import DataTable from "../components/DataTable";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function VirtualTableView() {
  const location = useLocation();
  const [aggregateData, setAggregateData] = useState<AggregateResponse | null>(null);
  const [filterData, setFilterData] = useState<FilterResponse | null>(null);
  const [mode, setMode] = useState<"aggregate" | "filter" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);

  type AggregatePayload = {
    dataset_id: number;
    operation: string;
    metric_column?: string;
    group_by?: string;
    filters?: unknown[];
    limit?: number;
  };

  type FilterPayload = {
    mode: "filter";
    dataset_id: number;
    filters?: unknown[];
    limit?: number;
    offset?: number;
  };

  function decodePayload(encoded: string): AggregatePayload | FilterPayload {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4;
    const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
    return JSON.parse(atob(padded));
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const encoded = params.get("q");
    if (!encoded) {
      setErr("This URL is not valid or no longer valid");
      return;
    }

    let payload: AggregatePayload | FilterPayload;

    try {
      payload = decodePayload(encoded);
    } catch {
      setErr("This URL is not valid or no longer valid");
      return;
    }

    if ("mode" in payload && payload.mode === "filter") {
      filterRows(payload)
        .then((result: FilterResponse) => {
          setMode("filter");
          setFilterData(result);
          setAggregateData(null);

          const columnSet = new Set<string>(["row_index"]);
          for (const item of result.rowsResult) {
            for (const key of Object.keys(item.row_data || {})) {
              columnSet.add(key);
            }
          }
          const cols = Array.from(columnSet);
          setColumns(cols);

          const mappedRows = result.rowsResult.map((item) => ({
            row_index: item.row_index,
            ...(item.row_data || {}),
          }));
          setRows(mappedRows);
        })
        .catch((error: unknown) => setErr(getErrorMessage(error)));
      return;
    }

    aggregate(payload)
      .then((result: AggregateResponse) => {
        const aggregatePayload = payload as AggregatePayload;
        setMode("aggregate");
        setAggregateData(result);
        setFilterData(null);

        const operationLabel = aggregatePayload.operation.charAt(0).toUpperCase() + aggregatePayload.operation.slice(1);
        const metricCol = result.metric_column ?? "aggregate_value";

        const filterParts = aggregatePayload.filters
          ? (aggregatePayload.filters as { column: string; operator: string; value: string }[])
              .map((f) => `${f.column} ${f.operator} ${f.value}`)
              .join(", ")
          : null;

        const metricColLabel = filterParts
          ? `${operationLabel} of ${metricCol} (${filterParts})`
          : `${operationLabel} of ${metricCol}`;

        const cols: string[] = [];
        if (result.group_by_column) cols.push(result.group_by_column);
        cols.push(metricColLabel);
        setColumns(cols);

        const remapped = result.rowsResult.map((row) => {
          const r: Record<string, unknown> = {};
          if (result.group_by_column) r[result.group_by_column] = row.group_value;
          r[metricColLabel] = row.aggregate_value;
          return r;
        });
        setRows(remapped);
      })
      .catch((error: unknown) => setErr(getErrorMessage(error)));
  }, [location.search]);

  if (err) {
    return (
      <div className="page-stack">
        <p className="error">{err}</p>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="mono">{mode === "filter" ? "Filter Result" : "Aggregate Result"}</div>
        <div className="small">
          {mode === "filter"
            ? `${filterData?.row_count ?? 0} matching rows`
            : aggregateData?.group_by_column
              ? `${aggregateData.metric_column} by ${aggregateData.group_by_column}`
              : aggregateData?.metric_column}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="table-area">
          <DataTable
            columns={columns}
            rows={rows}
          />
        </div>
      )}
    </div>
  );
}

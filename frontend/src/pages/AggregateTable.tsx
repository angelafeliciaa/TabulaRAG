import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { aggregate, type AggregateResponse } from "../api";
import DataTable from "../components/DataTable";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function VirtualTableView() {
  const location = useLocation();
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const encoded = params.get("q");
    if (!encoded) {
      setErr("This URL is not valid or no longer valid");
      return;
    }

    let payload: {
      dataset_id: number;
      operation: string;
      metric_column?: string;
      group_by?: string;
      filters?: unknown[];
      limit?: number;
    };

    try {
      payload = JSON.parse(atob(encoded));
    } catch {
      setErr("This URL is not valid or no longer valid");
      return;
    }

    aggregate(payload)
      .then((result: AggregateResponse) => {
        setData(result);

        const operationLabel = payload.operation.charAt(0).toUpperCase() + payload.operation.slice(1);
        const metricCol = result.metric_column ?? "aggregate_value";
        
        // build filter suffix e.g. "where Country = India"
        const filterParts = payload.filters
          ? (payload.filters as { column: string; operator: string; value: string }[])
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
        <div className="mono">Aggregate Result</div>
        <div className="small">
          {data?.group_by_column
            ? `${data.metric_column} by ${data.group_by_column}`
            : data?.metric_column}
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
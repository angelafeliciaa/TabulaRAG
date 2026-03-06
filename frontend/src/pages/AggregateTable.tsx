import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { aggregate, type AggregateResponse } from "../api";
import DataTable from "../components/DataTable";

const ROWS_PER_PAGE = 500;

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
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [showScrollHint, setShowScrollHint] = useState(false);
  const [tableAtBottom, setTableAtBottom] = useState(false);
  const tableAreaRef = useRef<HTMLDivElement | null>(null);

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
        setCurrentPage(1);
        setPageInput("1");
        setSearchQuery("");
      })
      .catch((error: unknown) => setErr(getErrorMessage(error)));
  }, [location.search]);

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!normalizedSearch) {
      return { rows, rowIndices: rows.map((_, i) => i) };
    }
    const nextRows: Record<string, unknown>[] = [];
    const nextRowIndices: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const matches = Object.values(row).some((value) =>
        String(value ?? "").toLowerCase().includes(normalizedSearch),
      );
      if (matches) {
        nextRows.push(row);
        nextRowIndices.push(i);
      }
    }
    return { rows: nextRows, rowIndices: nextRowIndices };
  }, [rows, normalizedSearch]);

  const totalPages = Math.max(1, Math.ceil(filtered.rows.length / ROWS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageInputWidthCh = Math.max(2, String(totalPages).length + 1);

  const paginatedRows = useMemo(() => {
    const start = (safeCurrentPage - 1) * ROWS_PER_PAGE;
    const end = start + ROWS_PER_PAGE;
    return {
      rows: filtered.rows.slice(start, end),
      rowIndices: filtered.rowIndices.slice(start, end),
    };
  }, [filtered, safeCurrentPage]);

  useEffect(() => {
    setCurrentPage(1);
    setPageInput("1");
  }, [normalizedSearch]);

  useEffect(() => {
    setPageInput(String(safeCurrentPage));
  }, [safeCurrentPage]);

  useEffect(() => {
    const container = tableAreaRef.current;
    const element = container?.querySelector(".table-scroll") as HTMLDivElement | null;
    if (!element) {
      setShowScrollHint(false);
      setTableAtBottom(false);
      return;
    }

    const updateHint = () => {
      const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
      const canScroll = element.scrollHeight > element.clientHeight + 2;
      setShowScrollHint(canScroll);
      setTableAtBottom(atBottom);
    };

    const rafId = window.requestAnimationFrame(updateHint);
    element.addEventListener("scroll", updateHint);
    window.addEventListener("resize", updateHint);

    return () => {
      window.cancelAnimationFrame(rafId);
      element.removeEventListener("scroll", updateHint);
      window.removeEventListener("resize", updateHint);
    };
  }, [paginatedRows.rows.length, columns.length]);

  useEffect(() => {
    const container = tableAreaRef.current;
    const element = container?.querySelector(".table-scroll") as HTMLDivElement | null;
    if (!element) {
      return;
    }
    element.scrollTo({ top: 0, behavior: "auto" });
  }, [currentPage]);

  function scrollTableToEdge() {
    const container = tableAreaRef.current;
    const element = container?.querySelector(".table-scroll") as HTMLDivElement | null;
    if (!element) {
      return;
    }
    if (tableAtBottom) {
      element.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }

  function commitPageInput() {
    const trimmed = pageInput.trim();
    if (!trimmed) {
      setPageInput(String(safeCurrentPage));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(safeCurrentPage));
      return;
    }
    const normalized = Math.trunc(parsed);
    const nextPage = Math.min(totalPages, Math.max(1, normalized));
    setCurrentPage(nextPage);
    setPageInput(String(nextPage));
  }

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
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="mono">Aggregate Result</div>
            <div className="small">
              {data?.group_by_column
                ? `${data.metric_column} by ${data.group_by_column}`
                : data?.metric_column}
              {rows.length > 0 &&
                (normalizedSearch
                  ? ` • ${filtered.rows.length.toLocaleString()} of ${rows.length.toLocaleString()} rows match`
                  : ` • ${rows.length.toLocaleString()} rows`)}
              {totalPages > 1 && ` • Page ${safeCurrentPage} of ${totalPages}`}
            </div>
          </div>
          <div className="table-view-tools">
            <input
              type="text"
              className="table-view-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search for values"
              aria-label="Search rows"
            />
          </div>
        </div>
      </div>

      {paginatedRows.rows.length > 0 && (
        <div className="table-area" ref={tableAreaRef}>
          <DataTable
            columns={columns}
            rows={paginatedRows.rows}
            rowIndices={paginatedRows.rowIndices}
            sortable
          />
          {showScrollHint && (
            <button
              type="button"
              className="scroll-indicator"
              onClick={scrollTableToEdge}
              aria-label={tableAtBottom ? "Scroll table to top" : "Scroll table to bottom"}
              title={tableAtBottom ? "Scroll to top" : "Scroll to bottom"}
            >
              {tableAtBottom ? "▲" : "▼"}
            </button>
          )}
        </div>
      )}

      {filtered.rows.length > ROWS_PER_PAGE && (
        <div className="table-view-pagination" aria-label="Aggregate table pagination">
          <div className="table-view-pagination-controls">
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => setCurrentPage(1)}
              disabled={safeCurrentPage <= 1}
              aria-label="First page"
              title="First page"
            >
              {"<<"}
            </button>
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={safeCurrentPage <= 1}
              aria-label="Previous page"
              title="Previous page"
            >
              {"<"}
            </button>
            <span className="table-view-page-count">
              Page{" "}
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className="table-view-page-input"
                style={{ width: `${pageInputWidthCh}ch` }}
                value={pageInput}
                onChange={(event) => {
                  const digitsOnly = event.target.value.replace(/[^\d]/g, "");
                  setPageInput(digitsOnly);
                }}
                onBlur={commitPageInput}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitPageInput();
                  } else if (event.key === "Escape") {
                    setPageInput(String(safeCurrentPage));
                  }
                }}
                aria-label="Current page number"
                title="Enter page number"
              />{" "}
              of {totalPages}
            </span>
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={safeCurrentPage >= totalPages}
              aria-label="Next page"
              title="Next page"
            >
              {">"}
            </button>
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => setCurrentPage(totalPages)}
              disabled={safeCurrentPage >= totalPages}
              aria-label="Last page"
              title="Last page"
            >
              {">>"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
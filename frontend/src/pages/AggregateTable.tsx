import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  aggregate,
  filterRows,
  fetchRowsByIndices,
  getTableColumns,
  type AggregateResponse,
  type FilterResponse,
} from "../api";
import DataTable from "../components/DataTable";
import { type ValueMode } from "../valueMode";

const MAX_MULTI_HIGHLIGHT_ROWS = 1000;
const QUERY_ROWS_PER_PAGE = 100;
const ROW_HINT_DISMISSED_KEY = "tabularag_query_row_hint_dismissed";

type FilterConditionPayload = {
  column: string;
  operator: string;
  value?: string;
  logical_operator?: "AND" | "OR";
};

type AggregatePayload = {
  dataset_id: number;
  operation: string;
  metric_column?: string;
  group_by?: string;
  filters?: FilterConditionPayload[];
  sort_order?: "asc" | "desc";
  limit?: number;
};

type FilterPayload = {
  mode: "filter";
  dataset_id: number;
  filters?: FilterConditionPayload[];
  limit?: number;
  offset?: number;
  result_title?: string;
};

type SemanticPayload = {
  mode: "semantic";
  dataset_id: number;
  row_indices: number[];
  row_scores?: number[];
  /** Retrieval limit from semantic search (matches backend `top_k`). */
  top_k?: number;
  question?: string;
  columns?: string[] | null;
  result_title?: string;
};

type TableRow = Record<string, unknown> & {
  __highlight_id?: string;
  __row_index?: number;
  __dataset_id?: number;
  __similarity_score?: number;
  __drilldown_filters?: FilterConditionPayload[];
  __drilldown_label?: string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  INR: "₹",
  CAD: "C$",
  AUD: "A$",
  CHF: "CHF",
  CNY: "¥",
  KRW: "₩",
  THB: "฿",
  TRY: "₺",
  RUB: "₽",
};

function formatAggregateValue(
  value: number,
  currency: string | null | undefined,
  unit: string | null | undefined,
): string | number {
  if (currency != null && currency !== "") {
    const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
    const formatted = value.toFixed(2);
    return `${symbol}${formatted}`;
  }
  if (unit != null && unit !== "") {
    const formatted = Number.isInteger(value) ? String(value) : String(value);
    return `${formatted} ${unit}`;
  }
  return value;
}

function encodePayload(value: unknown): string {
  const raw = JSON.stringify(value);
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodePayload(
  encoded: string,
): AggregatePayload | FilterPayload | SemanticPayload {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const decoded = new TextDecoder().decode(bytes);
  return JSON.parse(decoded);
}

function formatFilterSummary(filters?: FilterConditionPayload[]): string {
  if (!filters || filters.length === 0) return "no filters";
  return filters
    .map((f, idx) => {
      const clause =
        f.operator === "IS NULL" || f.operator === "IS NOT NULL"
          ? `${f.column} ${f.operator}`
          : `${f.column} ${f.operator} ${f.value ?? ""}`.trim();
      if (idx === 0) return clause;
      return `${(f.logical_operator || "AND").toUpperCase()} ${clause}`;
    })
    .join(" ");
}

function formatFilterSummaryWithDisplayNames(
  filters: FilterConditionPayload[] | undefined,
  displayNameByNormalized: ReadonlyMap<string, string>,
): string {
  if (!filters || filters.length === 0) return "no filters";
  return filters
    .map((f, idx) => {
      const columnLabel = displayNameByNormalized.get(f.column) ?? f.column;
      const clause =
        f.operator === "IS NULL" || f.operator === "IS NOT NULL"
          ? `${columnLabel} ${f.operator}`
          : `${columnLabel} ${f.operator} ${f.value ?? ""}`.trim();
      if (idx === 0) return clause;
      return `${(f.logical_operator || "AND").toUpperCase()} ${clause}`;
    })
    .join(" ");
}

type AggregateTableProps = {
  valueMode: ValueMode;
};

export default function VirtualTableView({ valueMode }: AggregateTableProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<TableRow[]>([]);
  const [resultTitle, setResultTitle] = useState<string>("Result");
  const [resultSubtitle, setResultSubtitle] = useState<string>("");
  const [resultFilterSubtitle, setResultFilterSubtitle] = useState<string>("");
  const [columnDisplayNameByNormalized, setColumnDisplayNameByNormalized] = useState<Map<string, string>>(new Map());
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [showRowHint, setShowRowHint] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ROW_HINT_DISMISSED_KEY) !== "1";
    } catch {
      return true;
    }
  });

  const [searchState, setSearchState] = useState<{ key: string; value: string }>({
    key: "",
    value: "",
  });
  const parsedQuery = useMemo(() => {
    const params = new URLSearchParams(location.search);
    let encoded = params.get("q");
    if (!encoded && location.hash) {
      const hashParams = new URLSearchParams(location.hash.slice(1));
      encoded = hashParams.get("q");
    }
    if (!encoded) {
      return {
        payload: null as AggregatePayload | FilterPayload | SemanticPayload | null,
        error: "This URL is not valid or no longer valid",
      };
    }
    try {
      return { payload: decodePayload(encoded), error: null as string | null };
    } catch {
      return {
        payload: null as AggregatePayload | FilterPayload | SemanticPayload | null,
        error: "This URL is not valid or no longer valid",
      };
    }
  }, [location.search, location.hash]);

  useEffect(() => {
    const payload = parsedQuery.payload;
    if (!payload || typeof payload.dataset_id !== "number" || !Number.isFinite(payload.dataset_id)) {
      setColumnDisplayNameByNormalized(new Map());
      return;
    }
    let mounted = true;
    getTableColumns(payload.dataset_id)
      .then((meta) => {
        if (!mounted) {
          return;
        }
        const next = new Map<string, string>();
        for (const col of meta.columns || []) {
          const normalized = String(col.normalized_name || "");
          if (!normalized) {
            continue;
          }
          const original = typeof col.original_name === "string" ? col.original_name.trim() : "";
          next.set(normalized, valueMode === "original" && original ? original : normalized);
        }
        setColumnDisplayNameByNormalized(next);
      })
      .catch(() => {
        if (mounted) {
          setColumnDisplayNameByNormalized(new Map());
        }
      });
    return () => {
      mounted = false;
    };
  }, [parsedQuery.payload, valueMode]);

  /** Include hash so `return_to` replays virtual URLs that only carry `q` in `#q=` (see parsedQuery). */
  const virtualReturnTo = useMemo(
    () => `${location.pathname}${location.search}${location.hash}`,
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    if (parsedQuery.error) {
      // Defer to microtask to avoid synchronous setState inside effect body.
      void Promise.resolve().then(() => setErr(parsedQuery.error));
      return;
    }
    if (!parsedQuery.payload) {
      return;
    }

    const payload = parsedQuery.payload;

    if ("mode" in payload && payload.mode === "semantic") {
      const sp = payload as SemanticPayload;
      if (!Array.isArray(sp.row_indices) || sp.row_indices.length === 0) {
        void Promise.resolve().then(() =>
          setErr("Semantic URL is missing row_indices"),
        );
        return;
      }
      fetchRowsByIndices(
        sp.dataset_id,
        sp.row_indices,
        sp.columns === undefined || sp.columns === null ? null : sp.columns,
      )
        .then((result: FilterResponse) => {
          setErr(null);
          const providedTitle =
            typeof sp.result_title === "string" ? sp.result_title.trim() : "";
          const semanticQuestion = typeof sp.question === "string" ? sp.question.trim() : "";
          setResultTitle("Semantic Result");
          setResultSubtitle(providedTitle || semanticQuestion);
          setResultFilterSubtitle("");

          const columnSet = new Set<string>();
          for (const item of result.rowsResult) {
            for (const key of Object.keys(item.row_data || {})) {
              columnSet.add(key);
            }
          }
          setColumns(Array.from(columnSet));

          const mappedRows: TableRow[] = result.rowsResult.map((item, index) => ({
            __row_index: item.row_index,
            __dataset_id: result.dataset_id,
            __highlight_id: item.highlight_id,
            __similarity_score:
              Array.isArray(sp.row_scores) && sp.row_scores.length > 0
                ? Number(sp.row_scores[index] ?? 0)
                : undefined,
            ...(item.row_data || {}),
          }));
          setRows(mappedRows);
        })
        .catch((error: unknown) => setErr(getErrorMessage(error)));
      return;
    }

    if ("mode" in payload && payload.mode === "filter") {
      filterRows(payload)
        .then((result: FilterResponse) => {
          setErr(null);
          const providedTitle =
            typeof payload.result_title === "string" ? payload.result_title.trim() : "";
          setResultTitle("Filter Result");
          setResultSubtitle(
            providedTitle || formatFilterSummaryWithDisplayNames(payload.filters, columnDisplayNameByNormalized),
          );
          setResultFilterSubtitle("");

          const columnSet = new Set<string>();
          for (const item of result.rowsResult) {
            for (const key of Object.keys(item.row_data || {})) {
              columnSet.add(key);
            }
          }
          setColumns(Array.from(columnSet));

          const mappedRows: TableRow[] = result.rowsResult.map((item) => ({
            __row_index: item.row_index,
            __dataset_id: result.dataset_id,
            __highlight_id: item.highlight_id,
            ...(item.row_data || {}),
          }));
          setRows(mappedRows);
        })
        .catch((error: unknown) => setErr(getErrorMessage(error)));
      return;
    }

    aggregate(payload)
      .then((result: AggregateResponse) => {
        setErr(null);
        const aggregatePayload = payload as AggregatePayload;

        const operationLabel =
          aggregatePayload.operation.charAt(0).toUpperCase() + aggregatePayload.operation.slice(1);
        const metricCol = result.metric_column ?? "aggregate_value";
        const metricColDisplay = columnDisplayNameByNormalized.get(metricCol) ?? metricCol;

        const hasFilters = Array.isArray(aggregatePayload.filters) && aggregatePayload.filters.length > 0;
        const filterParts = hasFilters ? formatFilterSummary(aggregatePayload.filters) : null;

        const metricColLabel = filterParts
          ? `${operationLabel} of ${metricColDisplay} (${filterParts})`
          : `${operationLabel} of ${metricColDisplay}`;
        const groupByDisplay = result.group_by_column
          ? (columnDisplayNameByNormalized.get(result.group_by_column) ?? result.group_by_column)
          : null;
        const aggregateSummary = result.group_by_column
          ? `${operationLabel} ${metricColDisplay} by ${groupByDisplay}`
          : `${operationLabel} ${metricColDisplay}`;
        setResultTitle("Aggregate Result");
        setResultSubtitle(aggregateSummary);
        setResultFilterSubtitle(filterParts ? `Filters: ${filterParts}` : "");

        const cols: string[] = [];
        if (result.group_by_column) cols.push(result.group_by_column);
        cols.push(metricColLabel);
        setColumns(cols);

        const remapped: TableRow[] = result.rowsResult.map((row) => {
          const source = row as Record<string, unknown>;
          const groupValue = source.group_value;
          const nextRow: TableRow = {};
          if (result.group_by_column) {
            nextRow[result.group_by_column] = row.group_value;
          }
          nextRow[metricColLabel] = formatAggregateValue(
            row.aggregate_value,
            result.metric_currency ?? null,
            result.metric_unit ?? null,
          );
          nextRow.__dataset_id = result.dataset_id;

          const drilldownFilters = [...(aggregatePayload.filters || [])];
          if (result.group_by_column) {
            if (groupValue === null || groupValue === undefined) {
              drilldownFilters.push({
                column: result.group_by_column,
                operator: "IS NULL",
              });
              nextRow.__drilldown_label = "NULL";
            } else {
              drilldownFilters.push({
                column: result.group_by_column,
                operator: "=",
                value: String(groupValue),
              });
              nextRow.__drilldown_label = String(groupValue);
            }
          } else {
            nextRow.__drilldown_label = "All matching rows";
          }
          nextRow.__drilldown_filters = drilldownFilters;
          return nextRow;
        });
        setRows(remapped);
      })
      .catch((error: unknown) => setErr(getErrorMessage(error)));
  }, [parsedQuery, columnDisplayNameByNormalized]);

  const searchQuery = searchState.key === location.search ? searchState.value : "";
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedSearch) {
      return {
        rows,
        rowIndices: rows.map((row, index) => {
          if (typeof row.__row_index === "number") {
            return row.__row_index;
          }
          if (typeof row.row_index === "number") {
            return Number(row.row_index);
          }
          return index;
        }),
      };
    }

    const nextRows: TableRow[] = [];
    const nextRowIndices: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const matches = Object.values(row).some((value) =>
        String(value ?? "").toLowerCase().includes(normalizedSearch),
      );
      if (!matches) {
        continue;
      }
      nextRows.push(row);
      if (typeof row.__row_index === "number") {
        nextRowIndices.push(row.__row_index);
      } else if (typeof row.row_index === "number") {
        nextRowIndices.push(Number(row.row_index));
      } else {
        nextRowIndices.push(i);
      }
    }

    return { rows: nextRows, rowIndices: nextRowIndices };
  }, [rows, normalizedSearch]);

  const hasRowDrilldown = useMemo(
    () =>
      filtered.rows.some((row) => {
        const sourceDataset =
          typeof row.__dataset_id === "number"
            ? row.__dataset_id
            : null;
        const hasSingleRow =
          typeof row.__row_index === "number"
          || typeof row.row_index === "number";
        const hasMultiRow = Array.isArray(row.__drilldown_filters);
        return sourceDataset !== null && (hasSingleRow || hasMultiRow);
      }),
    [filtered.rows],
  );
  const columnLabels = useMemo(
    () => columns.map((column) => columnDisplayNameByNormalized.get(column) ?? column),
    [columns, columnDisplayNameByNormalized],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.rows.length / QUERY_ROWS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageInputWidthCh = Math.max(2, String(totalPages).length + 1);
  const pagedFiltered = useMemo(() => {
    const start = (safeCurrentPage - 1) * QUERY_ROWS_PER_PAGE;
    const end = start + QUERY_ROWS_PER_PAGE;
    return {
      rows: filtered.rows.slice(start, end),
      rowIndices: filtered.rowIndices.slice(start, end),
    };
  }, [filtered.rowIndices, filtered.rows, safeCurrentPage]);

  useEffect(() => {
    setCurrentPage(1);
    setPageInput("1");
  }, [location.search, normalizedSearch]);

  useEffect(() => {
    setPageInput(String(safeCurrentPage));
  }, [safeCurrentPage]);

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

  function dismissRowHint(persist: boolean) {
    setShowRowHint(false);
    if (!persist) {
      return;
    }
    try {
      window.localStorage.setItem(ROW_HINT_DISMISSED_KEY, "1");
    } catch {
      // Ignore localStorage failures.
    }
  }

  if (err) {
    return (
      <div className="page-stack">
        <p className="error" role="alert">
          {err}
        </p>
      </div>
    );
  }

  return (
    <div className="page-stack virtual-results-page">
      {parsedQuery.error && !err && (
        <p className="error" role="alert">
          {parsedQuery.error}
        </p>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row virtual-results-header-row">
          <div className="virtual-results-header-main">
            <div className="result-title">{resultTitle}</div>
            {resultSubtitle ? <div className="result-subtitle">{resultSubtitle}</div> : null}
            {resultFilterSubtitle ? <div className="result-subtitle">{resultFilterSubtitle}</div> : null}
          </div>
          <div className="table-view-tools virtual-results-tools">
            <div className="table-view-search-wrap">
              <svg className="table-view-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="currentColor" />
              </svg>
              <input
                type="text"
                className="table-view-search"
                value={searchQuery}
                onChange={(event) =>
                  setSearchState({
                    key: location.search,
                    value: event.target.value,
                  })}
                placeholder="Search"
                aria-label="Search results rows"
              />
            </div>
          </div>
        </div>
      </div>

      {filtered.rows.length > 0 && (
        <>
          <div
            className={`table-area aggregate-results-table${hasRowDrilldown ? " aggregate-results-table-clickable" : ""}`}
          >
            <DataTable
              columns={columns}
              columnLabels={columnLabels}
              rows={pagedFiltered.rows}
              rowIndices={pagedFiltered.rowIndices}
              sortable
              onRowClick={
              hasRowDrilldown
                ? ({ row, rowIndex }) => {
                  const sourceDataset =
                    typeof row.__dataset_id === "number"
                      ? row.__dataset_id
                      : null;
                  const sourceRow =
                    typeof row.__row_index === "number"
                      ? row.__row_index
                      : typeof row.row_index === "number"
                        ? Number(row.row_index)
                        : null;

                  if (sourceDataset !== null && Array.isArray(row.__drilldown_filters)) {
                    const spec = encodePayload({
                      dataset_id: sourceDataset,
                      filters: row.__drilldown_filters,
                      label: String(row.__drilldown_label || "All matching rows"),
                      max_rows: MAX_MULTI_HIGHLIGHT_ROWS,
                    });
                    navigate(
                      `/tables/${sourceDataset}?highlight_mode=multi&highlight_spec=${encodeURIComponent(spec)}&return_to=${encodeURIComponent(virtualReturnTo)}`,
                    );
                    return;
                  }

                  if (sourceDataset !== null && sourceRow !== null) {
                    if (filtered.rowIndices.length > 1) {
                      const cursor = Math.max(0, filtered.rowIndices.indexOf(rowIndex));
                      const payload = parsedQuery.payload;
                      const isSemanticVirtual =
                        payload !== null
                        && "mode" in payload
                        && payload.mode === "semantic";
                      const spec = encodePayload({
                        dataset_id: sourceDataset,
                        row_indices: filtered.rowIndices,
                        ...(isSemanticVirtual
                          ? {
                              row_scores: filtered.rows.map((candidate) => {
                                const raw = candidate.__similarity_score;
                                return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
                              }),
                              ...(typeof payload.top_k === "number" && Number.isFinite(payload.top_k)
                                ? { top_k: Math.max(1, Math.trunc(payload.top_k)) }
                                : {}),
                              ...(typeof payload.question === "string" && payload.question.trim()
                                ? { question: payload.question.trim() }
                                : {}),
                            }
                          : {}),
                        label: resultSubtitle.trim() || resultTitle.trim() || "Query results",
                        max_rows: MAX_MULTI_HIGHLIGHT_ROWS,
                        ...(isSemanticVirtual ? { sort_highlight_nav_by_row_index: true } : {}),
                      });
                      navigate(
                        `/tables/${sourceDataset}?highlight_mode=multi&highlight_spec=${encodeURIComponent(spec)}&highlight_cursor=${cursor}&return_to=${encodeURIComponent(virtualReturnTo)}`,
                      );
                      return;
                    }
                    navigate(
                      `/tables/${sourceDataset}?highlight_row=${sourceRow}&return_to=${encodeURIComponent(virtualReturnTo)}`,
                    );
                  }
                }
                : undefined
              }
              rowAction={
              hasRowDrilldown
                ? ({ row }) => {
                  const sourceDataset =
                    typeof row.__dataset_id === "number" ? row.__dataset_id : null;
                  const sourceRow =
                    typeof row.__row_index === "number"
                      ? row.__row_index
                      : typeof row.row_index === "number"
                        ? Number(row.row_index)
                        : null;
                  const hasLink =
                    sourceDataset !== null &&
                    (Array.isArray(row.__drilldown_filters) || sourceRow !== null);
                  if (!hasLink) return null;
                  return (
                    <span
                      className="aggregate-row-open-indicator"
                      aria-hidden="true"
                    >
                      →
                    </span>
                  );
                }
                : undefined
              }
              rowActionLabel=""
            />
            {hasRowDrilldown && showRowHint && (
              <div className="aggregate-row-hint-popover" role="note" aria-live="polite">
                <button
                  type="button"
                  className="aggregate-row-hint-close"
                  onClick={() => dismissRowHint(false)}
                  aria-label="Dismiss hint"
                  title="Dismiss"
                >
                  ×
                </button>
                <div className="aggregate-row-hint-text">
                  Click a row to view ungrouped rows in the full table.
                </div>
                <button
                  type="button"
                  className="aggregate-row-hint-never"
                  onClick={() => dismissRowHint(true)}
                >
                  Don’t show again
                </button>
              </div>
            )}
          </div>
          <div className="table-view-pagination" aria-label="Query table pagination">
            <div className="table-view-pagination-controls">
              <button
                type="button"
                className="table-view-page-btn"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage(1)}
                aria-label="First page"
                title="First page"
              >
                {"<<"}
              </button>
              <button
                type="button"
                className="table-view-page-btn"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage(Math.max(1, safeCurrentPage - 1))}
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
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage(Math.min(totalPages, safeCurrentPage + 1))}
                aria-label="Next page"
                title="Next page"
              >
                {">"}
              </button>
              <button
                type="button"
                className="table-view-page-btn"
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage(totalPages)}
                aria-label="Last page"
                title="Last page"
              >
                {">>"}
              </button>
            </div>
            <span className="table-view-pagination-meta">
              Showing rows{" "}
              {(safeCurrentPage - 1) * QUERY_ROWS_PER_PAGE + 1}–
              {Math.min(safeCurrentPage * QUERY_ROWS_PER_PAGE, filtered.rows.length)} of{" "}
              {filtered.rows.length}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

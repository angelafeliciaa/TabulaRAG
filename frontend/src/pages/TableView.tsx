import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { focusByIndex, focusByOffset } from "../accessibility";
import {
  filterRowIndices,
  getSlice,
  listTables,
  patchTableCell,
  patchTableColumnName,
  type FilterRowIndicesResponse,
  type TableSlice,
  type TableSummary,
} from "../api";
import DataTable from "../components/DataTable";
import TableStatusPage from "../components/TableStatusPage";
import { type ValueMode, flattenRowsByValueMode } from "../valueMode";

type DateViewMode = "default" | "mm-dd-yyyy" | "mon-dd-yyyy";
type DateMenuState = { x: number; y: number } | null;
type FilterConditionPayload = {
  column: string;
  operator: string;
  value?: string;
  logical_operator?: "AND" | "OR";
};
type QueryPayload =
  | {
    mode: "filter";
    dataset_id: number;
    filters?: FilterConditionPayload[];
    limit?: number;
    offset?: number;
    result_title?: string;
  }
  | {
    mode: "semantic";
    dataset_id: number;
    row_indices: number[];
    top_k?: number;
    question?: string;
    columns?: string[] | null;
    result_title?: string;
  }
  | {
    dataset_id: number;
    operation: string;
    metric_column?: string;
    group_by?: string;
    filters?: FilterConditionPayload[];
    sort_order?: "asc" | "desc";
    limit?: number;
  };
type MultiHighlightSpec = {
  dataset_id: number;
  filters?: FilterConditionPayload[];
  /** When set, highlight these dataset row indices in order (filter / semantic virtual results). */
  row_indices?: number[];
  /** Optional semantic similarity scores aligned with row_indices. */
  row_scores?: number[];
  /** Semantic query top_k (retrieval limit), for display. */
  top_k?: number;
  /** Semantic query question, for display heading. */
  question?: string;
  /** Semantic full-table: navigate ▲/▼ in ascending row_index order; filter results keep virtual order. */
  sort_highlight_nav_by_row_index?: boolean;
  label?: string;
  max_rows?: number;
};
const ROWS_PER_PAGE = 500;
const DEFAULT_MULTI_MAX_ROWS = 1000;
const DATE_VIEW_OPTIONS: Array<{ value: DateViewMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "mm-dd-yyyy", label: "MM-DD-YYYY" },
  { value: "mon-dd-yyyy", label: "Jan 12, 2002" },
];

type TableViewProps = {
  valueMode: ValueMode;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Network failure, connection refused, or HTTP 5xx — show full-page server error like 404. */
function isServerDownOr5xxError(error: unknown): boolean {
  const msg = getErrorMessage(error);
  const lower = msg.toLowerCase();
  if (
    lower.includes("failed to fetch")
    || lower.includes("networkerror")
    || lower.includes("network request failed")
    || lower.includes("load failed")
    || lower.includes("connection refused")
    || lower.includes("fetch failed")
  ) {
    return true;
  }
  if (/\(5\d\d\)/.test(msg)) {
    return true;
  }
  if (/request failed \(5\d\d\)/i.test(msg)) {
    return true;
  }
  if (/\b(502|503|504)\b/.test(msg)) {
    return true;
  }
  return false;
}

function parseHttpStatusFromMessage(msg: string): string | null {
  const match = msg.match(/\((\d{3})\)/);
  return match ? match[1] : null;
}

/** Map API error text to the same card copy as other status pages (home offline, 404). */
function tableErrorPageFromMessage(message: string): { code: string; title: string; description: string } {
  const trimmed = message.trim();
  const status = parseHttpStatusFromMessage(trimmed);
  if (status === "404") {
    return {
      code: "404",
      title: "Not Found",
      description: "The table may have been deleted or the ID might be invalid.",
    };
  }
  if (status === "500" || status === "502" || status === "503" || status === "504") {
    return {
      code: "503",
      title: "Service Unavailable",
      description: "The server could not be reached. Try again in a moment.",
    };
  }
  if (status === "400") {
    return { code: "400", title: "Bad Request", description: trimmed };
  }
  if (status === "403") {
    return { code: "403", title: "Forbidden", description: trimmed };
  }
  if (status && /^\d{3}$/.test(status)) {
    return { code: status, title: "Request failed", description: trimmed };
  }
  return {
    code: "Error",
    title: "Request failed",
    description: trimmed,
  };
}

function parseDateToDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const isoMatch = text.match(
    /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/,
  );
  if (isoMatch) {
    const yyyy = isoMatch[1];
    const mm = isoMatch[2].padStart(2, "0");
    const dd = isoMatch[3].padStart(2, "0");
    const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dmyOrMdy = text.match(
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/,
  );
  if (dmyOrMdy) {
    const a = Number(dmyOrMdy[1]);
    const b = Number(dmyOrMdy[2]);
    const rawYear = Number(dmyOrMdy[3]);
    const yyyy = String(rawYear < 100 ? 2000 + rawYear : rawYear);
    let day = a;
    let month = b;
    if (a <= 12 && b > 12) {
      month = a;
      day = b;
    } else if (a <= 12 && b <= 12) {
      day = a;
      month = b;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const parsed = new Date(
        `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  if (/[a-zA-Z]/.test(text)) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function detectDateColumns(rows: Record<string, unknown>[], columns: string[]): Set<string> {
  const sample = rows.slice(0, 300);
  const out = new Set<string>();
  for (const column of columns) {
    let nonEmpty = 0;
    let dateHits = 0;
    for (const row of sample) {
      const raw = row[column];
      if (raw === null || raw === undefined || String(raw).trim() === "") {
        continue;
      }
      nonEmpty += 1;
      if (parseDateToDate(raw)) {
        dateHits += 1;
      }
    }
    if (nonEmpty > 0 && dateHits / nonEmpty >= 0.6) {
      out.add(column);
    }
  }
  return out;
}

function parseNonNegativeInt(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const normalized = Math.trunc(parsed);
  return normalized >= 0 ? normalized : null;
}

function resolveReturnPath(search: string): string {
  const params = new URLSearchParams(search);
  const returnTo = (params.get("return_to") || "").trim();
  if (!returnTo) {
    return "/";
  }
  if (returnTo.startsWith("/")) {
    return returnTo;
  }
  try {
    const parsed = new URL(returnTo);
    if (parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return "/";
  }
  return "/";
}

function decodePayload(encoded: string): QueryPayload {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function decodeMultiHighlightSpec(encoded: string): MultiHighlightSpec {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseExplicitRowIndices(spec: MultiHighlightSpec): number[] | null {
  if (!Array.isArray(spec.row_indices) || spec.row_indices.length === 0) {
    return null;
  }
  const out: number[] = [];
  for (const r of spec.row_indices) {
    if (typeof r !== "number" || !Number.isFinite(r) || r < 0 || r !== Math.trunc(r)) {
      return null;
    }
    out.push(r);
  }
  return out;
}

function formatFilterSummary(filters?: FilterConditionPayload[]): string {
  if (!filters || filters.length === 0) {
    return "no filters";
  }
  return filters
    .map((f, index) => {
      const clause =
        f.operator === "IS NULL" || f.operator === "IS NOT NULL"
          ? `${f.column} ${f.operator}`
          : `${f.column} ${f.operator} ${f.value ?? ""}`.trim();
      if (index === 0) {
        return clause;
      }
      return `${(f.logical_operator || "AND").toUpperCase()} ${clause}`;
    })
    .join(" ");
}

/** Virtual table URLs may put the payload in `?q=` and/or `#q=` (same as AggregateTable). */
function getVirtualTableEncodedQ(returnPath: string): string | null {
  try {
    const parsed = new URL(returnPath, window.location.origin);
    const fromSearch = parsed.searchParams.get("q");
    if (fromSearch) {
      return fromSearch;
    }
    if (parsed.hash.length > 1) {
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      return hashParams.get("q");
    }
    return null;
  } catch {
    return null;
  }
}

function buildQueryContextTitle(returnPath: string): string | null {
  if (!returnPath || returnPath === "/") {
    return null;
  }
  try {
    const encoded = getVirtualTableEncodedQ(returnPath);
    if (!encoded) {
      return null;
    }
    const payload = decodePayload(encoded);
    if ("mode" in payload && payload.mode === "filter") {
      const providedTitle =
        typeof payload.result_title === "string" ? payload.result_title.trim() : "";
      return providedTitle || `Filter result: ${formatFilterSummary(payload.filters)}`;
    }
    if ("mode" in payload && payload.mode === "semantic") {
      const question = typeof payload.question === "string" ? payload.question.trim() : "";
      if (question) {
        return `Semantic results: ${question}`;
      }
      return "Semantic results";
    }

    const aggregatePayload = payload as Exclude<
      QueryPayload,
      { mode: "filter" } | { mode: "semantic" }
    >;
    const operationLabel =
      aggregatePayload.operation.charAt(0).toUpperCase() + aggregatePayload.operation.slice(1);
    const metricCol = aggregatePayload.metric_column ?? "aggregate_value";
    if (aggregatePayload.group_by) {
      return `Aggregate result: ${operationLabel} ${metricCol} by ${aggregatePayload.group_by}`;
    }
    return `Aggregate result: ${operationLabel} of ${metricCol}`;
  } catch {
    return null;
  }
}

export default function TableView({ valueMode }: TableViewProps) {
  const { datasetId } = useParams();
  const location = useLocation();
  const numericDatasetId = Number(datasetId);
  const queryParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const highlightedRow = parseNonNegativeInt(queryParams.get("highlight_row"));
  const highlightMode = queryParams.get("highlight_mode");
  const encodedHighlightSpec = queryParams.get("highlight_spec");
  const highlightCursorParam = parseNonNegativeInt(queryParams.get("highlight_cursor"));
  const isMultiHighlightMode = highlightMode === "multi" && !!encodedHighlightSpec;
  /** Physical dataset view (`/tables/:id`) without multi-highlight: load all rows, no pagination. */
  const isPlainDatasetView = !isMultiHighlightMode;
  const returnPath = resolveReturnPath(location.search);
  const sourceQueryTitle = useMemo(() => buildQueryContextTitle(returnPath), [returnPath]);
  const returnQueryMode = useMemo<"filter" | "aggregate" | "semantic" | null>(() => {
    if (!returnPath || returnPath === "/") {
      return null;
    }
    try {
      const encoded = getVirtualTableEncodedQ(returnPath);
      if (!encoded) {
        return null;
      }
      const payload = decodePayload(encoded);
      if ("mode" in payload && payload.mode === "filter") {
        return "filter";
      }
      if ("mode" in payload && payload.mode === "semantic") {
        return "semantic";
      }
      return "aggregate";
    } catch {
      return null;
    }
  }, [returnPath]);
  const parsedMultiSpec = useMemo(() => {
    if (!isMultiHighlightMode || !encodedHighlightSpec) {
      return null;
    }
    try {
      return decodeMultiHighlightSpec(encodedHighlightSpec);
    } catch {
      return null;
    }
  }, [encodedHighlightSpec, isMultiHighlightMode]);

  const [data, setData] = useState<TableSlice | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [highlightErr, setHighlightErr] = useState<string | null>(null);
  const [tableName, setTableName] = useState<string | null>(null);
  const [tableDescription, setTableDescription] = useState<string>("");
  const [tableNotFound, setTableNotFound] = useState(false);
  const awaitingCatalog =
    isPlainDatasetView && tableName === null && !tableNotFound;
  const [serverError, setServerError] = useState(false);
  const [tableRowCount, setTableRowCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dateViewMode, setDateViewMode] = useState<DateViewMode>("default");
  const [dateMenu, setDateMenu] = useState<DateMenuState>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [showScrollHint, setShowScrollHint] = useState(false);
  const [tableAtBottom, setTableAtBottom] = useState(false);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [sliceEpoch, setSliceEpoch] = useState(0);
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  const [saveSlowHint, setSaveSlowHint] = useState(false);
  const [pendingEdits, setPendingEdits] = useState<
    Map<string, { rowIndex: number; column: string; value: string }>
  >(() => new Map());
  const [pendingColumnEdits, setPendingColumnEdits] = useState<
    Map<string, { column: string; value: string }>
  >(() => new Map());
  const [multiHighlightRows, setMultiHighlightRows] = useState<number[]>([]);
  const [multiHighlightTotal, setMultiHighlightTotal] = useState(0);
  const [multiHighlightTruncated, setMultiHighlightTruncated] = useState(false);
  const [activeHighlightCursor, setActiveHighlightCursor] = useState(0);
  const [multiHighlightLabel, setMultiHighlightLabel] = useState("All matching rows");
  const dateMenuId = useId();
  const tableAreaRef = useRef<HTMLDivElement | null>(null);
  const dateMenuRef = useRef<HTMLDivElement | null>(null);
  const dateMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pageChangeSourceRef = useRef<"table" | "highlight">("table");
  /** Tracks last page for multi-highlight sync — only snap cursor when the *page* changes (pagination), not when only the cursor changes (arrows preserve semantic order). */
  const prevPageForHighlightSyncRef = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(numericDatasetId) || numericDatasetId <= 0) {
      return;
    }

    setErr(null);
    setData(null);
    setTableName(null);
    setTableDescription("");
    setTableNotFound(false);
    setServerError(false);
    setTableRowCount(0);
    setDateMenu(null);

    let mounted = true;
    listTables({ includePending: true })
      .then((tables: TableSummary[]) => {
        if (!mounted) {
          return;
        }
        const table = tables.find((row) => row.dataset_id === numericDatasetId);
        if (!table) {
          setTableNotFound(true);
          return;
        }
        setTableName(table.name);
        setTableDescription((table.description || "").trim());
        if (typeof table.row_count === "number") {
          setTableRowCount(Math.max(0, table.row_count));
        }
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }
        if (isServerDownOr5xxError(error)) {
          setServerError(true);
        }
      });

    return () => {
      mounted = false;
    };
  }, [numericDatasetId]);

  useEffect(() => {
    setPendingEdits(new Map());
    setPendingColumnEdits(new Map());
  }, [numericDatasetId, valueMode, dateViewMode]);

  useEffect(() => {
    if (!isSavingEdits) {
      setSaveSlowHint(false);
      return;
    }
    setSaveSlowHint(false);
    const id = window.setTimeout(() => setSaveSlowHint(true), 5000);
    return () => window.clearTimeout(id);
  }, [isSavingEdits]);

  useEffect(() => {
    if (!datasetId) {
      return;
    }
    if (!Number.isFinite(numericDatasetId) || numericDatasetId <= 0) {
      document.title = "Error 404 | TabulaRAG";
      return;
    }
    if (serverError) {
      document.title = "Error 503 | TabulaRAG";
    } else if (err || highlightErr) {
      document.title = "Error | TabulaRAG";
    } else if (tableNotFound) {
      document.title = "Error 404 | TabulaRAG";
    } else if (tableName) {
      document.title = `${tableName} | TabulaRAG`;
    }
  }, [datasetId, numericDatasetId, tableName, tableNotFound, serverError, err, highlightErr]);

  useEffect(() => {
    if (!isMultiHighlightMode) {
      setHighlightErr(null);
      setMultiHighlightRows([]);
      setMultiHighlightTotal(0);
      setMultiHighlightTruncated(false);
      setActiveHighlightCursor(0);
      setMultiHighlightLabel("All matching rows");
      return;
    }

    if (!parsedMultiSpec) {
      setHighlightErr("This highlight link is invalid or expired.");
      setMultiHighlightRows([]);
      setMultiHighlightTotal(0);
      setMultiHighlightTruncated(false);
      setActiveHighlightCursor(0);
      setMultiHighlightLabel("All matching rows");
      return;
    }

    if (parsedMultiSpec.dataset_id !== numericDatasetId) {
      setHighlightErr("This highlight link does not match the selected dataset.");
      setMultiHighlightRows([]);
      setMultiHighlightTotal(0);
      setMultiHighlightTruncated(false);
      setActiveHighlightCursor(0);
      setMultiHighlightLabel(parsedMultiSpec.label || "All matching rows");
      return;
    }

    const maxRows = Math.max(1, Math.min(parsedMultiSpec.max_rows ?? DEFAULT_MULTI_MAX_ROWS, DEFAULT_MULTI_MAX_ROWS));
    const explicitIndices = parseExplicitRowIndices(parsedMultiSpec);

    if (explicitIndices !== null) {
      setHighlightErr(null);
      const truncated = explicitIndices.length > maxRows;
      let indices = truncated ? explicitIndices.slice(0, maxRows) : explicitIndices;
      const semanticCursor = Math.min(
        highlightCursorParam ?? 0,
        Math.max(0, indices.length - 1),
      );
      const focusedRow = indices[semanticCursor];
      if (parsedMultiSpec.sort_highlight_nav_by_row_index) {
        indices = [...indices].sort((a, b) => a - b);
      }
      const navCursor = parsedMultiSpec.sort_highlight_nav_by_row_index
        ? Math.max(0, indices.indexOf(focusedRow))
        : semanticCursor;
      setMultiHighlightRows(indices);
      setMultiHighlightTotal(explicitIndices.length);
      setMultiHighlightTruncated(truncated);
      setActiveHighlightCursor(navCursor);
      setMultiHighlightLabel(parsedMultiSpec.label || "Query results");
      if (indices.length > 0) {
        const targetRow = focusedRow;
        const initialHighlightPage = Math.floor(targetRow / ROWS_PER_PAGE) + 1;
        pageChangeSourceRef.current = "highlight";
        setCurrentPage(initialHighlightPage);
        setPageInput(String(initialHighlightPage));
      }
      return;
    }

    let mounted = true;
    setHighlightErr(null);
    pageChangeSourceRef.current = "table";
    setCurrentPage(1);
    setPageInput("1");
    filterRowIndices({
      dataset_id: parsedMultiSpec.dataset_id,
      filters: parsedMultiSpec.filters,
      max_rows: maxRows,
    })
      .then((result: FilterRowIndicesResponse) => {
        if (!mounted) {
          return;
        }
        setMultiHighlightRows(result.row_indices);
        setMultiHighlightTotal(result.total_match_count);
        setMultiHighlightTruncated(result.truncated);
        const initialCursor = Math.min(
          highlightCursorParam ?? 0,
          Math.max(0, result.row_indices.length - 1),
        );
        setActiveHighlightCursor(initialCursor);
        setMultiHighlightLabel(parsedMultiSpec.label || "All matching rows");
        if (result.row_indices.length > 0) {
          const targetRow = result.row_indices[initialCursor];
          const initialHighlightPage = Math.floor(targetRow / ROWS_PER_PAGE) + 1;
          pageChangeSourceRef.current = "highlight";
          setCurrentPage(initialHighlightPage);
          setPageInput(String(initialHighlightPage));
        }
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }
        setHighlightErr(getErrorMessage(error));
        setMultiHighlightRows([]);
        setMultiHighlightTotal(0);
        setMultiHighlightTruncated(false);
        setActiveHighlightCursor(0);
        setMultiHighlightLabel(parsedMultiSpec.label || "All matching rows");
      });

    return () => {
      mounted = false;
    };
  }, [isMultiHighlightMode, parsedMultiSpec, numericDatasetId, highlightCursorParam]);

  useEffect(() => {
    const initialPage = highlightedRow !== null ? Math.floor(highlightedRow / ROWS_PER_PAGE) + 1 : 1;
    if (isMultiHighlightMode) {
      setSearchQuery("");
      return;
    }
    pageChangeSourceRef.current = "table";
    setCurrentPage(initialPage);
    setPageInput(String(initialPage));
    setSearchQuery("");
    setSortColumn(null);
    setSortDirection("asc");
  }, [numericDatasetId, highlightedRow, isMultiHighlightMode]);

  useEffect(() => {
    if (!isMultiHighlightMode || activeHighlightCursor < multiHighlightRows.length) {
      return;
    }
    setActiveHighlightCursor(Math.max(0, multiHighlightRows.length - 1));
  }, [activeHighlightCursor, isMultiHighlightMode, multiHighlightRows.length]);

  useEffect(() => {
    if (!isMultiHighlightMode || multiHighlightRows.length === 0) {
      prevPageForHighlightSyncRef.current = null;
      return;
    }
    if (pageChangeSourceRef.current === "highlight") {
      pageChangeSourceRef.current = "table";
      prevPageForHighlightSyncRef.current = currentPage;
      return;
    }

    const prev = prevPageForHighlightSyncRef.current;
    if (prev === null) {
      prevPageForHighlightSyncRef.current = currentPage;
      return;
    }
    if (prev === currentPage) {
      return;
    }

    prevPageForHighlightSyncRef.current = currentPage;

    const normalizedPage = Math.max(1, currentPage);
    const pageStart = (normalizedPage - 1) * ROWS_PER_PAGE;
    const pageEndExclusive = pageStart + ROWS_PER_PAGE;
    const firstIndexOnPage = multiHighlightRows.findIndex(
      (rowIndex) => rowIndex >= pageStart && rowIndex < pageEndExclusive,
    );
    if (firstIndexOnPage !== -1) {
      setActiveHighlightCursor(firstIndexOnPage);
    }
  }, [currentPage, isMultiHighlightMode, multiHighlightRows]);

  const activeMultiHighlightedRow = useMemo(() => {
    if (!isMultiHighlightMode || multiHighlightRows.length === 0) {
      return null;
    }
    return multiHighlightRows[Math.max(0, Math.min(activeHighlightCursor, multiHighlightRows.length - 1))];
  }, [activeHighlightCursor, isMultiHighlightMode, multiHighlightRows]);

  useEffect(() => {
    if (!Number.isFinite(numericDatasetId) || numericDatasetId <= 0) {
      return;
    }
    if (tableNotFound) {
      return;
    }
    if (awaitingCatalog) {
      return;
    }

    let mounted = true;
    setErr(null);
    setLoading(true);

    const sort =
      sortColumn != null
        ? { sortColumn, sortDirection }
        : null;

    let rowFrom: number;
    let rowTo: number;
    if (isMultiHighlightMode) {
      const pageOffset = (currentPage - 1) * ROWS_PER_PAGE;
      rowFrom = pageOffset;
      rowTo = pageOffset + ROWS_PER_PAGE;
    } else {
      rowFrom = 0;
      rowTo = Math.max(1, tableRowCount);
    }

    getSlice(numericDatasetId, rowFrom, rowTo, { flatten: false, sort })
      .then((slice) => {
        if (!mounted) {
          return;
        }
        setServerError(false);
        setData(slice);
        setSliceEpoch((v) => v + 1);
        setTableRowCount((previous) => Math.max(previous, Math.max(0, slice.row_count || 0)));

        if (isMultiHighlightMode) {
          const fetchedTotalPages = Math.max(
            1,
            Math.ceil(Math.max(0, slice.row_count || 0) / ROWS_PER_PAGE),
          );
          if (currentPage > fetchedTotalPages) {
            setCurrentPage(fetchedTotalPages);
          }
        }
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }
        if (isServerDownOr5xxError(error)) {
          setServerError(true);
        } else {
          setErr(getErrorMessage(error));
        }
        setData(null);
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [
    numericDatasetId,
    isMultiHighlightMode ? currentPage : 0,
    sortColumn,
    sortDirection,
    isMultiHighlightMode,
    awaitingCatalog,
    tableNotFound,
    tableRowCount,
  ]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const effectiveRowCount = Math.max(tableRowCount, Math.max(0, data?.row_count || 0));

  const handleCellDraftChange = useCallback(
    (payload: {
      rowIndex: number;
      column: string;
      value: string;
      baseline: string;
    }) => {
      const key = `${payload.rowIndex}:${payload.column}`;
      setPendingEdits((prev) => {
        const next = new Map(prev);
        if (payload.value === payload.baseline) {
          next.delete(key);
        } else {
          next.set(key, {
            rowIndex: payload.rowIndex,
            column: payload.column,
            value: payload.value,
          });
        }
        return next;
      });
    },
    [],
  );

  const handleSaveEdits = useCallback(async () => {
    if (!Number.isFinite(numericDatasetId) || numericDatasetId <= 0) {
      return;
    }
    const edits = [...pendingEdits.values()];
    const columnEdits = [...pendingColumnEdits.values()];
    if (edits.length === 0 && columnEdits.length === 0) {
      return;
    }
    setIsSavingEdits(true);
    setErr(null);
    try {
      for (const edit of edits) {
        await patchTableCell(
          numericDatasetId,
          edit.rowIndex,
          edit.column,
          edit.value,
        );
      }
      for (const edit of columnEdits) {
        await patchTableColumnName(
          numericDatasetId,
          edit.column,
          edit.value,
        );
      }
      const sort =
        sortColumn != null ? { sortColumn, sortDirection } : null;
      const rowTo = Math.max(
        1,
        Math.max(tableRowCount, Math.max(0, data?.row_count || 0)),
      );
      const slice = await getSlice(numericDatasetId, 0, rowTo, {
        flatten: false,
        sort,
      });
      setData(slice);
      setSliceEpoch((v) => v + 1);
      setPendingEdits(new Map());
      setPendingColumnEdits(new Map());
    } catch (error: unknown) {
      setErr(getErrorMessage(error));
    } finally {
      setIsSavingEdits(false);
    }
  }, [
    pendingEdits,
    pendingColumnEdits,
    numericDatasetId,
    sortColumn,
    sortDirection,
    tableRowCount,
    data?.row_count,
  ]);
  const handleHeaderDraftChange = useCallback(
    (payload: { column: string; value: string; baseline: string }) => {
      const key = payload.column;
      const nextValue = payload.value.trim();
      const baseline = payload.baseline.trim();
      setPendingColumnEdits((prev) => {
        const next = new Map(prev);
        if (!nextValue || nextValue === baseline) {
          next.delete(key);
        } else {
          next.set(key, { column: payload.column, value: nextValue });
        }
        return next;
      });
    },
    [],
  );

  const pendingCellEditKeys = useMemo(
    () => new Set(pendingEdits.keys()),
    [pendingEdits],
  );
  const pendingCellEditValues = useMemo(() => {
    const next = new Map<string, string>();
    for (const [key, edit] of pendingEdits.entries()) {
      next.set(key, edit.value);
    }
    return next;
  }, [pendingEdits]);
  const pendingHeaderColumnsSet = useMemo(
    () => new Set(pendingColumnEdits.keys()),
    [pendingColumnEdits],
  );

  const handleRevertEdits = useCallback(() => {
    if (isSavingEdits) {
      return;
    }
    setPendingEdits(new Map());
    setPendingColumnEdits(new Map());
    setSliceEpoch((v) => v + 1);
  }, [isSavingEdits]);

  const totalPages = isPlainDatasetView
    ? 1
    : Math.max(1, Math.ceil(effectiveRowCount / ROWS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const hasQueryContext = returnPath !== "/";
  const effectiveHighlightRow = isMultiHighlightMode ? activeMultiHighlightedRow : highlightedRow;
  const highlightedRows = isMultiHighlightMode
    ? multiHighlightRows
    : highlightedRow !== null
      ? [highlightedRow]
      : [];
  const semanticMultiHighlightTopK = useMemo(() => {
    if (!isMultiHighlightMode || returnQueryMode !== "semantic") {
      return null;
    }
    if (
      parsedMultiSpec != null
      && typeof parsedMultiSpec.top_k === "number"
      && Number.isFinite(parsedMultiSpec.top_k)
    ) {
      return Math.max(1, Math.trunc(parsedMultiSpec.top_k));
    }
    try {
      const encoded = getVirtualTableEncodedQ(returnPath);
      if (!encoded) {
        return null;
      }
      const payload = decodePayload(encoded);
      if (
        "mode" in payload
        && payload.mode === "semantic"
        && typeof payload.top_k === "number"
        && Number.isFinite(payload.top_k)
      ) {
        return Math.max(1, Math.trunc(payload.top_k));
      }
    } catch {
      // ignore
    }
    const n = parsedMultiSpec?.row_indices?.length;
    if (typeof n === "number" && n > 0) {
      return n;
    }
    return null;
  }, [isMultiHighlightMode, returnQueryMode, parsedMultiSpec, returnPath]);

  const semanticRowOpacityByIndex = useMemo(() => {
    if (
      !isMultiHighlightMode
      || !parsedMultiSpec
      || !Array.isArray(parsedMultiSpec.row_indices)
      || !Array.isArray(parsedMultiSpec.row_scores)
    ) {
      return undefined;
    }
    const { row_indices: rowIndices, row_scores: rowScores } = parsedMultiSpec;
    const pairs: Array<{ rowIndex: number; score: number }> = [];
    for (let i = 0; i < Math.min(rowIndices.length, rowScores.length); i += 1) {
      const rowIndex = Number(rowIndices[i]);
      const score = Number(rowScores[i]);
      if (Number.isFinite(rowIndex) && Number.isFinite(score)) {
        pairs.push({ rowIndex, score });
      }
    }
    if (pairs.length === 0) {
      return undefined;
    }
    const maxScore = Math.max(...pairs.map((pair) => pair.score));
    const minScore = Math.min(...pairs.map((pair) => pair.score));
    const scoreRange = maxScore - minScore;
    const minAlpha = 0.18;
    const maxAlpha = 0.5;
    const map = new Map<number, number>();
    for (const { rowIndex, score } of pairs) {
      const normalized = scoreRange > 1e-9 ? (score - minScore) / scoreRange : 1;
      map.set(rowIndex, minAlpha + normalized * (maxAlpha - minAlpha));
    }
    return map;
  }, [isMultiHighlightMode, parsedMultiSpec]);
  const pageInputWidthCh = Math.max(2, String(totalPages).length + 1);
  const resolvedRows = useMemo(
    () => (data ? flattenRowsByValueMode(data.rows, valueMode) : []),
    [data, valueMode],
  );
  const normalizedRows = useMemo(
    () => (data ? flattenRowsByValueMode(data.rows, "normalized") : []),
    [data],
  );
  const headerTitle = useMemo(() => {
    if (isMultiHighlightMode) {
      if (returnQueryMode === "filter") {
        return "Filter Result";
      }
      if (returnQueryMode === "semantic") {
        return "Semantic Result";
      }
      return "Aggregate Result";
    }
    if (highlightedRow !== null && returnQueryMode === "filter") {
      if (sourceQueryTitle) {
        return sourceQueryTitle;
      }
      return "Filter Result";
    }
    if (sourceQueryTitle) {
      return sourceQueryTitle;
    }
    return tableName || "Table";
  }, [
    highlightedRow,
    isMultiHighlightMode,
    returnQueryMode,
    sourceQueryTitle,
    tableName,
  ]);
  const dateColumns = useMemo(
    () => (data ? detectDateColumns(resolvedRows, data.columns) : new Set<string>()),
    [data, resolvedRows],
  );
  const filtered = useMemo(() => {
    if (!data) {
      return { rows: [] as Record<string, unknown>[], rowIndices: [] as number[] };
    }
    const indices = data.row_indices ?? resolvedRows.map((_, index) => data.offset + index);
    if (!normalizedSearch) {
      return {
        rows: resolvedRows,
        rowIndices: indices,
      };
    }

    const nextRows: Record<string, unknown>[] = [];
    const nextRowIndices: number[] = [];
    for (let i = 0; i < resolvedRows.length; i += 1) {
      const row = resolvedRows[i];
      const matches = Object.values(row).some((value) =>
        String(value ?? "").toLowerCase().includes(normalizedSearch),
      );
      if (matches) {
        nextRows.push(row);
        nextRowIndices.push(indices[i]);
      }
    }
    return { rows: nextRows, rowIndices: nextRowIndices };
  }, [data, normalizedSearch, resolvedRows]);

  const displayRows = useMemo(() => {
    if (!data || dateViewMode === "default" || dateColumns.size === 0) {
      return filtered.rows;
    }

    const monthFormatter = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
      timeZone: "UTC",
    });

    return filtered.rows.map((row) => {
      const next = { ...row };
      for (const col of dateColumns) {
        const parsed = parseDateToDate(next[col]);
        if (!parsed) {
          continue;
        }
        if (dateViewMode === "mm-dd-yyyy") {
          const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
          const dd = String(parsed.getUTCDate()).padStart(2, "0");
          const yyyy = parsed.getUTCFullYear();
          next[col] = `${mm}-${dd}-${yyyy}`;
        } else if (dateViewMode === "mon-dd-yyyy") {
          next[col] = monthFormatter.format(parsed);
        }
      }
      return next;
    });
  }, [data, dateColumns, dateViewMode, filtered.rows]);

  const sortRows = useMemo(() => {
    if (!data || normalizedRows.length === 0) {
      return undefined;
    }
    if (data.row_indices) {
      return normalizedRows;
    }
    return filtered.rowIndices.map((ri) => normalizedRows[ri - data.offset]);
  }, [data, filtered.rowIndices, normalizedRows]);

  useEffect(() => {
    if (!dateMenu) {
      return;
    }
    const close = () => setDateMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDateMenu(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dateMenu]);

  useEffect(() => {
    if (!dateMenu) {
      return;
    }

    const activeIndex = DATE_VIEW_OPTIONS.findIndex(
      (option) => option.value === dateViewMode,
    );
    const rafId = window.requestAnimationFrame(() => {
      focusByIndex(dateMenuItemRefs.current, activeIndex === -1 ? 0 : activeIndex);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [dateMenu, dateViewMode]);

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
  }, [displayRows.length, data?.columns.length, data?.offset, loading, err, dateViewMode]);

  useEffect(() => {
    if (isPlainDatasetView) {
      return;
    }
    const container = tableAreaRef.current;
    const element = container?.querySelector(".table-scroll") as HTMLDivElement | null;
    if (!element) {
      return;
    }
    element.scrollTo({ top: 0, behavior: "auto" });
  }, [currentPage, isPlainDatasetView]);

  useEffect(() => {
    setPageInput(String(safeCurrentPage));
  }, [safeCurrentPage]);

  useEffect(() => {
    const shouldWarnOnUnload =
      isPlainDatasetView && (pendingEdits.size > 0 || pendingColumnEdits.size > 0);
    if (!shouldWarnOnUnload) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Required for Chrome/Edge to show the native confirmation prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [isPlainDatasetView, pendingEdits.size, pendingColumnEdits.size]);

  useEffect(() => {
    if (effectiveHighlightRow === null || !data) {
      return;
    }

    if (effectiveHighlightRow < data.offset || effectiveHighlightRow >= data.offset + data.rows.length) {
      return;
    }

    const targetElement = document.querySelector(
      `[data-row-index="${effectiveHighlightRow}"]`,
    ) as HTMLElement | null;

    const container = tableAreaRef.current?.querySelector(".table-scroll") as HTMLDivElement | null;
    if (!targetElement || !container) {
      return;
    }

    window.setTimeout(() => {
      const targetRect = targetElement.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const scrollOffset =
        container.scrollTop +
        (targetRect.top - containerRect.top) +
        targetRect.height / 2 -
        container.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, scrollOffset), behavior: "smooth" });
    }, 0);
  }, [data, effectiveHighlightRow, displayRows.length, dateViewMode]);

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
    pageChangeSourceRef.current = "table";
    setCurrentPage(nextPage);
    setPageInput(String(nextPage));
  }

  function jumpToHighlight() {
    if (effectiveHighlightRow === null) {
      return;
    }
    if (isPlainDatasetView) {
      const targetElement = document.querySelector(
        `[data-row-index="${effectiveHighlightRow}"]`,
      ) as HTMLElement | null;
      const container = tableAreaRef.current?.querySelector(".table-scroll") as HTMLDivElement | null;
      if (targetElement && container) {
        const targetRect = targetElement.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const scrollOffset =
          container.scrollTop +
          (targetRect.top - containerRect.top) +
          targetRect.height / 2 -
          container.clientHeight / 2;
        container.scrollTo({ top: Math.max(0, scrollOffset), behavior: "smooth" });
      }
      return;
    }
    const highlightPage = Math.floor(effectiveHighlightRow / ROWS_PER_PAGE) + 1;
    if (safeCurrentPage !== highlightPage) {
      pageChangeSourceRef.current = "highlight";
      setCurrentPage(highlightPage);
      return;
    }
    const targetElement = document.querySelector(
      `[data-row-index="${effectiveHighlightRow}"]`,
    ) as HTMLElement | null;
    const container = tableAreaRef.current?.querySelector(".table-scroll") as HTMLDivElement | null;
    if (targetElement && container) {
      const targetRect = targetElement.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const scrollOffset =
        container.scrollTop +
        (targetRect.top - containerRect.top) +
        targetRect.height / 2 -
        container.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, scrollOffset), behavior: "smooth" });
    }
  }

  function moveMultiHighlightCursor(offset: number) {
    if (!isMultiHighlightMode || multiHighlightRows.length === 0) {
      return;
    }
    const nextCursor = Math.max(
      0,
      Math.min(multiHighlightRows.length - 1, activeHighlightCursor + offset),
    );
    if (nextCursor !== activeHighlightCursor) {
      const targetRow = multiHighlightRows[nextCursor];
      const highlightPage = Math.floor(targetRow / ROWS_PER_PAGE) + 1;
      setActiveHighlightCursor(nextCursor);
      pageChangeSourceRef.current = "highlight";
      setCurrentPage(highlightPage);
      setPageInput(String(highlightPage));
    } else {
      jumpToHighlight();
    }
  }

  function selectDateViewMode(nextMode: DateViewMode) {
    setDateViewMode(nextMode);
    setDateMenu(null);
  }

  function onDateMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const currentTarget = event.target as HTMLElement | null;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusByOffset(dateMenuItemRefs.current, currentTarget, 1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusByOffset(dateMenuItemRefs.current, currentTarget, -1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusByIndex(dateMenuItemRefs.current, 0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusByIndex(dateMenuItemRefs.current, DATE_VIEW_OPTIONS.length - 1);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setDateMenu(null);
      return;
    }

    if (event.key === "Tab") {
      setDateMenu(null);
    }
  }

  if (!datasetId) {
    return null;
  }

  if (!Number.isFinite(numericDatasetId) || numericDatasetId <= 0) {
    return (
      <TableStatusPage
        code="404"
        title="Not Found"
        description="The table may have been deleted or the ID might be invalid."
      />
    );
  }

  if (serverError) {
    return (
      <TableStatusPage
        code="503"
        title="Service Unavailable"
        description="The server could not be reached. Try again in a moment."
      />
    );
  }

  if (tableNotFound) {
    return (
      <TableStatusPage
        code="404"
        title="Not Found"
        description="The table may have been deleted or the ID might be invalid."
      />
    );
  }

  const blockingMessage = err || highlightErr;
  if (blockingMessage) {
    const page = tableErrorPageFromMessage(blockingMessage);
    return (
      <TableStatusPage code={page.code} title={page.title} description={page.description} />
    );
  }

  const pendingEditHint =
    isPlainDatasetView
      && (pendingEdits.size + pendingColumnEdits.size) > 0
      ? ` • ${
          pendingEdits.size
          + pendingColumnEdits.size
        } unsaved change${
          pendingEdits.size
          + pendingColumnEdits.size
          === 1
            ? ""
            : "s"
        }`
      : "";
  const effectiveDescription = tableDescription.trim();
  const hasUnsavedChanges =
    isPlainDatasetView
    && (
      pendingEdits.size > 0
      || pendingColumnEdits.size > 0
    );

  return (
    <div
      className={`page-stack full-table-page${isPlainDatasetView ? " full-table-page-dataset-wide" : ""}${isMultiHighlightMode && multiHighlightRows.length > 0 ? " has-highlight-nav" : ""}`}
    >
      {hasQueryContext && (isMultiHighlightMode || highlightedRow !== null) && (
        <div className="table-view-back-row">
          <Link className="table-view-context-btn table-view-context-btn-text" to={returnPath} aria-label="Back to Query Results" title="Back to Query Results">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M20 11H7.83l4.59-4.59a1 1 0 1 0-1.42-1.41l-6.3 6.29a1 1 0 0 0 0 1.42l6.3 6.29a1 1 0 1 0 1.42-1.41L7.83 13H20a1 1 0 1 0 0-2Z" fill="currentColor" />
            </svg>
            Back to Query Results
          </Link>
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row table-view-header-row" style={{ justifyContent: "space-between" }}>
          <div className="table-view-header-main">
            <div className="table-view-title">{headerTitle}</div>
            {isMultiHighlightMode && (
              <div className="table-view-row-meta table-view-header-status">
                <span>
                  {returnQueryMode === "semantic"
                    ? `${(multiHighlightLabel || parsedMultiSpec?.question || "Query").trim()}: top-${semanticMultiHighlightTopK ?? Math.max(1, multiHighlightRows.length)} results`
                    : `${(multiHighlightLabel || parsedMultiSpec?.label || "Result").trim()}: ${multiHighlightTotal.toLocaleString()} results`}
                  {returnQueryMode !== "semantic" && multiHighlightTruncated
                    ? ` (showing first ${DEFAULT_MULTI_MAX_ROWS.toLocaleString()})`
                    : ""}
                </span>
              </div>
            )}
            {!isMultiHighlightMode && highlightedRow !== null && (
              <div className="table-view-row-meta table-view-header-status">
                <span>Viewing:</span>{" "}
                <button
                  type="button"
                  className="table-view-row-jump"
                  onClick={jumpToHighlight}
                  aria-label={`Viewing row ${highlightedRow + 1}. Click to jump to highlighted row`}
                  title={`Jump to highlighted row ${highlightedRow + 1}`}
                >
                  Row {highlightedRow + 1}
                </button>
              </div>
            )}
            {!isMultiHighlightMode && highlightedRow === null && (
              <div className="small table-view-header-status" role="status" aria-live="polite" aria-atomic="true">
                {loading || awaitingCatalog
                  ? "Loading table page..."
                  : data && data.rows.length > 0
                    ? normalizedSearch
                      ? `${filtered.rows.length.toLocaleString()} match${filtered.rows.length === 1 ? "" : "es"} (search) • ${effectiveRowCount.toLocaleString()} row${effectiveRowCount === 1 ? "" : "s"} loaded${pendingEditHint}`
                      : `${effectiveRowCount.toLocaleString()} row${effectiveRowCount === 1 ? "" : "s"} loaded${pendingEditHint}`
                    : `Showing 0 of ${effectiveRowCount.toLocaleString()} rows.`}
              </div>
            )}
            {effectiveDescription && (
              <div className="table-view-description-text" title={effectiveDescription}>
                {effectiveDescription}
              </div>
            )}
          </div>
          <div className="table-view-tools">
            {isPlainDatasetView && hasUnsavedChanges && (
              <div className="table-view-save-edits-wrap">
                <button
                  type="button"
                  className="table-view-format-button table-view-save-edits-btn"
                  disabled={isSavingEdits || loading || awaitingCatalog}
                  aria-busy={isSavingEdits}
                  onClick={() => {
                    void handleSaveEdits();
                  }}
                >
                  {isSavingEdits ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="table-view-format-button table-view-revert-edits-btn"
                  disabled={isSavingEdits || loading || awaitingCatalog}
                  onClick={handleRevertEdits}
                >
                  Discard Changes
                </button>
              </div>
            )}
            <div className="table-view-search-wrap">
              <svg className="table-view-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="currentColor" />
              </svg>
              <input
                type="text"
                className="table-view-search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search"
                aria-label="Search rows"
              />
            </div>
          </div>
        </div>
      </div>

      {data && (
        <div
          className={
            isMultiHighlightMode && multiHighlightRows.length > 0
              ? "table-area-outer has-highlight-nav"
              : "table-area-outer"
          }
        >
          {isMultiHighlightMode && multiHighlightRows.length > 0 && (
            <div className="table-view-highlight-nav-sidebar table-view-highlight-nav-sidebar-absolute" aria-label="Highlight navigation">
              <button
                type="button"
                className="table-view-highlight-nav-btn table-view-highlight-nav-btn-up"
                onClick={() => moveMultiHighlightCursor(-1)}
                disabled={activeHighlightCursor <= 0}
                aria-label="Previous highlighted row"
                title="Previous highlighted row"
              >
                ▲
              </button>
              <button
                type="button"
                className="table-view-highlight-nav-btn table-view-highlight-nav-btn-down"
                onClick={() => moveMultiHighlightCursor(1)}
                disabled={activeHighlightCursor >= multiHighlightRows.length - 1}
                aria-label="Next highlighted row"
                title="Next highlighted row"
              >
                ▼
              </button>
            </div>
          )}
          <div className="table-area-outer">
            <div className="table-area full-table-area" ref={tableAreaRef}>
            <DataTable
              columns={data.columns}
              columnLabels={
                data.columns_meta
                  ? data.columns_meta.map((m) => {
                      const base =
                        valueMode === "original"
                          ? (m.original_name ?? m.normalized_name)
                          : m.normalized_name;
                      return pendingColumnEdits.get(m.normalized_name)?.value ?? base;
                    })
                  : undefined
              }
              rows={displayRows}
              sortRows={sortRows}
              rowIndices={filtered.rowIndices}
              onRowClick={({ rowIndex, isHighlighted }) => {
                if (!isMultiHighlightMode || !isHighlighted) {
                  return;
                }
                const nextCursor = multiHighlightRows.indexOf(rowIndex);
                if (nextCursor !== -1) {
                  pageChangeSourceRef.current = "highlight";
                  setActiveHighlightCursor(nextCursor);
                }
              }}
              highlight={
                highlightedRows.length > 0
                  ? {
                      rows: highlightedRows,
                      cols: data.columns,
                      ...(semanticRowOpacityByIndex ? { rowOpacityByIndex: semanticRowOpacityByIndex } : {}),
                      ...(isMultiHighlightMode && multiHighlightRows.length > 1 && effectiveHighlightRow !== null
                        ? { primaryRow: effectiveHighlightRow }
                        : {}),
                    }
                  : undefined
              }
              sortable
              sortMode="server"
              serverSortColumn={sortColumn}
              serverSortDirection={sortDirection}
              onSortChange={(column, direction) => {
                setSortColumn(column);
                setSortDirection(direction);
                setCurrentPage(1);
                setPageInput("1");
              }}
              caption={
                isPlainDatasetView
                  ? `${tableName || "Table"}. ${displayRows.length.toLocaleString()} row${displayRows.length === 1 ? "" : "s"} shown.`
                  : `${tableName || "Table"} page ${safeCurrentPage}. ${displayRows.length} row${displayRows.length === 1 ? "" : "s"} shown.`
              }
              onCellContextMenu={(event, payload) => {
                if (!dateColumns.has(payload.column) || !parseDateToDate(payload.value)) {
                  return;
                }
                event.preventDefault();
                setDateMenu({ x: event.clientX, y: event.clientY });
              }}
              editable={isPlainDatasetView}
              editableBusy={isSavingEdits || loading}
              editableEpoch={sliceEpoch}
              onCellDraftChange={handleCellDraftChange}
              editableHeaders={isPlainDatasetView}
              onHeaderDraftChange={handleHeaderDraftChange}
              pendingCellEditKeys={isPlainDatasetView ? pendingCellEditKeys : undefined}
              pendingCellEditValues={isPlainDatasetView ? pendingCellEditValues : undefined}
              pendingHeaderColumns={isPlainDatasetView ? pendingHeaderColumnsSet : undefined}
            />
            {showScrollHint && (
              <button
                type="button"
                className="scroll-indicator full-table-scroll-indicator"
                onClick={scrollTableToEdge}
                aria-label={tableAtBottom ? "Scroll table to top" : "Scroll table to bottom"}
                title={tableAtBottom ? "Scroll to top" : "Scroll to bottom"}
              >
                {tableAtBottom ? "▲" : "▼"}
              </button>
            )}
            </div>
          </div>
        </div>
      )}
      {data && effectiveRowCount > 0 && isMultiHighlightMode && (
        <div className="table-view-pagination" aria-label="Full table pagination">
          <div className="table-view-pagination-controls">
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => {
                pageChangeSourceRef.current = "table";
                setCurrentPage(1);
              }}
              disabled={loading || safeCurrentPage <= 1}
              aria-label="First page"
              title="First page"
            >
              {"<<"}
            </button>
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => {
                pageChangeSourceRef.current = "table";
                setCurrentPage(Math.max(1, safeCurrentPage - 1));
              }}
              disabled={loading || safeCurrentPage <= 1}
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
                disabled={loading}
                aria-label="Current page number"
                title="Enter page number"
              />{" "}
              of {totalPages}
            </span>
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => {
                pageChangeSourceRef.current = "table";
                setCurrentPage(Math.min(totalPages, safeCurrentPage + 1));
              }}
              disabled={loading || safeCurrentPage >= totalPages}
              aria-label="Next page"
              title="Next page"
            >
              {">"}
            </button>
            <button
              type="button"
              className="table-view-page-btn"
              onClick={() => {
                pageChangeSourceRef.current = "table";
                setCurrentPage(totalPages);
              }}
              disabled={loading || safeCurrentPage >= totalPages}
              aria-label="Last page"
              title="Last page"
            >
              {">>"}
            </button>
          </div>
        </div>
      )}
      {dateMenu && (
        <div
          ref={dateMenuRef}
          id={dateMenuId}
          className="date-context-menu"
          style={{ left: dateMenu.x, top: dateMenu.y }}
          role="menu"
          aria-label="Date format options"
          onKeyDown={onDateMenuKeyDown}
        >
          {DATE_VIEW_OPTIONS.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => {
                dateMenuItemRefs.current[index] = element;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={dateViewMode === option.value}
              className={dateViewMode === option.value ? "active" : undefined}
              onClick={() => selectDateViewMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {isSavingEdits && (
        <div className="table-view-saving-overlay" role="status" aria-live="polite" aria-atomic="true">
          <div className="table-view-saving-modal" aria-label="Saving changes">
            <div className="table-view-saving-spinner" aria-hidden="true" />
            <div className="table-view-saving-title">Saving changes</div>
            <div className="table-view-saving-subtitle">
              {saveSlowHint ? "This may take a while..." : "Updating table values and columns..."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

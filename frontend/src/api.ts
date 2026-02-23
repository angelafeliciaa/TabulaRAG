const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export type ServerStatus = "online" | "offline" | "unknown";

export type TableRow = Record<string, unknown>;

export interface TableSummary {
  dataset_id: number;
  name: string;
  source_filename: string | null;
  row_count: number;
  column_count: number;
  created_at: string;
}

export interface TableSlice {
  dataset_id: number;
  offset: number;
  limit: number;
  row_count: number;
  column_count: number;
  has_header: boolean;
  columns: string[];
  rows: TableRow[];
}

interface TableSliceApiRow {
  row_index: number;
  data: TableRow;
}

interface TableSliceApiResponse {
  dataset_id: number;
  offset: number;
  limit: number;
  row_count: number;
  column_count: number;
  has_header: boolean;
  columns: string[];
  rows: TableSliceApiRow[];
}

export interface HighlightResponse {
  highlight_id: string;
  dataset_id: number;
  row_index: number;
  column: string;
  value: unknown;
  row_context: TableRow;
}

interface IngestResponse {
  dataset_id: number;
  name: string;
  rows: number;
  columns: number;
  delimiter: string;
  has_header: boolean;
}

export async function uploadTable(file: File, name: string): Promise<IngestResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("has_header", "true");

  const trimmed = name.trim();
  if (trimmed) {
    form.append("dataset_name", trimmed);
  }

  const res = await fetch(`${API_BASE}/ingest`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as IngestResponse;
}

export async function listTables(): Promise<TableSummary[]> {
  const res = await fetch(`${API_BASE}/tables`);
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as TableSummary[];
}

export async function getSlice(
  datasetId: number,
  rowFrom: number,
  rowTo: number,
): Promise<TableSlice> {
  const offset = Math.max(0, rowFrom);
  const limit = Math.max(1, rowTo - rowFrom);
  const url = new URL(`${API_BASE}/tables/${datasetId}/slice`);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(await res.text());
  }

  const data = (await res.json()) as TableSliceApiResponse;
  return {
    dataset_id: data.dataset_id,
    offset: data.offset,
    limit: data.limit,
    row_count: data.row_count,
    column_count: data.column_count,
    has_header: data.has_header,
    columns: data.columns,
    rows: (data.rows || []).map((row) => row.data ?? {}),
  };
}

export async function getHighlight(highlightId: string): Promise<HighlightResponse> {
  const res = await fetch(`${API_BASE}/highlights/${highlightId}`);
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as HighlightResponse;
}

export async function deleteTable(datasetId: number): Promise<{ deleted: number }> {
  const res = await fetch(`${API_BASE}/tables/${datasetId}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as { deleted: number };
}

export async function renameTable(datasetId: number, name: string): Promise<{ name: string }> {
  const res = await fetch(`${API_BASE}/tables/${datasetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as { name: string };
}

export async function getMcpStatus(): Promise<{ status: ServerStatus }> {
  try {
    const res = await fetch(`${API_BASE}/mcp-status`);
    if (!res.ok) {
      return { status: "offline" };
    }

    const data = (await res.json()) as { status?: string };
    if (data.status === "ok") {
      return { status: "online" };
    }
    return { status: "unknown" };
  } catch {
    return { status: "offline" };
  }
}

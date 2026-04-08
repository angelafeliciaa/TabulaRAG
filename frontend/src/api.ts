export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

const TOKEN_KEY = "tabularag_token";
const USER_KEY = "tabularag_user";

export interface AuthUser {
  login: string;
  name: string;
  avatar_url: string;
  role: "owner" | "admin" | "querier" | null;
  enterprise_id: number | null;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as AuthUser & { role?: string | null };
    if (String(u.role) === "member") {
      u.role = "querier";
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    }
    return u as AuthUser;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Merge into stored user (e.g. clear workspace after disbanding the last one). */
export function patchStoredUser(partial: Partial<AuthUser>): void {
  const u = getUser();
  if (u) {
    localStorage.setItem(USER_KEY, JSON.stringify({ ...u, ...partial }));
  }
}

async function authFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(
    typeof input === "string" ? input : input.toString(),
    init,
  );
  if (res.status === 401) {
    logout();
    window.location.replace("/");
  }
  return res;
}

export async function getGoogleClientId(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/google`);
  if (!res.ok) throw new Error("Google OAuth not configured");
  const data = (await res.json()) as { client_id: string };
  return data.client_id;
}

/** Full browser redirect to Google OAuth (used by Login and “Switch account”). */
export async function redirectToGoogleSignIn(options?: {
  prompt?: "select_account" | "consent" | "none";
}): Promise<void> {
  const clientId = await getGoogleClientId();
  const redirectUri = `${window.location.origin}/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
  });
  if (options?.prompt) {
    params.set("prompt", options.prompt);
  }
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export type AuthSessionResponse = {
  token: string;
  user: AuthUser;
  onboarding_required: boolean;
};

async function readApiErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { detail?: unknown };
    const d = data.detail;
    if (typeof d === "string") {
      return d;
    }
    if (Array.isArray(d)) {
      return d
        .map((x: { msg?: string }) => (typeof x?.msg === "string" ? x.msg : JSON.stringify(x)))
        .join("; ");
    }
  } catch {
    /* ignore */
  }
  return text || "Request failed";
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<AuthSessionResponse> {
  const res = await fetch(`${API_BASE}/auth/google/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  if (!res.ok) {
    throw new Error((await readApiErrorMessage(res)) || "Google authentication failed");
  }
  const data = (await res.json()) as AuthSessionResponse;
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

export async function registerWithEmail(body: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthSessionResponse> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res));
  }
  const data = (await res.json()) as AuthSessionResponse;
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

export async function loginWithEmail(
  email: string,
  password: string,
): Promise<AuthSessionResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res));
  }
  const data = (await res.json()) as AuthSessionResponse;
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

function decodeJwtPayloadJson(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const mid = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (mid.length % 4)) % 4;
    const padded = mid + "=".repeat(pad);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeWorkspaceRole(role: string | null | undefined): AuthUser["role"] | null {
  if (role === "owner" || role === "admin" || role === "querier") return role;
  return null;
}

export function applyEnterpriseSession(
  token: string,
  enterpriseId: number | null,
  role: string | null,
): void {
  localStorage.setItem(TOKEN_KEY, token);
  const prev = getUser();
  const nextRole = normalizeWorkspaceRole(role);
  if (prev) {
    localStorage.setItem(
      USER_KEY,
      JSON.stringify({
        ...prev,
        enterprise_id: enterpriseId,
        role: nextRole,
      }),
    );
    return;
  }
  const claims = decodeJwtPayloadJson(token);
  if (claims) {
    const resolvedEid =
      enterpriseId !== null
        ? enterpriseId
        : claims.enterprise_id != null && claims.enterprise_id !== undefined
          ? Number(claims.enterprise_id)
          : null;
    const claimRole = normalizeWorkspaceRole(
      typeof claims.role === "string" ? claims.role : null,
    );
    localStorage.setItem(
      USER_KEY,
      JSON.stringify({
        login: String(claims.login ?? ""),
        name: String(claims.name ?? claims.login ?? ""),
        avatar_url: String(claims.avatar_url ?? ""),
        enterprise_id: resolvedEid,
        role: nextRole ?? claimRole,
      }),
    );
  }
}

export interface WorkspaceSummary {
  enterprise_id: number;
  enterprise_name: string;
  role: "owner" | "admin" | "querier";
  is_active: boolean;
  member_count: number;
}

export async function listMyWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await authFetch(`${API_BASE}/enterprises/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function switchWorkspace(
  enterpriseId: number,
): Promise<{ enterprise_id: number; enterprise_name: string; role: string }> {
  const res = await authFetch(`${API_BASE}/enterprises/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enterprise_id: enterpriseId }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as {
    token: string;
    enterprise_id: number;
    enterprise_name: string;
    role: string;
  };
  applyEnterpriseSession(data.token, data.enterprise_id, data.role);
  return data;
}

export async function leaveWorkspace(): Promise<{
  token: string;
  enterprise_id: number | null;
  enterprise_name: string;
  role: string | null;
}> {
  const res = await authFetch(`${API_BASE}/enterprises/leave`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as {
    token: string;
    enterprise_id: number | null;
    enterprise_name: string;
    role: string | null;
  };
  applyEnterpriseSession(data.token, data.enterprise_id, data.role);
  return data;
}

export async function createEnterprise(
  name: string,
): Promise<{ enterprise_id: number; enterprise_name: string; role: string }> {
  const res = await authFetch(`${API_BASE}/enterprises`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as {
    enterprise_id: number;
    enterprise_name: string;
    role: string;
    token?: string;
  };
  if (data.token) {
    applyEnterpriseSession(data.token, data.enterprise_id, data.role);
  }
  return data;
}

export async function renameWorkspace(name: string): Promise<{ enterprise_id: number; enterprise_name: string }> {
  const res = await authFetch(`${API_BASE}/enterprises/name`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fastApiErrorMessage(bodyText: string): string | null {
  const t = bodyText.trim();
  if (!t.startsWith("{")) return null;
  try {
    const j = JSON.parse(t) as { detail?: unknown };
    const d = j.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length > 0) {
      const first = d[0] as { msg?: string };
      if (typeof first?.msg === "string") return first.msg;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function joinEnterprise(
  code: string,
): Promise<{ enterprise_id: number; enterprise_name: string; role: string }> {
  const res = await authFetch(`${API_BASE}/enterprises/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404) throw new Error("Invalid invite code");
    if (res.status === 409) {
      throw new Error("You're already a member of this workspace.");
    }
    throw new Error((fastApiErrorMessage(text) ?? text) || "Failed to join workspace");
  }
  const data = (await res.json()) as {
    enterprise_id: number;
    enterprise_name: string;
    role: string;
    token?: string;
  };
  if (data.token) {
    applyEnterpriseSession(data.token, data.enterprise_id, data.role);
  }
  return data;
}

/** True for owner or admin (can upload and edit tables); queriers are read-only in the UI. */
export function isAdmin(): boolean {
  const r = getUser()?.role;
  return r === "admin" || r === "owner";
}

export function isOwner(): boolean {
  return getUser()?.role === "owner";
}

export interface McpTokenStatus {
  configured: boolean;
  created_at: string | null;
  hint?: string;
}

export async function getMcpTokenStatus(): Promise<McpTokenStatus> {
  const res = await authFetch(`${API_BASE}/enterprises/mcp-token`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createOrRotateMcpToken(): Promise<{ token: string; created_at: string }> {
  const res = await authFetch(`${API_BASE}/enterprises/mcp-token`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function revokeMcpToken(): Promise<void> {
  const res = await authFetch(`${API_BASE}/enterprises/mcp-token`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function adminRevokeMemberMcpToken(userId: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/enterprises/mcp-token/members/${userId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export interface Member {
  id: number;
  login: string;
  role: "owner" | "admin" | "querier";
  joined_at: string;
  mcp_token_configured?: boolean;
}

export interface InviteCode {
  code: string;
  expires_at: string | null;
  expired: boolean;
  created_at: string;
}

export async function listMembers(): Promise<Member[]> {
  const res = await authFetch(`${API_BASE}/enterprises/members`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateMemberRole(userId: number, role: "admin" | "querier"): Promise<Member> {
  const res = await authFetch(`${API_BASE}/enterprises/members/${userId}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function removeMember(userId: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/enterprises/members/${userId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function transferEnterpriseOwnership(
  userId: number,
): Promise<{ token: string; role: string }> {
  const res = await authFetch(`${API_BASE}/enterprises/transfer-ownership`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function disbandEnterprise(): Promise<{
  disbanded: boolean;
  enterprise_id: number;
}> {
  const res = await authFetch(`${API_BASE}/enterprises`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error((fastApiErrorMessage(text) ?? text) || "Failed to disband workspace");
  }
  return res.json();
}

export async function listInviteCodes(): Promise<InviteCode[]> {
  const res = await authFetch(`${API_BASE}/enterprises/invite-codes`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createInviteCode(): Promise<InviteCode> {
  const res = await authFetch(`${API_BASE}/enterprises/invite-codes`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function revokeInviteCode(code: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/enterprises/invite-codes/${code}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export type ServerStatus = "Online" | "Offline" | "Unknown";
export type IndexJobState = "queued" | "indexing" | "ready" | "error";
export type FolderPrivacy = "public" | "protected" | "private";

export interface Folder {
  folder_id: number;
  name: string;
  privacy: FolderPrivacy;
  dataset_count: number;
  created_at: string;
}

export type TableRow = Record<string, unknown>;

export interface TableSummary {
  dataset_id: number;
  name: string;
  description: string | null;
  source_filename: string | null;
  row_count: number;
  column_count: number;
  created_at: string;
  folder_id: number | null;
  folder_name: string | null;
  folder_privacy: FolderPrivacy | null;
}

export interface ColumnMeta {
  original_name: string | null;
  normalized_name: string;
}

export interface TableSlice {
  dataset_id: number;
  offset: number;
  limit: number;
  row_count: number;
  column_count: number;
  has_header: boolean;
  columns: string[];
  columns_meta?: ColumnMeta[];
  rows: TableRow[];
  /** When server-side sort is used, row indices for each row (for correct # column). */
  row_indices?: number[];
}

export interface TableIndexStatus {
  dataset_id: number;
  state: IndexJobState;
  progress: number;
  processed_rows: number;
  total_rows: number;
  message: string;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
}

interface TableSliceApiRow {
  row_index: number;
  data?: unknown;
  row_data?: unknown;
}

interface TableSliceApiResponse {
  dataset_id: number;
  offset: number;
  limit: number;
  row_count: number;
  column_count: number;
  has_header: boolean;
  columns: string[];
  columns_meta?: ColumnMeta[];
  rows: TableSliceApiRow[];
}

function normalizeRowData(raw: unknown): TableRow {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as TableRow;
  }

  if (typeof raw === "string") {
    try {
      let parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as TableRow;
      }
    } catch {
      return {};
    }
  }

  return {};
}

/** Flatten row cells that are { original, normalized } to a single value (normalized). */
function flattenRowToNormalized(row: TableRow): TableRow {
  const out: TableRow = {};
  for (const [col, val] of Object.entries(row)) {
    if (
      val != null
      && typeof val === "object"
      && !Array.isArray(val)
      && "normalized" in val
      && "original" in val
    ) {
      out[col] = (val as { normalized?: unknown }).normalized;
    } else {
      out[col] = val;
    }
  }
  return out;
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
  description: string | null;
  rows: number;
  columns: number;
  delimiter: string;
  has_header: boolean;
}

export interface UploadProgress {
  percent: number;
  phase: "uploading" | "processing";
}

export async function uploadTable(
  file: File,
  name: string,
  description?: string | null,
  onProgress?: (progress: UploadProgress) => void,
  folderId?: number | null,
): Promise<IngestResponse> {
  const form = new FormData();
  form.append("file", file);

  const trimmed = name.trim();
  if (trimmed) {
    form.append("dataset_name", trimmed);
  }

  const trimmedDescription = (description || "").trim();
  if (trimmedDescription) {
    form.append("dataset_description", trimmedDescription);
  }

  if (folderId != null) {
    form.append("folder_id", String(folderId));
  }

  return await new Promise<IngestResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let processingTimer: number | null = null;

    const report = (percent: number, phase: UploadProgress["phase"]) => {
      if (!onProgress) {
        return;
      }
      onProgress({ percent: Math.max(0, Math.min(100, percent)), phase });
    };

    const stopProcessingTimer = () => {
      if (processingTimer !== null) {
        window.clearInterval(processingTimer);
        processingTimer = null;
      }
    };

    xhr.open("POST", `${API_BASE}/ingest`);

    const token = getToken();
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }

    xhr.upload.onloadstart = () => {
      report(2, "uploading");
    };

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }
      // Reserve final percentage points for server-side parse/store/indexing.
      const uploadPercent = (event.loaded / event.total) * 82;
      report(uploadPercent, "uploading");
    };

    xhr.upload.onload = () => {
      let processingPercent = 82;
      const processingStart = Date.now();
      report(processingPercent, "processing");
      processingTimer = window.setInterval(() => {
        const elapsedMs = Date.now() - processingStart;
        // Keep progress moving while backend parses/stores/indexes rows.
        const easedTarget = 82 + 17.2 * (1 - Math.exp(-elapsedMs / 9000));
        processingPercent = Math.min(
          99.7,
          Math.max(processingPercent + 0.12, easedTarget),
        );
        report(processingPercent, "processing");
      }, 220);
    };

    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.DONE) {
        return;
      }

      stopProcessingTimer();

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText) as IngestResponse;
          report(100, "processing");
          resolve(response);
        } catch {
          reject(new Error("Invalid upload response format."));
        }
        return;
      }

      if (xhr.status === 0) {
        reject(
          new Error(
            "The upload connection was interrupted before the server responded. Please try again.",
          ),
        );
        return;
      }

      if (xhr.status === 401) {
        logout();
        window.location.replace("/");
        return;
      }

      const detail = xhr.responseText?.trim();
      reject(new Error(detail || `Upload failed with status ${xhr.status}.`));
    };

    xhr.onerror = () => {
      stopProcessingTimer();
      reject(
        new Error(
          "The upload connection was interrupted before the server responded. Please try again.",
        ),
      );
    };

    xhr.onabort = () => {
      stopProcessingTimer();
      reject(new Error("Upload was aborted."));
    };

    xhr.send(form);
  });
}

export async function listTables(options?: {
  includePending?: boolean;
}): Promise<TableSummary[]> {
  const url = new URL(`${API_BASE}/tables`);
  if (options?.includePending) {
    url.searchParams.set("include_pending", "true");
  }

  const res = await authFetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as TableSummary[];
}

export async function listIndexStatus(
  datasetIds?: number[],
): Promise<TableIndexStatus[]> {
  const url = new URL(`${API_BASE}/tables/index-status`);
  (datasetIds || []).forEach((datasetId) => {
    url.searchParams.append("dataset_id", String(datasetId));
  });

  const res = await authFetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as TableIndexStatus[];
}

export type SliceOptions = {
  /** If true (default), flatten each row to normalized values only. If false, return raw { original, normalized } per cell for toggle support. */
  flatten?: boolean;
  /** When set, only rows where any cell contains this string (case-insensitive) are returned. Pagination applies to the filtered set. */
  search?: string;
};

export type SliceSort = {
  sortColumn: string;
  sortDirection: "asc" | "desc";
};

export async function getSlice(
  datasetId: number,
  rowFrom: number,
  rowTo: number,
  options?: SliceOptions & { sort?: SliceSort | null },
): Promise<TableSlice> {
  const offset = Math.max(0, rowFrom);
  const limit = Math.max(1, rowTo - rowFrom);
  const url = new URL(`${API_BASE}/tables/${datasetId}/slice`);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  if (options?.sort?.sortColumn) {
    url.searchParams.set("sort_column", options.sort.sortColumn);
    url.searchParams.set("sort_direction", options.sort.sortDirection);
  }
  const searchTrimmed = options?.search?.trim();
  if (searchTrimmed) {
    url.searchParams.set("search", searchTrimmed);
  }

  const res = await authFetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text ? `${text} (${res.status})` : `Request failed (${res.status})`);
  }

  const data = (await res.json()) as TableSliceApiResponse;
  const rawRows = (data.rows || []).map((row) =>
    normalizeRowData(row.data ?? row.row_data),
  );
  const flattenToNormalized = options?.flatten !== false;
  const rows = flattenToNormalized
    ? rawRows.map(flattenRowToNormalized)
    : rawRows;
  const row_indices = (data.rows || []).map((r) => r.row_index);

  return {
    dataset_id: data.dataset_id,
    offset: data.offset,
    limit: data.limit,
    row_count: data.row_count,
    column_count: data.column_count,
    has_header: data.has_header,
    columns: data.columns,
    columns_meta: data.columns_meta,
    rows,
    row_indices,
  };
}

export async function getHighlight(
  highlightId: string,
): Promise<HighlightResponse> {
  const res = await authFetch(`${API_BASE}/highlights/${highlightId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as HighlightResponse;
}

export async function deleteTable(
  datasetId: number,
  options?: { keepalive?: boolean },
): Promise<{ deleted: number }> {
  const res = await authFetch(`${API_BASE}/tables/${datasetId}`, {
    method: "DELETE",
    keepalive: options?.keepalive,
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as { deleted: number };
}

export async function patchTableCell(
  datasetId: number,
  rowIndex: number,
  column: string,
  value: string,
): Promise<{ dataset_id: number; row_index: number; column: string; data: TableRow }> {
  const res = await authFetch(
    `${API_BASE}/tables/${datasetId}/rows/${rowIndex}`,
    {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ column, value }),
    },
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as {
    dataset_id: number;
    row_index: number;
    column: string;
    data: TableRow;
  };
}

export async function patchTableColumnName(
  datasetId: number,
  column: string,
  name: string,
): Promise<{ dataset_id: number; column: string; original_name: string | null }> {
  const res = await authFetch(
    `${API_BASE}/tables/${datasetId}/columns`,
    {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ column, name }),
    },
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as {
    dataset_id: number;
    column: string;
    original_name: string | null;
  };
}

export async function patchTableDescription(
  datasetId: number,
  description: string | null,
): Promise<{ dataset_id: number; description: string | null }> {
  const res = await authFetch(
    `${API_BASE}/tables/${datasetId}/description`,
    {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    },
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as { dataset_id: number; description: string | null };
}

export async function getTableColumns(
  datasetId: number,
): Promise<{ dataset_id: number; columns: Array<{ column_index: number; original_name: string | null; normalized_name: string }> }> {
  const res = await authFetch(`${API_BASE}/tables/${datasetId}/columns`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as {
    dataset_id: number;
    columns: Array<{ column_index: number; original_name: string | null; normalized_name: string }>;
  };
}

export async function renameTable(
  datasetId: number,
  name: string,
): Promise<{ name: string }> {
  const res = await authFetch(`${API_BASE}/tables/${datasetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as { name: string };
}

export async function listFolders(): Promise<Folder[]> {
  const res = await authFetch(`${API_BASE}/folders`, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error((fastApiErrorMessage(text) ?? text) || "Failed to load folders");
  }
  return (await res.json()) as Folder[];
}

export async function createFolder(
  name: string,
  privacy: FolderPrivacy,
): Promise<Folder> {
  const res = await authFetch(`${API_BASE}/folders`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, privacy }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error((fastApiErrorMessage(text) ?? text) || "Failed to create folder");
  }
  return (await res.json()) as Folder;
}

export async function updateFolder(
  folderId: number,
  patch: { name?: string; privacy?: FolderPrivacy },
): Promise<Folder> {
  const res = await authFetch(`${API_BASE}/folders/${folderId}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error((fastApiErrorMessage(text) ?? text) || "Failed to update folder");
  }
  return (await res.json()) as Folder;
}

export async function deleteFolder(folderId: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/folders/${folderId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error((fastApiErrorMessage(text) ?? text) || "Failed to delete folder");
  }
}

export async function reorderFolders(folderIds: number[]): Promise<void> {
  const res = await authFetch(`${API_BASE}/folders/reorder`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ folder_ids: folderIds }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
}

export interface FolderDatasets {
  folder_id: number;
  name: string;
  privacy: FolderPrivacy;
  datasets: Pick<TableSummary, "dataset_id" | "name" | "description" | "row_count" | "column_count" | "created_at">[];
}

export async function listFolderDatasets(folderId: number): Promise<FolderDatasets> {
  const res = await authFetch(`${API_BASE}/folders/${folderId}/datasets`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as FolderDatasets;
}

export interface FolderGroupGrant {
  access_id: number;
  group_id: number;
  group_name: string;
  granted_at: string;
}

export async function listFolderGroups(folderId: number): Promise<FolderGroupGrant[]> {
  const res = await authFetch(`${API_BASE}/folders/${folderId}/groups`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as FolderGroupGrant[];
}

export async function assignDatasetToFolder(
  datasetId: number,
  folderId: number | null,
): Promise<{ dataset_id: number; folder_id: number | null }> {
  const res = await authFetch(`${API_BASE}/folders/datasets/${datasetId}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ folder_id: folderId }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as { dataset_id: number; folder_id: number | null };
}

export async function getServerStatus(): Promise<{ status: ServerStatus }> {
  try {
    const res = await fetch(`${API_BASE}/health/deps`);
    if (!res.ok) {
      return { status: "Offline" };
    }

    const data = (await res.json()) as { status?: string };
    if (data.status === "ok") {
      return { status: "Online" };
    }
    return { status: "Unknown" };
  } catch {
    return { status: "Offline" };
  }
}

export type AggregateResponse = {
  dataset_id: number;
  metric_column: string | null;
  group_by_column: string | null;
  rowsResult: { group_value: string | null; aggregate_value: number }[];
  sql_query: string;
  url: string | null;
  metric_currency?: string | null;
  metric_unit?: string | null;
};

export async function aggregate(params: unknown): Promise<AggregateResponse> {
  const res = await authFetch(`${API_BASE}/aggregate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type FilterResponse = {
  dataset_id: number;
  rowsResult: { row_index: number; row_data: Record<string, unknown>; highlight_id: string }[];
  row_count: number;
  sql_query: string;
  url: string | null;
};

export async function filterRows(params: unknown): Promise<FilterResponse> {
  const res = await authFetch(`${API_BASE}/filter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** Same row shape as filter virtual table; used for semantic search result replay. */
export async function fetchRowsByIndices(
  datasetId: number,
  rowIndices: number[],
  columns?: string[] | null,
): Promise<FilterResponse> {
  const res = await authFetch(
    `${API_BASE}/tables/${datasetId}/rows_by_indices`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        row_indices: rowIndices,
        columns: columns ?? null,
      }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type FilterRowIndicesResponse = {
  dataset_id: number;
  row_indices: number[];
  total_match_count: number;
  truncated: boolean;
  sql_query: string;
};

export async function filterRowIndices(params: unknown): Promise<FilterRowIndicesResponse> {
  const res = await authFetch(`${API_BASE}/filter/row-indices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ---------------------------------------------------------------------------
// User Groups
// ---------------------------------------------------------------------------

export interface UserGroup {
  group_id: number;
  name: string;
  member_count: number;
  folder_access_count: number;
  created_at: string;
}

export interface GroupMember {
  membership_id: number;
  user_id: number;
  login: string;
  added_at: string;
}

export interface GroupFolderAccess {
  access_id: number;
  folder_id: number;
  folder_name: string;
  privacy: FolderPrivacy;
  granted_at: string;
}

export async function listGroups(): Promise<UserGroup[]> {
  const res = await authFetch(`${API_BASE}/groups`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as UserGroup[];
}

export async function createGroup(name: string): Promise<UserGroup> {
  const res = await authFetch(`${API_BASE}/groups`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as UserGroup;
}

export async function updateGroup(groupId: number, name: string): Promise<{ group_id: number; name: string }> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { group_id: number; name: string };
}

export async function deleteGroup(groupId: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function listGroupMembers(groupId: number): Promise<GroupMember[]> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}/members`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as GroupMember[];
}

export async function addGroupMember(groupId: number, userId: number): Promise<GroupMember> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}/members`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as GroupMember;
}

export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}/members/${userId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function listGroupFolderAccesses(groupId: number): Promise<GroupFolderAccess[]> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}/folders`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as GroupFolderAccess[];
}

export async function grantGroupFolderAccess(groupId: number, folderId: number): Promise<GroupFolderAccess> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}/folders`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ folder_id: folderId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as GroupFolderAccess;
}

export async function revokeGroupFolderAccess(groupId: number, folderId: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/groups/${groupId}/folders/${folderId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

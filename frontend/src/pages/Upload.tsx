import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { focusByIndex, focusByOffset, trapFocus } from "../accessibility";
import {
  assignDatasetToFolder,
  deleteTable,
  getSlice,
  isAdmin,
  listFolders,
  listIndexStatus,
  listTables,
  patchTableDescription,
  renameTable,
  uploadTable,
  type Folder,
  type TableIndexStatus,
  type TableSlice,
  type TableSummary,
  type UploadProgress,
} from "../api";
import DataTable from "../components/DataTable";
import FolderSidePanel from "../components/FolderSidePanel";
import { useAppUi } from "../appUiContext";
import { flattenRowsByValueMode } from "../valueMode";
import { TableStatusCard } from "../components/TableStatusPage";
import logo64 from "../images/logo-64.webp";
import logo128 from "../images/logo-128.webp";
import openIcon from "../images/open.png";
import uploadLogo from "../images/upload.png";

const PENDING_UPLOAD_SESSION_KEY = "tabularag_pending_upload";
const PINNED_TABLES_STORAGE_KEY = "tabularag_pinned_table_ids";
const SELECTED_PREVIEW_TABLE_KEY = "tabularag_selected_preview_table_id";
const FOLDER_PANE_WIDTH_STORAGE_KEY = "tabularag_folder_pane_width";
const SUCCESS_TOAST_MS = 2800;
const INDEX_PROGRESS_DRIFT_STEP = 0.35;
const INDEX_PROGRESS_DRIFT_CAP = 99.4;
const SAFE_TABLE_NAME_MAX_LENGTH = 64;
const SAFE_TABLE_DESCRIPTION_MAX_LENGTH = 100;
const TABLES_RENDER_BATCH_SIZE = 120;
const PREVIEW_ROWS_PER_PAGE = 100;

type ToastState = { id: number; kind: "success"; message: string };
type UploadQueuePhase = "idle" | UploadProgress["phase"] | "success" | "error";
type TableSortMode = "alphabet" | "rows" | "recent";
type UploadPickerTarget = "empty" | "queue";
type UploadQueueItem = {
  id: string;
  file: File;
  name: string;
  progress: number;
  phase: UploadQueuePhase;
  estimatedRows: number | null;
  estimatedCols: number | null;
  error: string | null;
  description: string;
  folderId: number | null;
};

type UploadProps = {
  homeControls?: React.ReactNode;
};

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
};

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
};

type FileSystemDirectoryReaderLike = {
  readEntries: (
    successCallback: (entries: FileSystemEntryLike[]) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
};

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => FileSystemDirectoryReaderLike;
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

type FolderInputProps = InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory?: string;
  directory?: string;
};

const FOLDER_INPUT_PROPS: FolderInputProps = {
  webkitdirectory: "",
  directory: "",
};

const TABLE_SORT_OPTIONS: Array<{ value: TableSortMode; label: string }> = [
  { value: "recent", label: "Most recent" },
  { value: "rows", label: "Most rows" },
  { value: "alphabet", label: "Alphabetical" },
];

function compareTablesBySortMode(
  a: TableSummary,
  b: TableSummary,
  sortMode: TableSortMode,
): number {
  if (sortMode === "alphabet") {
    const byName = a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (byName !== 0) {
      return byName;
    }
  } else if (sortMode === "rows") {
    const byRows = b.row_count - a.row_count;
    if (byRows !== 0) {
      return byRows;
    }
  }

  const aTime = Number.isFinite(Date.parse(a.created_at))
    ? Date.parse(a.created_at)
    : a.dataset_id;
  const bTime = Number.isFinite(Date.parse(b.created_at))
    ? Date.parse(b.created_at)
    : b.dataset_id;
  return bTime - aTime;
}

function sortTablesForDisplay(
  tables: TableSummary[],
  pinnedIds: Set<number>,
  sortMode: TableSortMode,
): TableSummary[] {
  const next = [...tables];
  next.sort((a, b) => {
    const aPinned = pinnedIds.has(a.dataset_id);
    const bPinned = pinnedIds.has(b.dataset_id);
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    return compareTablesBySortMode(a, b, sortMode);
  });
  return next;
}

function filterTablesForDisplay(
  tables: TableSummary[],
  normalizedQuery: string,
): TableSummary[] {
  if (!normalizedQuery) {
    return tables;
  }
  return tables.filter((table) =>
    table.name.toLowerCase().includes(normalizedQuery),
  );
}

function getErrorMessage(error: unknown): string {
  const normalize = (message: string): string => {
    const trimmed = message.trim();
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      return message;
    }
    try {
      const parsed = JSON.parse(trimmed) as { detail?: unknown };
      if (typeof parsed.detail === "string" && parsed.detail.trim()) {
        return parsed.detail;
      }
    } catch {
      // Keep original message when response is not valid JSON.
    }
    return message;
  };

  if (error instanceof Error) {
    return normalize(error.message);
  }
  return normalize(String(error));
}

function isTableNotFoundError(error: unknown): boolean {
  return /table not found/i.test(getErrorMessage(error));
}

function isOfflineConnectionError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("network error") ||
    normalized.includes("load failed") ||
    normalized.includes("network request failed") ||
    normalized.includes("err_network")
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatUploadFailureSummary(
  failureCount: number,
  firstFailureMessage: string | null,
): string {
  if (!firstFailureMessage) {
    return failureCount === 1
      ? "1 file failed to upload."
      : `${failureCount} files failed to upload.`;
  }
  return failureCount === 1
    ? `1 file failed to upload. ${firstFailureMessage}`
    : `${failureCount} files failed to upload. First error: ${firstFailureMessage}`;
}

function formatFileSize(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024) {
    return `${safeBytes}B`;
  }
  if (safeBytes < 1024 * 1024) {
    return `${Math.round(safeBytes / 1024)}KB`;
  }
  return `${(safeBytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getFileIdentity(file: File): string {
  const relativePath =
    (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
    file.name;
  return `${relativePath}:${file.size}:${file.lastModified}`;
}

function hasSupportedExtension(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".csv") || lowerName.endsWith(".tsv");
}

function isIgnorableMetadataFile(fileName: string): boolean {
  const normalizedName = fileName.trim().toLowerCase();
  return (
    normalizedName === ".ds_store" ||
    normalizedName === "thumbs.db" ||
    normalizedName === "desktop.ini" ||
    normalizedName.startsWith("._")
  );
}

function isLikelyDirectoryPlaceholder(file: File): boolean {
  if (hasSupportedExtension(file.name)) {
    return false;
  }
  const noExtension = !/\.[^./\\]+$/.test(file.name);
  return noExtension && file.size === 0 && file.type === "";
}

function fileFromEntry(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readAllDirectoryEntries(
  reader: FileSystemDirectoryReaderLike,
): Promise<FileSystemEntryLike[]> {
  return new Promise<FileSystemEntryLike[]>((resolve, reject) => {
    const allEntries: FileSystemEntryLike[] = [];
    const readBatch = () => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(allEntries);
          return;
        }
        allEntries.push(...entries);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function collectFilesFromEntry(
  entry: FileSystemEntryLike,
): Promise<File[]> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntryLike);
    return [file];
  }
  if (!entry.isDirectory) {
    return [];
  }
  const dirReader = (entry as FileSystemDirectoryEntryLike).createReader();
  const childEntries = await readAllDirectoryEntries(dirReader);
  const files = await Promise.all(
    childEntries.map((child) => collectFilesFromEntry(child)),
  );
  return files.flat();
}

async function collectDroppedFiles(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const itemFiles = await Promise.all(
    Array.from(dataTransfer.items || []).map(async (item) => {
      if (item.kind !== "file") {
        return [] as File[];
      }
      const itemWithEntry = item as DataTransferItemWithEntry;
      const entry = itemWithEntry.webkitGetAsEntry?.();
      if (entry) {
        return await collectFilesFromEntry(entry);
      }
      const fallbackFile = item.getAsFile();
      return fallbackFile ? [fallbackFile] : [];
    }),
  );
  const flattened = itemFiles.flat();
  if (flattened.length > 0) {
    return flattened.filter((file) => !isLikelyDirectoryPlaceholder(file));
  }
  return Array.from(dataTransfer.files || []).filter(
    (file) => !isLikelyDirectoryPlaceholder(file),
  );
}

function countDelimitedColumns(line: string, delimiter: string): number {
  if (!line.length) {
    return 0;
  }

  let inQuotes = false;
  let count = 1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      count += 1;
    }
  }
  return count;
}

function stripSupportedFileExtension(name: string): string {
  return name
    .trim()
    .replace(/\.(csv|tsv)$/i, "")
    .trim();
}

function sanitizeTableNameInput(name: string): string {
  const withoutExtension = stripSupportedFileExtension(name);
  /* eslint-disable no-control-regex */
  const withoutControlChars = withoutExtension.replace(
    /[\u0000-\u001f\u007f]/g,
    "",
  );
  /* eslint-enable no-control-regex */
  const allowedCharsOnly = withoutControlChars.replace(/[^A-Za-z0-9 _-]/g, "");
  const normalizedSpaces = allowedCharsOnly.replace(/\s+/g, " ").trim();
  return normalizedSpaces.slice(0, SAFE_TABLE_NAME_MAX_LENGTH);
}

function sanitizeTableDescriptionInput(description: string): string {
  // Keep printable chars and common whitespace (tab=9, newline=10, CR=13).
  const withoutControlChars = description
    .split("")
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("");
  return withoutControlChars.slice(0, SAFE_TABLE_DESCRIPTION_MAX_LENGTH);
}

function getNameKey(name: string): string {
  return sanitizeTableNameInput(name).toLocaleLowerCase();
}

function claimUniqueTableName(
  baseName: string,
  occupiedNameKeys: Set<string>,
): string {
  const cleanedBaseName = sanitizeTableNameInput(baseName) || "table";
  let candidate = cleanedBaseName;
  let suffix = 2;

  while (occupiedNameKeys.has(getNameKey(candidate))) {
    candidate = `${cleanedBaseName}_${suffix}`;
    suffix += 1;
  }

  occupiedNameKeys.add(getNameKey(candidate));
  return candidate;
}

function smoothIndexStatus(
  previous: TableIndexStatus | undefined,
  incoming: TableIndexStatus,
  fallbackTotalRows: number,
): TableIndexStatus {
  const totalRows =
    incoming.total_rows > 0
      ? incoming.total_rows
      : Math.max(0, fallbackTotalRows);

  if (
    incoming.state !== "indexing" ||
    !previous ||
    previous.state !== "indexing"
  ) {
    return { ...incoming, total_rows: totalRows };
  }

  const previousProgress = clamp(
    previous.progress || 0,
    0,
    INDEX_PROGRESS_DRIFT_CAP,
  );
  const serverProgress = clamp(
    incoming.progress || 0,
    0,
    INDEX_PROGRESS_DRIFT_CAP,
  );

  if (serverProgress > previousProgress + 0.05) {
    return { ...incoming, total_rows: totalRows };
  }

  const nextProgress = Math.max(
    serverProgress,
    clamp(
      previousProgress + INDEX_PROGRESS_DRIFT_STEP,
      0,
      INDEX_PROGRESS_DRIFT_CAP,
    ),
  );

  let nextProcessedRows = Math.max(0, incoming.processed_rows || 0);
  if (totalRows > 0) {
    const inferredRows = Math.min(
      totalRows - 1,
      Math.floor((nextProgress / 100) * totalRows),
    );
    nextProcessedRows = Math.max(nextProcessedRows, inferredRows);
  }

  return {
    ...incoming,
    total_rows: totalRows,
    progress: nextProgress,
    processed_rows: nextProcessedRows,
  };
}

export default function Upload({ homeControls = null }: UploadProps) {
  const { valueMode } = useAppUi();
  const userIsAdmin = isAdmin();
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [showUploadQueue, setShowUploadQueue] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selectedTableIds, setSelectedTableIds] = useState<number[]>([]);
  const selectionAnchorIdRef = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<TableSlice | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [activeTableId, setActiveTableId] = useState<number | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewRowCount, setPreviewRowCount] = useState(0);
  const [previewPageInput, setPreviewPageInput] = useState("1");
  const [previewSearchQuery, setPreviewSearchQuery] = useState("");
  const [previewSortColumn, setPreviewSortColumn] = useState<string | null>(
    null,
  );
  const [previewSortDirection, setPreviewSortDirection] = useState<
    "asc" | "desc"
  >("asc");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [deleteConfirmTable, setDeleteConfirmTable] =
    useState<TableSummary | null>(null);
  const [bulkDeleteConfirmIds, setBulkDeleteConfirmIds] = useState<number[] | null>(
    null,
  );
  const [rowActionMenuOpenId, setRowActionMenuOpenId] = useState<number | null>(
    null,
  );
  const [rowActionMenuPos, setRowActionMenuPos] = useState<
    { id: number; top: number; right: number } | null
  >(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingDescription, setEditingDescription] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<number | null>(null);
  const [renameHintId, setRenameHintId] = useState<number | null>(null);
  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [tableSortMode, setTableSortMode] = useState<TableSortMode>("recent");
  const [visibleTableCount, setVisibleTableCount] = useState(
    TABLES_RENDER_BATCH_SIZE,
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [uploadPickerOpen, setUploadPickerOpen] =
    useState<UploadPickerTarget | null>(null);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const [deletingTableIds, setDeletingTableIds] = useState<
    Record<number, boolean>
  >({});
  const [isDragActive, setIsDragActive] = useState(false);
  const [folderPaneWidth, setFolderPaneWidth] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(FOLDER_PANE_WIDTH_STORAGE_KEY);
      const parsed = raw ? Number(raw) : NaN;
      if (!Number.isFinite(parsed)) return 340;
      return Math.max(220, Math.min(720, Math.trunc(parsed)));
    } catch {
      return 340;
    }
  });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
  const [pinnedTableIds, setPinnedTableIds] = useState<number[]>(() => {
    try {
      const raw = window.localStorage.getItem(PINNED_TABLES_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value),
        )
        .map((value) => Math.trunc(value));
    } catch {
      return [];
    }
  });
  const [indexStatusByTable, setIndexStatusByTable] = useState<
    Record<number, TableIndexStatus>
  >({});
  const uploadQueueTitleId = useId();
  const uploadQueueDescriptionId = useId();
  const uploadDropDescriptionId = useId();
  const sortMenuId = useId();
  const tablesScrollRef = useRef<HTMLDivElement | null>(null);
  const previewAreaRef = useRef<HTMLDivElement | null>(null);
  const uploadPanelRef = useRef<HTMLDivElement | null>(null);
  const uploadDropFileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadDropFolderInputRef = useRef<HTMLInputElement | null>(null);
  const queueFileInputRef = useRef<HTMLInputElement | null>(null);
  const queueFolderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadPickerEmptyRef = useRef<HTMLDivElement | null>(null);
  const uploadPickerQueueRef = useRef<HTMLDivElement | null>(null);
  const uploadPickerEmptyButtonRef = useRef<HTMLButtonElement | null>(null);
  const uploadPickerQueueButtonRef = useRef<HTMLButtonElement | null>(null);
  const uploadDropClickLockRef = useRef(false);
  const uploadDropClickLockTimeoutRef = useRef<number | null>(null);
  const firstQueuedNameInputRef = useRef<HTMLInputElement | null>(null);
  const firstQueuedDescriptionInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const sortToggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const uploadDialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const deleteDialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const folderResizeStateRef = useRef<{
    active: boolean;
    startX: number;
    startWidth: number;
  }>({ active: false, startX: 0, startWidth: 280 });
  const isUploadDialogOpen = uploadQueue.length > 0;
  const isQueueInProgress = useMemo(() => {
    if (busy) {
      return true;
    }
    return uploadQueue.some(
      (item) => item.phase === "uploading" || item.phase === "processing",
    );
  }, [busy, uploadQueue]);

  useEffect(() => {
    window.localStorage.setItem(
      PINNED_TABLES_STORAGE_KEY,
      JSON.stringify(pinnedTableIds),
    );
  }, [pinnedTableIds]);

  useEffect(() => {
    listFolders()
      .then(setFolders)
      .catch(() => { });
  }, []);

  useEffect(() => {
    if (rowActionMenuOpenId === null) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(`[data-row-action-menu-root="${rowActionMenuOpenId}"]`)) {
        return;
      }
      setRowActionMenuOpenId(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRowActionMenuOpenId(null);
      }
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rowActionMenuOpenId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FOLDER_PANE_WIDTH_STORAGE_KEY,
        String(folderPaneWidth),
      );
    } catch {
      // ignore
    }
  }, [folderPaneWidth]);

  useEffect(() => {
    if (selectedFolder !== null) return;
    if (folders.length === 0) return;
    setSelectedFolder(folders[0]);
  }, [folders, selectedFolder]);

  async function estimateFileStats(nextFile: File): Promise<{
    rows: number | null;
    cols: number | null;
  }> {
    try {
      // Keep estimation lightweight: sample only the file head instead of scanning full file.
      const sampleBytes = Math.min(nextFile.size, 512 * 1024);
      if (sampleBytes <= 0) {
        return { rows: null, cols: null };
      }

      const sampleText = await nextFile.slice(0, sampleBytes).text();
      const lines = sampleText.split(/\r?\n/);
      const hasTrailingNewline = /\r?\n$/.test(sampleText);
      const sampledLineCount = Math.max(
        1,
        lines.length - (hasTrailingNewline ? 1 : 0),
      );
      const avgBytesPerLine = sampleBytes / sampledLineCount;
      if (!Number.isFinite(avgBytesPerLine) || avgBytesPerLine <= 0) {
        return { rows: null, cols: null };
      }

      const estimatedTotalLines = Math.max(
        sampledLineCount,
        Math.round(nextFile.size / avgBytesPerLine),
      );
      const delimiter = nextFile.name.toLowerCase().endsWith(".tsv")
        ? "\t"
        : ",";
      const headerLine = lines.find((line) => line.trim().length > 0) || "";
      const estimatedCols = headerLine
        ? countDelimitedColumns(headerLine, delimiter)
        : null;
      // Row estimate assumes a header row when subtracting 1 (actual header detection is server-side).
      return {
        rows: Math.max(0, estimatedTotalLines - 1),
        cols: estimatedCols,
      };
    } catch {
      return { rows: null, cols: null };
    }
  }

  function clearToastTimer() {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }

  function showSuccessToast(message: string) {
    clearToastTimer();
    const toastId = Date.now() + Math.random();
    setToast({ id: toastId, kind: "success", message });
    toastTimerRef.current = window.setTimeout(() => {
      setToast((current) =>
        current?.kind === "success" && current.id === toastId ? null : current,
      );
      toastTimerRef.current = null;
    }, SUCCESS_TOAST_MS);
  }

  const refreshIndexStatuses = useCallback(
    async (nextTables: TableSummary[]) => {
      if (nextTables.length === 0) {
        setIndexStatusByTable({});
        return;
      }

      const datasetIds = nextTables.map((table) => table.dataset_id);
      const statuses = await listIndexStatus(datasetIds);
      const nextStatusByTable: Record<number, TableIndexStatus> = {};

      for (const status of statuses) {
        nextStatusByTable[status.dataset_id] = status;
      }

      for (const table of nextTables) {
        if (!nextStatusByTable[table.dataset_id]) {
          nextStatusByTable[table.dataset_id] = {
            dataset_id: table.dataset_id,
            state: "ready",
            progress: 100,
            processed_rows: table.row_count,
            total_rows: table.row_count,
            message: "Vector index is ready.",
            started_at: null,
            updated_at: null,
            finished_at: null,
          };
        }
      }

      setIndexStatusByTable((previous) => {
        const merged: Record<number, TableIndexStatus> = {};
        for (const table of nextTables) {
          merged[table.dataset_id] = smoothIndexStatus(
            previous[table.dataset_id],
            nextStatusByTable[table.dataset_id],
            table.row_count,
          );
        }
        return merged;
      });
    },
    [],
  );

  const refresh = useCallback(async () => {
    const nextTables = await listTables({ includePending: true });
    setTables(nextTables);
    return nextTables;
  }, []);

  useEffect(() => {
    const pendingRaw = window.sessionStorage.getItem(
      PENDING_UPLOAD_SESSION_KEY,
    );
    if (!pendingRaw) {
      return;
    }

    let fileLabel = "a previous file";
    try {
      const pending = JSON.parse(pendingRaw) as { file_name?: string };
      if (pending.file_name && pending.file_name.trim()) {
        fileLabel = pending.file_name;
      }
    } catch {
      // Ignore parse failures and show a generic message.
    }

    window.sessionStorage.removeItem(PENDING_UPLOAD_SESSION_KEY);
    setReloadNotice(
      `Page was reloaded during upload for ${fileLabel}. Check Uploaded tables below for the result.`,
    );
  }, []);

  useEffect(() => {
    refresh().catch((error: unknown) => {
      setErr(getErrorMessage(error));
    });
  }, [refresh]);

  useEffect(() => {
    if (!busy) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [busy]);

  useEffect(() => {
    if (editingId === null || busy) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      const cursorIndex = input.value.length;
      input.setSelectionRange(cursorIndex, cursorIndex);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [editingId, busy]);

  useEffect(() => {
    if (!isUploadDialogOpen) {
      uploadDialogReturnFocusRef.current?.focus();
      uploadDialogReturnFocusRef.current = null;
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      uploadDialogReturnFocusRef.current = document.activeElement;
    }
  }, [isUploadDialogOpen]);

  useEffect(() => {
    if (!isUploadDialogOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && uploadPickerOpen) {
        setUploadPickerOpen(null);
        return;
      }

      if (event.key === "Escape" && !isQueueInProgress) {
        setUploadQueue([]);
        setErr(null);
        setStatus(null);
        return;
      }

      trapFocus(event, uploadPanelRef.current);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isQueueInProgress, isUploadDialogOpen, uploadPickerOpen]);

  useEffect(() => {
    if (!sortMenuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sortMenuRef.current && !sortMenuRef.current.contains(target)) {
        setSortMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSortMenuOpen(false);
        sortToggleButtonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortMenuOpen]);

  useEffect(() => {
    if (!sortMenuOpen) {
      return;
    }

    const activeSortIndex = TABLE_SORT_OPTIONS.findIndex(
      (option) => option.value === tableSortMode,
    );
    const rafId = window.requestAnimationFrame(() => {
      focusByIndex(
        sortMenuItemRefs.current,
        activeSortIndex === -1 ? 0 : activeSortIndex,
      );
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [sortMenuOpen, tableSortMode]);

  useEffect(() => {
    if (!uploadPickerOpen) {
      return;
    }

    const activePickerRef =
      uploadPickerOpen === "empty"
        ? uploadPickerEmptyRef
        : uploadPickerQueueRef;
    const activeToggleRef =
      uploadPickerOpen === "empty"
        ? uploadPickerEmptyButtonRef
        : uploadPickerQueueButtonRef;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        activePickerRef.current &&
        !activePickerRef.current.contains(target)
      ) {
        setUploadPickerOpen(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUploadPickerOpen(null);
        activeToggleRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [uploadPickerOpen]);

  useEffect(() => {
    if (busy || uploadQueue.length === 0) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      const input = firstQueuedNameInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      const cursorIndex = input.value.length;
      input.setSelectionRange(cursorIndex, cursorIndex);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [uploadQueue.length, busy]);

  useEffect(() => {
    if (!(showUploadQueue || uploadQueue.length > 0)) {
      setUploadPickerOpen(null);
    }
  }, [showUploadQueue, uploadQueue.length]);

  useEffect(() => {
    return () => {
      clearToastTimer();
      if (uploadDropClickLockTimeoutRef.current !== null) {
        window.clearTimeout(uploadDropClickLockTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!deleteConfirmTable) {
      deleteDialogReturnFocusRef.current?.focus();
      deleteDialogReturnFocusRef.current = null;
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      deleteDialogReturnFocusRef.current = document.activeElement;
    }

    const rafId = window.requestAnimationFrame(() => {
      deleteCancelButtonRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [deleteConfirmTable]);

  useEffect(() => {
    if (!deleteConfirmTable) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !deletingTableIds[deleteConfirmTable.dataset_id]
      ) {
        setDeleteConfirmTable(null);
        return;
      }

      trapFocus(event, deleteDialogRef.current);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [deleteConfirmTable, deletingTableIds]);

  useEffect(() => {
    if (tables.length === 0) {
      setIndexStatusByTable({});
      return;
    }

    // Defer polling so it doesn't block/extend the initial render critical path.
    const initialDelayMs = 2500;
    let intervalId: number | null = null;
    const timer = window.setTimeout(() => {
      // Kick off an immediate refresh after the initial paint window.
      void refreshIndexStatuses(tables).catch(() => {
        // Keep polling best-effort.
      });

      // Then continue polling.
      intervalId = window.setInterval(() => {
        refreshIndexStatuses(tables).catch(() => {
          // Keep polling best-effort.
        });
      }, 2000);
    }, initialDelayMs);

    return () => {
      window.clearTimeout(timer);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [tables, refreshIndexStatuses]);

  useEffect(() => {
    const element = tablesScrollRef.current;
    if (!element) {
      setShowScrollHint(false);
      setUploadedAtBottom(false);
      return;
    }

    const updateHint = () => {
      const atBottom =
        element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
      const canScroll = element.scrollHeight > element.clientHeight + 2;
      setShowScrollHint(canScroll);
      setUploadedAtBottom(atBottom);
    };

    updateHint();
    element.addEventListener("scroll", updateHint);
    window.addEventListener("resize", updateHint);

    return () => {
      element.removeEventListener("scroll", updateHint);
      window.removeEventListener("resize", updateHint);
    };
  }, [tables.length, tableSearchQuery]);

  const loadPreview = useCallback(
    async (
      datasetId: number,
      page = 1,
      sortOverride?: {
        sortColumn: string | null;
        sortDirection: "asc" | "desc";
      },
    ) => {
      setActiveTableId(datasetId);
      setPreviewPage(page);
      setPreviewPageInput(String(page));
      if (sortOverride) {
        setPreviewSearchQuery("");
        setPreviewSortColumn(sortOverride.sortColumn);
        setPreviewSortDirection(sortOverride.sortDirection);
      }
      setPreviewBusy(true);
      setPreviewErr(null);

      const effectiveSort = sortOverride ?? {
        sortColumn: previewSortColumn,
        sortDirection: previewSortDirection,
      };
      const sortParam = effectiveSort.sortColumn
        ? {
          sortColumn: effectiveSort.sortColumn,
          sortDirection: effectiveSort.sortDirection,
        }
        : undefined;
      const searchParam = previewSearchQuery.trim() || undefined;

      const rowFrom = (page - 1) * PREVIEW_ROWS_PER_PAGE;
      const rowTo = rowFrom + PREVIEW_ROWS_PER_PAGE;
      try {
        const slice = await getSlice(datasetId, rowFrom, rowTo, {
          flatten: false,
          sort: sortParam ?? undefined,
          search: searchParam,
        });
        setPreview(slice);
        setPreviewRowCount(Math.max(0, slice.row_count ?? 0));
      } catch (error: unknown) {
        setPreviewErr(getErrorMessage(error));
        setPreview(null);
      } finally {
        setPreviewBusy(false);
      }
    },
    [previewSortColumn, previewSortDirection, previewSearchQuery],
  );

  const loadPreviewRef = useRef(loadPreview);
  loadPreviewRef.current = loadPreview;

  // Clear preview and selection only when the selected table is no longer in the list.
  useEffect(() => {
    if (
      activeTableId !== null &&
      !tables.some((t) => t.dataset_id === activeTableId)
    ) {
      setActiveTableId(null);
      setPreview(null);
      setPreviewErr(null);
      setPreviewBusy(false);
      setPreviewPage(1);
      setPreviewRowCount(0);
      setPreviewSortColumn(null);
      setPreviewSortDirection("asc");
    }
  }, [activeTableId, tables]);

  // Restore selected table from localStorage when returning to the page (e.g. after closing a Edit Full Table tab).
  useEffect(() => {
    if (tables.length === 0) return;
    try {
      const raw = window.localStorage.getItem(SELECTED_PREVIEW_TABLE_KEY);
      if (raw === null) return;
      const id = parseInt(raw, 10);
      if (!Number.isFinite(id) || !tables.some((t) => t.dataset_id === id))
        return;
      setActiveTableId(id);
    } catch {
      /* ignore */
    }
  }, [tables]);

  useEffect(() => {
    if (
      activeTableId !== null &&
      tables.some((t) => t.dataset_id === activeTableId)
    ) {
      try {
        window.localStorage.setItem(
          SELECTED_PREVIEW_TABLE_KEY,
          String(activeTableId),
        );
      } catch {
        /* ignore */
      }
    } else if (activeTableId === null && tables.length > 0) {
      try {
        window.localStorage.removeItem(SELECTED_PREVIEW_TABLE_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [activeTableId, tables]);

  const previewRows = useMemo(
    () =>
      preview?.rows ? flattenRowsByValueMode(preview.rows, valueMode) : [],
    [preview?.rows, valueMode],
  );
  const normalizedPreviewSearch = previewSearchQuery.trim().toLowerCase();
  const hasPreviewSearch = normalizedPreviewSearch.length > 0;

  useEffect(() => {
    if (activeTableId === null) return;
    const t = setTimeout(() => {
      loadPreviewRef.current(activeTableId, 1);
    }, 350);
    return () => clearTimeout(t);
  }, [previewSearchQuery, activeTableId]);

  const previewTotalPages = Math.max(
    1,
    Math.ceil(previewRowCount / PREVIEW_ROWS_PER_PAGE),
  );
  const previewSafeCurrentPage = Math.min(
    Math.max(1, previewPage),
    previewTotalPages,
  );
  const previewPageInputWidthCh = Math.max(
    2,
    String(previewTotalPages).length + 1,
  );
  const normalizedTableSearchQuery = tableSearchQuery.trim().toLowerCase();

  const clearPreviewSelection = useCallback(() => {
    setActiveTableId(null);
    setPreview(null);
    setPreviewErr(null);
    setPreviewBusy(false);
    setPreviewPage(1);
    setPreviewRowCount(0);
    setPreviewSearchQuery("");
    setPreviewSortColumn(null);
    setPreviewSortDirection("asc");
  }, []);

  const getTopDisplayedTable = useCallback(
    (
      nextTables: TableSummary[],
      nextPinnedTableIds: number[] = pinnedTableIds,
    ): TableSummary | null => {
      const nextPinnedSet = new Set(nextPinnedTableIds);
      const nextSortedTables = sortTablesForDisplay(
        nextTables,
        nextPinnedSet,
        tableSortMode,
      );
      const nextFilteredTables = filterTablesForDisplay(
        nextSortedTables,
        normalizedTableSearchQuery,
      );
      return nextFilteredTables[0] ?? nextSortedTables[0] ?? null;
    },
    [normalizedTableSearchQuery, pinnedTableIds, tableSortMode],
  );

  const previewTopDisplayedTable = useCallback(
    async (
      nextTables: TableSummary[],
      nextPinnedTableIds: number[] = pinnedTableIds,
    ) => {
      const nextTopTable = getTopDisplayedTable(nextTables, nextPinnedTableIds);
      if (!nextTopTable) {
        clearPreviewSelection();
        return;
      }
      await loadPreview(nextTopTable.dataset_id, 1, {
        sortColumn: null,
        sortDirection: "asc",
      });
    },
    [clearPreviewSelection, getTopDisplayedTable, loadPreview, pinnedTableIds],
  );

  function commitPreviewPageInput() {
    const parsed = parseInt(previewPageInput, 10);
    const nextPage = Number.isFinite(parsed)
      ? Math.min(previewTotalPages, Math.max(1, parsed))
      : previewSafeCurrentPage;
    setPreviewPageInput(String(nextPage));
    if (activeTableId !== null && nextPage !== previewPage) {
      void loadPreview(activeTableId, nextPage);
    }
  }

  async function onUpload() {
    if (busy) {
      return;
    }

    const queuedItems = uploadQueue.filter(
      (item) => item.phase === "idle" || item.phase === "error",
    );
    if (queuedItems.length === 0) {
      // If only successful items remain, let the primary action close the upload queue.
      setUploadQueue([]);
      setShowUploadQueue(false);
      setErr(null);
      setStatus(null);
      return;
    }

    setReloadNotice(null);
    setBusy(true);
    setErr(null);

    let successCount = 0;
    let failureCount = 0;
    let firstFailureMessage: string | null = null;
    const occupiedNameKeys = new Set(
      tables.map((table) =>
        getNameKey(stripSupportedFileExtension(table.name) || "table"),
      ),
    );
    const preparedItems = queuedItems.map((item) => {
      const preferredName =
        sanitizeTableNameInput(item.name) ||
        sanitizeTableNameInput(item.file.name) ||
        "table";
      const normalizedDescription = sanitizeTableDescriptionInput(
        item.description,
      );
      return {
        item,
        normalizedName: claimUniqueTableName(preferredName, occupiedNameKeys),
        normalizedDescription,
      };
    });
    let completedCount = 0;
    setStatus(
      `Uploading ${queuedItems.length} file${queuedItems.length === 1 ? "" : "s"}...`,
    );
    window.sessionStorage.setItem(
      PENDING_UPLOAD_SESSION_KEY,
      JSON.stringify({
        file_name:
          queuedItems.length === 1
            ? queuedItems[0].file.name
            : `${queuedItems.length} files`,
        started_at: new Date().toISOString(),
      }),
    );

    await Promise.allSettled(
      preparedItems.map(
        async ({ item, normalizedName, normalizedDescription }) => {
          setUploadQueue((previous) =>
            previous.map((current) =>
              current.id === item.id
                ? {
                  ...current,
                  name: normalizedName,
                  phase: "uploading",
                  progress: 2,
                  error: null,
                }
                : current,
            ),
          );

          try {
            await uploadTable(
              item.file,
              normalizedName,
              normalizedDescription || null,
              (progress) => {
                setUploadQueue((previous) =>
                  previous.map((current) =>
                    current.id === item.id
                      ? {
                        ...current,
                        phase: progress.phase,
                        progress: Math.max(
                          current.progress,
                          progress.percent,
                        ),
                      }
                      : current,
                  ),
                );
              },
              item.folderId,
            );
            successCount += 1;
            setUploadQueue((previous) =>
              previous.map((current) =>
                current.id === item.id
                  ? {
                    ...current,
                    phase: "success",
                    progress: 100,
                    error: null,
                  }
                  : current,
              ),
            );
          } catch (error: unknown) {
            failureCount += 1;
            const message = getErrorMessage(error);
            if (!firstFailureMessage) {
              firstFailureMessage = message;
            }
            setUploadQueue((previous) =>
              previous.map((current) =>
                current.id === item.id
                  ? { ...current, phase: "error", progress: 0, error: message }
                  : current,
              ),
            );
          } finally {
            completedCount += 1;
            setStatus(
              `Completed ${completedCount}/${queuedItems.length} file${queuedItems.length === 1 ? "" : "s"}...`,
            );
          }
        },
      ),
    );

    window.sessionStorage.removeItem(PENDING_UPLOAD_SESSION_KEY);

    try {
      const nextTables = await refresh();
      if (successCount > 0) {
        await previewTopDisplayedTable(nextTables);
      }
    } catch (error: unknown) {
      setErr(getErrorMessage(error));
    }

    if (successCount > 0) {
      showSuccessToast(
        successCount === 1
          ? "1 file uploaded successfully"
          : `${successCount} files uploaded successfully`,
      );
    }
    if (failureCount > 0) {
      setErr(formatUploadFailureSummary(failureCount, firstFailureMessage));
    }
    if (successCount + failureCount === queuedItems.length) {
      setUploadQueue([]);
      setShowUploadQueue(false);
      if (successCount > 0 && failureCount === 0) {
        setUploadModalOpen(false);
      }
    }

    setStatus(null);
    setBusy(false);
  }

  async function onDelete(datasetId: number) {
    if (busy || deletingTableIds[datasetId]) {
      return;
    }
    const table = tables.find((current) => current.dataset_id === datasetId);
    if (!table) {
      setDeleteConfirmTable(null);
      return;
    }

    clearToastTimer();
    setErr(null);
    setDeletingTableIds((previous) => ({ ...previous, [datasetId]: true }));

    try {
      await deleteTable(datasetId);
      const nextTables = tables.filter(
        (current) => current.dataset_id !== datasetId,
      );
      const nextPinnedTableIds = pinnedTableIds.filter(
        (currentId) => currentId !== datasetId,
      );
      setTables(nextTables);
      setPinnedTableIds(nextPinnedTableIds);
      setIndexStatusByTable((previous) => {
        const next = { ...previous };
        delete next[datasetId];
        return next;
      });
      setDeleteConfirmTable(null);
      await previewTopDisplayedTable(nextTables, nextPinnedTableIds);
      showSuccessToast(`Successfully deleted table '${table.name}'`);
    } catch (error: unknown) {
      if (isTableNotFoundError(error)) {
        const nextTables = tables.filter(
          (current) => current.dataset_id !== datasetId,
        );
        const nextPinnedTableIds = pinnedTableIds.filter(
          (currentId) => currentId !== datasetId,
        );
        setTables(nextTables);
        setPinnedTableIds(nextPinnedTableIds);
        setIndexStatusByTable((previous) => {
          const next = { ...previous };
          delete next[datasetId];
          return next;
        });
        setDeleteConfirmTable(null);
        await previewTopDisplayedTable(nextTables, nextPinnedTableIds);
        showSuccessToast(`Successfully deleted table '${table.name}'`);
      } else {
        setErr(getErrorMessage(error));
      }
    } finally {
      setDeletingTableIds((previous) => {
        const next = { ...previous };
        delete next[datasetId];
        return next;
      });
    }
  }

  async function onBulkDelete(datasetIds: number[]) {
    const ids = Array.from(new Set(datasetIds)).filter((id) =>
      tables.some((t) => t.dataset_id === id),
    );
    if (ids.length === 0) {
      setBulkDeleteConfirmIds(null);
      return;
    }
    if (busy) return;

    clearToastTimer();
    setErr(null);
    setBusy(true);

    const removed = new Set<number>();
    try {
      for (const datasetId of ids) {
        if (deletingTableIds[datasetId]) continue;
        setDeletingTableIds((previous) => ({ ...previous, [datasetId]: true }));
        try {
          await deleteTable(datasetId);
          removed.add(datasetId);
        } catch (error: unknown) {
          if (isTableNotFoundError(error)) {
            removed.add(datasetId);
          } else {
            setErr(getErrorMessage(error));
          }
        } finally {
          setDeletingTableIds((previous) => {
            const next = { ...previous };
            delete next[datasetId];
            return next;
          });
        }
      }

      if (removed.size > 0) {
        const nextTables = tables.filter((t) => !removed.has(t.dataset_id));
        const nextPinnedTableIds = pinnedTableIds.filter(
          (id) => !removed.has(id),
        );
        setTables(nextTables);
        setPinnedTableIds(nextPinnedTableIds);
        setIndexStatusByTable((previous) => {
          const next = { ...previous };
          for (const id of removed) delete next[id];
          return next;
        });
        setSelectedTableIds([]);
        setBulkDeleteConfirmIds(null);
        await previewTopDisplayedTable(nextTables, nextPinnedTableIds);
        showSuccessToast(
          removed.size === 1
            ? "Successfully deleted 1 file"
            : `Successfully deleted ${removed.size} files`,
        );
      } else {
        setBulkDeleteConfirmIds(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onRename(datasetId: number) {
    if (busy) {
      return;
    }

    const nextName = sanitizeTableNameInput(editingName);
    if (!nextName) {
      setRenameHintId(datasetId);
      setEditingName("");
      setErr(null);
      return;
    }

    const nextNameKey = getNameKey(nextName);
    const hasDuplicateName = tables.some(
      (table) =>
        table.dataset_id !== datasetId &&
        getNameKey(stripSupportedFileExtension(table.name) || "table") ===
        nextNameKey,
    );
    if (hasDuplicateName) {
      setErr("Name already exists, please choose a different name.");
      return;
    }

    try {
      await renameTable(datasetId, nextName);
      const nextDescription =
        sanitizeTableDescriptionInput(editingDescription).trim();
      await patchTableDescription(
        datasetId,
        nextDescription.length > 0 ? nextDescription : null,
      );
      const currentTable = tables.find((t) => t.dataset_id === datasetId);
      if (currentTable && editingFolderId !== currentTable.folder_id) {
        await assignDatasetToFolder(datasetId, editingFolderId);
      }
      setEditingId(null);
      setEditingName("");
      setEditingDescription("");
      setEditingFolderId(null);
      setRenameHintId(null);
      await refresh();
      listFolders().then(setFolders).catch(() => { });
    } catch (error: unknown) {
      setErr(getErrorMessage(error));
    }
  }

  function validateSelectedFile(nextFile: File): string | null {
    if (!hasSupportedExtension(nextFile.name)) {
      return "Only CSV and TSV files can be uploaded.";
    }
    return null;
  }

  function onSelectFiles(nextFiles: FileList | File[] | null) {
    if (busy) {
      return;
    }
    setStatus(null);

    if (!nextFiles || nextFiles.length === 0) {
      return;
    }

    const existingFileKeys = new Set(
      uploadQueue.map((item) => getFileIdentity(item.file)),
    );
    const occupiedNameKeys = new Set<string>([
      ...tables.map((table) =>
        getNameKey(stripSupportedFileExtension(table.name) || "table"),
      ),
      ...uploadQueue.map((item) =>
        getNameKey(stripSupportedFileExtension(item.name) || "table"),
      ),
    ]);
    const nextItems: UploadQueueItem[] = [];
    const rejectedMessages: string[] = [];

    for (const nextFile of Array.from(nextFiles)) {
      if (
        isLikelyDirectoryPlaceholder(nextFile) ||
        isIgnorableMetadataFile(nextFile.name)
      ) {
        continue;
      }
      const validationError = validateSelectedFile(nextFile);
      if (validationError) {
        rejectedMessages.push(validationError);
        continue;
      }

      const fileKey = getFileIdentity(nextFile);
      if (existingFileKeys.has(fileKey)) {
        rejectedMessages.push("A selected file is already in the upload list.");
        continue;
      }
      existingFileKeys.add(fileKey);

      const withoutExt = sanitizeTableNameInput(nextFile.name) || "table";
      const uniqueName = claimUniqueTableName(withoutExt, occupiedNameKeys);
      nextItems.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        file: nextFile,
        name: uniqueName,
        progress: 0,
        phase: "idle",
        estimatedRows: null,
        estimatedCols: null,
        error: null,
        description: "",
        folderId: selectedFolder?.folder_id ?? null,
      });
    }

    if (nextItems.length === 0) {
      setErr(rejectedMessages[0] || "No valid CSV or TSV files selected.");
      return;
    }

    setErr(
      rejectedMessages.length
        ? `${rejectedMessages[0]}${rejectedMessages.length > 1 ? ` (+${rejectedMessages.length - 1} more)` : ""}`
        : null,
    );
    setUploadQueue((previous) => [...previous, ...nextItems]);

    for (const item of nextItems) {
      estimateFileStats(item.file).then((stats) => {
        setUploadQueue((previous) =>
          previous.map((current) =>
            current.id === item.id
              ? {
                ...current,
                estimatedRows: stats.rows,
                estimatedCols: stats.cols,
              }
              : current,
          ),
        );
      });
    }
  }

  function onRemoveQueuedFile(queueItemId: string) {
    if (busy) {
      return;
    }
    const nextQueue = uploadQueue.filter((item) => item.id !== queueItemId);
    setUploadQueue(nextQueue);
    if (nextQueue.length === 0) {
      setShowUploadQueue(false);
      setErr(null);
      setStatus(null);
    }
  }

  function onCancelAllQueuedFiles() {
    if (busy) {
      return;
    }
    setUploadQueue([]);
    setShowUploadQueue(false);
    setErr(null);
    setStatus(null);
  }

  function isQueuedNameDuplicate(
    queueItemId: string,
    candidateName: string,
  ): boolean {
    const normalizedCandidate = sanitizeTableNameInput(candidateName);
    if (!normalizedCandidate) {
      return false;
    }
    const candidateKey = getNameKey(normalizedCandidate);

    const existsInTables = tables.some(
      (table) =>
        getNameKey(stripSupportedFileExtension(table.name) || "table") ===
        candidateKey,
    );
    if (existsInTables) {
      return true;
    }

    return uploadQueue.some((item) => {
      if (item.id === queueItemId) {
        return false;
      }
      const normalizedItemName = sanitizeTableNameInput(item.name);
      if (!normalizedItemName) {
        return false;
      }
      return getNameKey(normalizedItemName) === candidateKey;
    });
  }

  function onChangeQueuedName(queueItemId: string, nextValue: string) {
    if (busy) {
      return;
    }

    const nextName = sanitizeTableNameInput(nextValue);
    setUploadQueue((previous) =>
      previous.map((item) =>
        item.id === queueItemId
          ? {
            ...item,
            name: nextName,
          }
          : item,
      ),
    );
  }

  function onChangeQueuedDescription(queueItemId: string, nextValue: string) {
    if (busy) {
      return;
    }

    const nextDescription = sanitizeTableDescriptionInput(nextValue);
    setUploadQueue((previous) =>
      previous.map((item) =>
        item.id === queueItemId
          ? {
            ...item,
            description: nextDescription,
          }
          : item,
      ),
    );
  }

  function onChangeQueuedFolder(
    queueItemId: string,
    nextFolderId: number | null,
  ) {
    if (busy) return;
    setUploadQueue((previous) =>
      previous.map((item) =>
        item.id === queueItemId ? { ...item, folderId: nextFolderId } : item,
      ),
    );
  }

  function onUploadDragEnter(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(true);
  }

  function onUploadDragOver(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragActive) {
      setIsDragActive(true);
    }
  }

  function onUploadDragLeave(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const relatedTarget = event.relatedTarget as Node | null;
    if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
      setIsDragActive(false);
    }
  }

  async function onUploadDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);
    const transferTypes = Array.from(event.dataTransfer.types || []);
    const hasFileTransferType = transferTypes.some((type) =>
      type.toLowerCase().includes("file"),
    );
    const hasDroppedFileItem = Array.from(event.dataTransfer.items || []).some(
      (item) => item.kind === "file",
    );
    if (
      event.dataTransfer.files.length > 0 ||
      hasDroppedFileItem ||
      hasFileTransferType
    ) {
      setShowUploadQueue(true);
    }
    if (
      event.dataTransfer.files.length === 0 &&
      (hasDroppedFileItem || hasFileTransferType)
    ) {
      setStatus(null);
      setErr("Unsupported file type. Please upload a .csv or .tsv file.");
      return;
    }
    const droppedFiles = await collectDroppedFiles(event.dataTransfer);
    onSelectFiles(droppedFiles);
  }

  function openUploadPicker(target: UploadPickerTarget) {
    setUploadPickerOpen((current) => (current === target ? null : target));
  }

  function lockUploadDropClick() {
    if (uploadDropClickLockTimeoutRef.current !== null) {
      window.clearTimeout(uploadDropClickLockTimeoutRef.current);
    }
    uploadDropClickLockRef.current = true;
    uploadDropClickLockTimeoutRef.current = window.setTimeout(() => {
      uploadDropClickLockRef.current = false;
      uploadDropClickLockTimeoutRef.current = null;
    }, 250);
  }

  function onUploadFiles(target: UploadPickerTarget) {
    setUploadPickerOpen(null);
    if (target === "empty") {
      lockUploadDropClick();
      uploadDropFileInputRef.current?.click();
      return;
    }
    queueFileInputRef.current?.click();
  }

  function onUploadFolder(target: UploadPickerTarget) {
    setUploadPickerOpen(null);
    if (target === "empty") {
      lockUploadDropClick();
      uploadDropFolderInputRef.current?.click();
      return;
    }
    queueFolderInputRef.current?.click();
  }
  const hasPendingUploads = uploadQueue.some(
    (item) => item.phase === "idle" || item.phase === "error",
  );
  const isUploadQueueVisible = showUploadQueue || uploadQueue.length > 0;
  const isUploadPopupOpen = uploadModalOpen || isUploadQueueVisible;

  function clampFolderPaneWidth(nextWidth: number) {
    return Math.max(220, Math.min(720, Math.trunc(nextWidth)));
  }

  function beginFolderPaneResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    folderResizeStateRef.current = {
      active: true,
      startX,
      startWidth: folderPaneWidth,
    };

    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);

    function onMove(moveEvent: PointerEvent) {
      if (!folderResizeStateRef.current.active) return;
      const delta = moveEvent.clientX - folderResizeStateRef.current.startX;
      setFolderPaneWidth(
        clampFolderPaneWidth(folderResizeStateRef.current.startWidth + delta),
      );
    }

    function onUp() {
      folderResizeStateRef.current.active = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  const activeTableName =
    activeTableId !== null
      ? tables.find((table) => table.dataset_id === activeTableId)?.name ||
      "Table"
      : null;
  const deleteConfirmBusy = deleteConfirmTable
    ? Boolean(deletingTableIds[deleteConfirmTable.dataset_id])
    : false;
  const showOfflineView = useMemo(() => {
    if (tables.length > 0 || busy) {
      return false;
    }
    if (
      typeof window !== "undefined" &&
      window.navigator &&
      window.navigator.onLine === false
    ) {
      return true;
    }
    return Boolean(err && isOfflineConnectionError(getErrorMessage(err)));
  }, [tables.length, busy, err]);

  useEffect(() => {
    if (!showOfflineView) {
      return;
    }
    document.title = "Error 503 | TabulaRAG";
    return () => {
      document.title = "Home | TabulaRAG";
    };
  }, [showOfflineView]);

  const pinnedTableIdSet = useMemo(
    () => new Set(pinnedTableIds),
    [pinnedTableIds],
  );
  const selectedFolderId = selectedFolder?.folder_id ?? null;
  const selectedFolderName = selectedFolder?.name ?? null;
  const sortedTables = useMemo(() => {
    return sortTablesForDisplay(tables, pinnedTableIdSet, tableSortMode);
  }, [tables, pinnedTableIdSet, tableSortMode]);
  const folderScopedTables = useMemo(() => {
    if (selectedFolderId === null) return sortedTables;
    return sortedTables.filter((table) => table.folder_id === selectedFolderId);
  }, [sortedTables, selectedFolderId]);
  const filteredTables = useMemo(() => {
    return filterTablesForDisplay(folderScopedTables, normalizedTableSearchQuery);
  }, [folderScopedTables, normalizedTableSearchQuery]);
  const visibleTables = useMemo(
    () => filteredTables.slice(0, visibleTableCount),
    [filteredTables, visibleTableCount],
  );
  const hasMoreFilteredTables = visibleTableCount < filteredTables.length;
  const tableSortLabel =
    TABLE_SORT_OPTIONS.find((option) => option.value === tableSortMode)
      ?.label || "Most recent";

  function onTogglePin(datasetId: number) {
    setPinnedTableIds((previous) => {
      if (previous.includes(datasetId)) {
        return previous.filter((currentId) => currentId !== datasetId);
      }
      return [datasetId, ...previous];
    });
  }

  function selectTableSortMode(nextMode: TableSortMode) {
    setTableSortMode(nextMode);
    setSortMenuOpen(false);
    sortToggleButtonRef.current?.focus();
  }

  useEffect(() => {
    setVisibleTableCount(TABLES_RENDER_BATCH_SIZE);
  }, [normalizedTableSearchQuery, tableSortMode]);

  useEffect(() => {
    if (selectedTableIds.length === 0) return;
    const existing = new Set(tables.map((t) => t.dataset_id));
    setSelectedTableIds((prev) => prev.filter((id) => existing.has(id)));
  }, [tables, selectedTableIds.length]);

  function applyTableSelectionFromEvent(
    event: React.MouseEvent,
    datasetId: number,
  ) {
    const idsInView = visibleTables.map((t) => t.dataset_id);
    const currentIndex = idsInView.indexOf(datasetId);
    const anchorId = selectionAnchorIdRef.current;
    const anchorIndex = anchorId !== null ? idsInView.indexOf(anchorId) : -1;

    if (event.shiftKey && anchorIndex !== -1 && currentIndex !== -1) {
      const start = Math.min(anchorIndex, currentIndex);
      const end = Math.max(anchorIndex, currentIndex);
      setSelectedTableIds(idsInView.slice(start, end + 1));
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedTableIds((prev) =>
        prev.includes(datasetId)
          ? prev.filter((id) => id !== datasetId)
          : [...prev, datasetId],
      );
      selectionAnchorIdRef.current = datasetId;
      return;
    }

    setSelectedTableIds([datasetId]);
    selectionAnchorIdRef.current = datasetId;
  }

  useEffect(() => {
    if (activeTableId === null) {
      return;
    }
    const activeIndex = filteredTables.findIndex(
      (table) => table.dataset_id === activeTableId,
    );
    if (activeIndex === -1 || activeIndex < visibleTableCount) {
      return;
    }
    setVisibleTableCount(
      Math.ceil((activeIndex + 1) / TABLES_RENDER_BATCH_SIZE) *
      TABLES_RENDER_BATCH_SIZE,
    );
  }, [activeTableId, filteredTables, visibleTableCount]);

  function onSortToggleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      setSortMenuOpen(true);
    }
  }

  function onSortMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const currentTarget = event.target as HTMLElement | null;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusByOffset(sortMenuItemRefs.current, currentTarget, 1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusByOffset(sortMenuItemRefs.current, currentTarget, -1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusByIndex(sortMenuItemRefs.current, 0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusByIndex(sortMenuItemRefs.current, TABLE_SORT_OPTIONS.length - 1);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setSortMenuOpen(false);
      sortToggleButtonRef.current?.focus();
      return;
    }

    if (event.key === "Tab") {
      setSortMenuOpen(false);
    }
  }

  if (showOfflineView) {
    return (
      <div className="page page-stack">
        <div className="hero">
          <div className="hero-title-row">
            <img
              src={logo64}
              srcSet={`${logo64} 1x, ${logo128} 2x`}
              width={48}
              height={48}
              alt="TabulaRAG"
              className="hero-logo"
              loading="eager"
              fetchPriority="high"
            />
            <div className="hero-title" aria-label="TabulaRAG">
              <span className="hero-title-tabula">Tabula</span>
              <span className="hero-title-rag">RAG</span>
            </div>
          </div>
          <div className="hero-subtitle">
            Fast-ingesting tabular data RAG with cell-level citations
          </div>
        </div>
        <div className="table-status-layout table-status-layout--compact">
          <TableStatusCard
            code="503"
            title="Service Unavailable"
            description="The server could not be reached. Try again in a moment."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="upload-home-page-scroll">
      <div className="page page-stack upload-home-page">
        {toast && (
          <div
            key={toast.id}
            className="toast success"
            role="status"
            aria-live="polite"
          >
            <span>{toast.message}</span>
          </div>
        )}

        {deleteConfirmTable && (
          <div
            className="confirm-modal-overlay"
            onClick={() => {
              if (!deleteConfirmBusy) {
                setDeleteConfirmTable(null);
              }
            }}
          >
            <div
              ref={deleteDialogRef}
              className="confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-confirm-title"
              aria-describedby="delete-confirm-description"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <h3 id="delete-confirm-title">Delete table permanently?</h3>
              <p id="delete-confirm-description" className="small">
                This will permanently delete{" "}
                <span className="confirm-modal-table-name">
                  {deleteConfirmTable.name}
                </span>
                . This action cannot be undone.
              </p>
              <div className="confirm-modal-actions">
                <button
                  ref={deleteCancelButtonRef}
                  type="button"
                  className="surface-btn"
                  onClick={() => {
                    setDeleteConfirmTable(null);
                  }}
                  disabled={deleteConfirmBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="confirm-delete-button"
                  onClick={() => {
                    void onDelete(deleteConfirmTable.dataset_id);
                  }}
                  disabled={deleteConfirmBusy}
                >
                  {deleteConfirmBusy ? "Deleting..." : "Permanently delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {bulkDeleteConfirmIds && (
          <div
            className="confirm-modal-overlay"
            onClick={() => {
              if (!busy) {
                setBulkDeleteConfirmIds(null);
              }
            }}
          >
            <div
              className="confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="bulk-delete-confirm-title"
              aria-describedby="bulk-delete-confirm-description"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <h3 id="bulk-delete-confirm-title">Delete files permanently?</h3>
              <p id="bulk-delete-confirm-description" className="small">
                This will permanently delete{" "}
                <span className="confirm-modal-table-name">
                  {bulkDeleteConfirmIds.length}
                </span>{" "}
                file{bulkDeleteConfirmIds.length === 1 ? "" : "s"}. This action
                cannot be undone.
              </p>
              <div className="confirm-modal-actions">
                <button
                  type="button"
                  className="surface-btn"
                  onClick={() => {
                    setBulkDeleteConfirmIds(null);
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="confirm-delete-button"
                  onClick={() => {
                    void onBulkDelete(bulkDeleteConfirmIds);
                  }}
                  disabled={busy}
                >
                  {busy ? "Deleting..." : "Permanently delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="upload-home-header" aria-hidden={isUploadPopupOpen}>
          <div className="upload-home-brand">
            <div className="upload-home-brand__headline">
              <img
                src={logo64}
                srcSet={`${logo64} 1x, ${logo128} 2x`}
                width={48}
                height={48}
                alt="TabulaRAG"
                className="hero-logo upload-home-brand__logo"
                loading="eager"
                fetchPriority="high"
              />
              <div className="upload-home-brand__title" aria-label="TabulaRAG">
                <span className="upload-home-brand__title-tabula">Tabula</span>
                <span className="upload-home-brand__title-rag">
                  <span className="upload-home-brand__title-r">R</span>AG
                </span>
              </div>
            </div>
            <div className="upload-home-brand__subtitle">
              Fast-ingesting tabular data RAG with cell-level citations
            </div>
          </div>

          <div className="upload-home-header__end">{homeControls}</div>
        </div>

        {isUploadPopupOpen && (
          <div
            className="upload-modal-overlay"
            role="presentation"
            onClick={() => {
              if (busy || isQueueInProgress) return;
              if (uploadQueue.length > 0) {
                onCancelAllQueuedFiles();
              }
              setUploadModalOpen(false);
              setUploadPickerOpen(null);
              setIsDragActive(false);
            }}
          >
            <div
              ref={uploadPanelRef}
              className={`panel upload-panel upload-modal${isUploadQueueVisible ? " has-queue" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-busy={busy}
              onClick={(event) => event.stopPropagation()}
              onDragEnter={onUploadDragEnter}
              onDragOver={onUploadDragOver}
              onDragLeave={onUploadDragLeave}
              onDrop={onUploadDrop}
            >
              <div className="upload-modal__topbar">
                <div className="upload-modal__title">
                  Upload CSV/TSV{selectedFolderName ? ` to ${selectedFolderName}` : ""}
                </div>
                <button
                  type="button"
                  className="icon-button upload-close-button"
                  aria-label="Close upload dialog"
                  onClick={() => {
                    if (busy || isQueueInProgress) return;
                    if (uploadQueue.length > 0) {
                      onCancelAllQueuedFiles();
                    }
                    setUploadModalOpen(false);
                    setUploadPickerOpen(null);
                    setIsDragActive(false);
                  }}
                >
                  ✕
                </button>
              </div>
          {!isUploadQueueVisible ? (
            <div
              className={`upload-drop ${isDragActive ? "drag-active" : ""}`}
              role="button"
              tabIndex={0}
              aria-labelledby="upload-drop-title"
              aria-describedby={uploadDropDescriptionId}
              onClick={(event) => {
                const target = event.target as HTMLElement | null;
                if (
                  busy ||
                  uploadDropClickLockRef.current ||
                  target?.closest(".upload-picker-wrap")
                ) {
                  return;
                }
                uploadDropFileInputRef.current?.click();
              }}
              onDragEnter={onUploadDragEnter}
              onDragOver={onUploadDragOver}
              onDragLeave={onUploadDragLeave}
              onDrop={onUploadDrop}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  uploadDropFileInputRef.current?.click();
                }
              }}
            >
              <input
                ref={(element) => {
                  uploadDropFileInputRef.current = element;
                }}
                type="file"
                multiple
                accept=".csv,.tsv"
                onChange={(event) => {
                  onSelectFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
              <input
                ref={uploadDropFolderInputRef}
                {...FOLDER_INPUT_PROPS}
                type="file"
                multiple
                accept=".csv,.tsv"
                onChange={(event) => {
                  onSelectFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
              <div className="upload-icon-row">
                <div className="upload-picker-wrap" ref={uploadPickerEmptyRef}>
                  <button
                    ref={uploadPickerEmptyButtonRef}
                    type="button"
                    className={`upload-icon icon-trigger upload-picker-trigger ${uploadPickerOpen === "empty" ? "active" : ""}`}
                    aria-label="Upload options"
                    title="Upload options"
                    aria-haspopup="menu"
                    aria-expanded={uploadPickerOpen === "empty"}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openUploadPicker("empty");
                    }}
                    disabled={busy}
                  >
                    <img
                      src={uploadLogo}
                      alt=""
                      aria-hidden="true"
                      className="upload-plus-icon"
                    />
                  </button>
                  {uploadPickerOpen === "empty" && (
                    <div
                      className="upload-picker-menu"
                      role="menu"
                      aria-label="Upload options"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="upload-picker-item"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onUploadFiles("empty");
                        }}
                      >
                        Upload files
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="upload-picker-item"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onUploadFolder("empty");
                        }}
                      >
                        Upload folder
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div id="upload-drop-title" className="upload-title">
                Select or Drag &amp; Drop to Start Uploading
              </div>
              <div id={uploadDropDescriptionId} className="upload-subtitle">
                Supported file formats: .csv, .tsv, up to 50MB.
              </div>
            </div>
          ) : (
            <>
              <h2 id={uploadQueueTitleId}>Upload CSV/TSV</h2>
              <p id={uploadQueueDescriptionId} className="sr-only">
                Review file names, fix any validation errors, then upload or
                cancel the queue.
              </p>
              <div className="row upload-queue-toolbar">
                <input
                  ref={queueFileInputRef}
                  type="file"
                  multiple
                  accept=".csv,.tsv"
                  onChange={(event) => {
                    onSelectFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                  className="file-input-hidden"
                />
                <input
                  ref={queueFolderInputRef}
                  {...FOLDER_INPUT_PROPS}
                  type="file"
                  multiple
                  accept=".csv,.tsv"
                  onChange={(event) => {
                    onSelectFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                  className="file-input-hidden"
                />
                <div className="upload-picker-wrap" ref={uploadPickerQueueRef}>
                  <button
                    ref={uploadPickerQueueButtonRef}
                    onClick={() => openUploadPicker("queue")}
                    type="button"
                    className={`surface-btn upload-add-more-button ${uploadPickerOpen === "queue" ? "active" : ""}`}
                    aria-label="Add more files"
                    title="Add more files"
                    aria-haspopup="menu"
                    aria-expanded={uploadPickerOpen === "queue"}
                    disabled={busy || isQueueInProgress}
                  >
                    <svg
                      className="upload-add-more-button__icon"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                      role="presentation"
                    >
                      <path
                        d="M12 5v14M5 12h14"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span className="upload-add-more-button__label">
                      Add more files
                    </span>
                  </button>
                  {uploadPickerOpen === "queue" && (
                    <div
                      className="upload-picker-menu"
                      role="menu"
                      aria-label="Upload options"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="upload-picker-item"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onUploadFiles("queue");
                        }}
                      >
                        Upload files
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="upload-picker-item"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onUploadFolder("queue");
                        }}
                      >
                        Upload folder
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <ul
                className="upload-queue-list"
                aria-label="Selected files for upload"
              >
                {uploadQueue.map((item, index) => {
                  const progressValue = Math.max(
                    0,
                    Math.min(100, item.progress),
                  );
                  const canEditQueuedName =
                    item.phase === "idle" || item.phase === "error";
                  const queueNameIsEmpty =
                    sanitizeTableNameInput(item.name).length === 0;
                  const queueNameIsDuplicate =
                    !queueNameIsEmpty &&
                    isQueuedNameDuplicate(item.id, item.name);
                  const estimatedRowsText =
                    item.estimatedRows === null
                      ? "..."
                      : item.estimatedRows.toLocaleString();
                  const estimatedColsText =
                    item.estimatedCols === null
                      ? "..."
                      : item.estimatedCols.toLocaleString();
                  const processedRows =
                    item.estimatedRows === null
                      ? null
                      : item.phase === "success"
                        ? item.estimatedRows
                        : Math.max(
                          0,
                          Math.min(
                            item.estimatedRows,
                            Math.round(
                              (progressValue / 100) * item.estimatedRows,
                            ),
                          ),
                        );
                  const stateLabel =
                    item.phase === "success"
                      ? "Uploaded"
                      : item.phase === "error"
                        ? "Failed"
                        : item.phase === "processing"
                          ? "Processing"
                          : item.phase === "uploading"
                            ? "Uploading"
                            : "In Queue";
                  const progressLabel =
                    item.phase === "idle"
                      ? null
                      : item.phase === "error"
                        ? "Failed"
                        : item.phase === "success"
                          ? "100%"
                          : item.phase === "processing"
                            ? `${progressValue.toFixed(1)}%`
                            : `${Math.round(progressValue)}%`;
                  const rowsLabel =
                    item.estimatedRows === null
                      ? "Rows: estimating..."
                      : `Rows: ${(processedRows ?? 0).toLocaleString()} / ${item.estimatedRows.toLocaleString()}`;
                  const queueItemSubtitleId = `${item.id}-subtitle`;
                  const queueItemStateId = `${item.id}-state`;
                  const queueItemValidationId = `${item.id}-validation`;
                  const queueItemUploadErrorId = `${item.id}-upload-error`;
                  const progressFillWidth =
                    item.phase === "error" ? 100 : progressValue;
                  const progressFillClassName = `upload-progress-fill ${item.phase === "processing" ? "processing" : ""
                    } ${item.phase === "success" ? "success" : ""
                    } ${item.phase === "error" ? "error" : ""}`;

                  return (
                    <li
                      key={item.id}
                      className={`upload-queue-item ${item.phase}`}
                    >
                      <div className="upload-queue-head compact">
                        <span
                          className="upload-queue-file-icon"
                          aria-hidden="true"
                        >
                          <svg viewBox="0 0 24 24" role="presentation">
                            <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V7h3.5L13 3.5zM7.5 11a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9zm0 4a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z" />
                          </svg>
                        </span>
                        <div className="upload-queue-file-text">
                          <input
                            ref={
                              index === 0 && canEditQueuedName
                                ? firstQueuedNameInputRef
                                : null
                            }
                            type="text"
                            className={`upload-queue-name-input ${canEditQueuedName && (queueNameIsEmpty || queueNameIsDuplicate) ? "invalid" : ""}`}
                            value={item.name}
                            onChange={(event) => {
                              onChangeQueuedName(item.id, event.target.value);
                            }}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="Enter table name"
                            maxLength={SAFE_TABLE_NAME_MAX_LENGTH}
                            disabled={busy || !canEditQueuedName}
                            aria-label={`Table name for ${item.file.name}`}
                            aria-invalid={
                              canEditQueuedName &&
                              (queueNameIsEmpty || queueNameIsDuplicate)
                            }
                            aria-describedby={`${queueItemSubtitleId} ${queueItemStateId} ${queueNameIsEmpty || queueNameIsDuplicate
                              ? queueItemValidationId
                              : ""
                              } ${item.error ? queueItemUploadErrorId : ""
                              }`.trim()}
                          />
                          <div
                            id={queueItemSubtitleId}
                            className="upload-queue-file-subtitle"
                          >
                            {item.file.name} - {formatFileSize(item.file.size)}{" "}
                            ({estimatedRowsText} rows, {estimatedColsText} cols){" "}
                            <span
                              id={queueItemStateId}
                              className={`upload-queue-state ${item.phase}`}
                            >
                              {stateLabel}
                            </span>
                          </div>
                          <label className="upload-queue-description">
                            <input
                              ref={
                                index === 0 && canEditQueuedName
                                  ? firstQueuedDescriptionInputRef
                                  : null
                              }
                              type="text"
                              className={`upload-queue-description-input ${canEditQueuedName ? "" : "disabled"
                                }`}
                              value={item.description}
                              onChange={(event) => {
                                onChangeQueuedDescription(
                                  item.id,
                                  event.target.value,
                                );
                              }}
                              placeholder="Add a short summary for better retrieval (optional)"
                              maxLength={SAFE_TABLE_DESCRIPTION_MAX_LENGTH}
                              disabled={busy || !canEditQueuedName}
                            />
                          </label>
                          {canEditQueuedName &&
                            folders.length > 0 &&
                            selectedFolderId === null && (
                            <label className="upload-queue-folder-label">
                              <span className="upload-queue-folder-label-text">
                                Folder
                              </span>
                              <select
                                className="upload-queue-folder-select"
                                value={item.folderId ?? ""}
                                disabled={busy}
                                aria-label="Assign to folder"
                                onChange={(e) =>
                                  onChangeQueuedFolder(
                                    item.id,
                                    e.target.value !== ""
                                      ? Number(e.target.value)
                                      : null,
                                  )
                                }
                              >
                                {userIsAdmin && (
                                  <option value="">No folder</option>
                                )}
                                {(userIsAdmin
                                  ? folders
                                  : folders.filter(
                                    (f) => f.privacy === "public",
                                  )
                                ).map((folder) => (
                                  <option
                                    key={folder.folder_id}
                                    value={folder.folder_id}
                                  >
                                    {folder.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                        <div className="upload-queue-right">
                          {progressLabel && (
                            <span className="upload-progress-percent upload-queue-percent">
                              {progressLabel}
                            </span>
                          )}
                        </div>
                        {!isQueueInProgress && (
                          <button
                            type="button"
                            className="upload-queue-remove"
                            onClick={() => onRemoveQueuedFile(item.id)}
                            aria-label={`Remove ${item.file.name}`}
                            title="Remove file"
                            disabled={busy}
                          >
                            ×
                          </button>
                        )}
                      </div>
                      {item.phase !== "idle" && (
                        <div
                          className="upload-progress-track upload-queue-track compact"
                          role={
                            item.phase === "error" ? "status" : "progressbar"
                          }
                          aria-label={`${item.file.name} upload progress`}
                          aria-valuemin={item.phase === "error" ? undefined : 0}
                          aria-valuemax={
                            item.phase === "error" ? undefined : 100
                          }
                          aria-valuenow={
                            item.phase === "error"
                              ? undefined
                              : Math.round(progressValue)
                          }
                          aria-valuetext={`${stateLabel}. ${item.phase === "error"
                            ? item.error || "Upload failed."
                            : rowsLabel
                            }`}
                        >
                          <div
                            className={progressFillClassName}
                            style={{
                              width: `${progressFillWidth}%`,
                            }}
                          />
                        </div>
                      )}
                      {item.phase !== "idle" && (
                        <div className="upload-queue-rows">{rowsLabel}</div>
                      )}
                      {queueNameIsEmpty && canEditQueuedName && (
                        <p
                          id={queueItemValidationId}
                          className="small error upload-queue-error"
                        >
                          Table name cannot be empty.
                        </p>
                      )}
                      {queueNameIsDuplicate && canEditQueuedName && (
                        <p
                          id={queueItemValidationId}
                          className="small error upload-queue-error"
                        >
                          Name already exists, please choose a different name.
                        </p>
                      )}
                      {item.error && (
                        <p
                          id={queueItemUploadErrorId}
                          className="small error upload-queue-error"
                          role="alert"
                        >
                          {item.error}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="upload-queue-footer">
                <div className="small">
                  Tip: You can rename each table before clicking 'Upload all
                  files'.
                </div>
                {!isQueueInProgress && (
                  <div className="upload-queue-footer-actions">
                    <button
                      type="button"
                      className="surface-btn upload-cancel-all-button"
                      onClick={onCancelAllQueuedFiles}
                      disabled={busy}
                    >
                      Cancel all
                    </button>
                    <button
                      onClick={onUpload}
                      disabled={!hasPendingUploads || busy}
                      className="primary"
                      type="button"
                    >
                      {busy ? "Uploading..." : "Upload all files"}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="upload-panel-status" aria-live="polite">
            {err ? (
              <p className="small error upload-panel-status__message" role="alert">
                {err}
              </p>
            ) : reloadNotice ? (
              <p
                className="small status-info upload-panel-status__message"
                role="status"
              >
                {reloadNotice}
              </p>
            ) : status ? (
              <p
                className="small status-info upload-panel-status__message"
                role="status"
              >
                {status}
              </p>
            ) : null}
          </div>
            </div>
          </div>
        )}

        <div
          className="panel uploaded-tables-panel"
          aria-hidden={isUploadPopupOpen}
        >
          <div
            className="uploaded-tables-panel__content"
            style={
              {
                ["--folders-pane-width" as never]: `${folderPaneWidth}px`,
              } as React.CSSProperties
            }
          >
            <div className="uploaded-tables-panel__folders">
              <FolderSidePanel
                variant="embedded"
                open
                onClose={() => {
                  listFolders()
                    .then(setFolders)
                    .catch(() => { });
                }}
                isAdmin={userIsAdmin}
                selectedFolderId={selectedFolderId}
                onSelectFolder={(folder) => {
                  setSelectedFolder(folder);
                }}
                togglePaneLabel="Folders"
              />
            </div>
            <div
              className="uploaded-tables-panel__folders-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize folders pane"
              onPointerDown={beginFolderPaneResize}
            />

            <div className="uploaded-tables-panel__tables">
              <div className="row tables-header-row">
                <div className="tables-header-controls">
                  <div className="sort-menu-wrap" ref={sortMenuRef}>
                    <button
                      ref={sortToggleButtonRef}
                      type="button"
                      className={`sort-toggle-button ${sortMenuOpen ? "active" : ""}`}
                      onClick={() => setSortMenuOpen((current) => !current)}
                      onKeyDown={onSortToggleKeyDown}
                      aria-haspopup="menu"
                      aria-expanded={sortMenuOpen}
                      aria-controls={sortMenuOpen ? sortMenuId : undefined}
                      aria-label={`Sort tables. Current order: ${tableSortLabel}`}
                      title="Sort tables"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        role="presentation"
                        className="sort-toggle-icon"
                      >
                        <path d="M8.7 3.3a1 1 0 0 1 1.4 0l3 3a1 1 0 1 1-1.4 1.4L10.4 6.4V20a1 1 0 1 1-2 0V6.4L7.1 7.7a1 1 0 1 1-1.4-1.4l3-3zm6.6 17.4a1 1 0 0 1-1.4 0l-3-3a1 1 0 0 1 1.4-1.4l1.3 1.3V4a1 1 0 1 1 2 0v13.6l1.3-1.3a1 1 0 1 1 1.4 1.4l-3 3z" />
                      </svg>
                      <span className="sort-toggle-text">
                        Sort: {tableSortLabel}
                      </span>
                    </button>
                    {sortMenuOpen && (
                      <div
                        id={sortMenuId}
                        className="sort-menu"
                        role="menu"
                        aria-label="Sort options"
                        onKeyDown={onSortMenuKeyDown}
                      >
                        {TABLE_SORT_OPTIONS.map((option, index) => (
                          <button
                            key={option.value}
                            ref={(element) => {
                              sortMenuItemRefs.current[index] = element;
                            }}
                            type="button"
                            role="menuitemradio"
                            aria-checked={tableSortMode === option.value}
                            className={`sort-menu-item ${tableSortMode === option.value ? "active" : ""}`}
                            onClick={() => {
                              selectTableSortMode(option.value);
                            }}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <label
                    className="tables-search-input-wrap"
                    aria-label="Search table name"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      role="presentation"
                      className="tables-search-icon"
                      aria-hidden="true"
                    >
                      <path
                        d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
                        fill="currentColor"
                      />
                    </svg>
                    <input
                      type="text"
                      className="tables-search-input"
                      value={tableSearchQuery}
                      onChange={(event) =>
                        setTableSearchQuery(event.target.value)
                      }
                      placeholder="Search"
                      aria-label="Search table name"
                    />
                  </label>
                  {selectedTableIds.length > 0 && (
                    <button
                      type="button"
                      className="sort-toggle-button"
                      title={`Delete ${selectedTableIds.length} selected file${selectedTableIds.length === 1 ? "" : "s"}`}
                      aria-label={`Delete ${selectedTableIds.length} selected files`}
                      disabled={busy}
                      onClick={() => {
                        setBulkDeleteConfirmIds(selectedTableIds);
                      }}
                    >
                      Delete ({selectedTableIds.length})
                    </button>
                  )}
                  <button
                    type="button"
                    className="tables-header-upload-btn"
                    aria-label={`Upload tables${selectedFolderName ? ` to ${selectedFolderName}` : ""}`}
                    title="Upload tables"
                    disabled={isUploadPopupOpen}
                    onClick={() => {
                      setUploadModalOpen(true);
                      setUploadPickerOpen(null);
                      setShowUploadQueue(false);
                      setIsDragActive(false);
                      setErr(null);
                      setStatus(null);
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                      role="presentation"
                    >
                      <path
                        d="M12 5v14M5 12h14"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              <p className="sr-only" role="status" aria-live="polite">
                Showing {filteredTables.length} uploaded table
                {filteredTables.length === 1 ? "" : "s"}
                {normalizedTableSearchQuery
                  ? ` matching ${tableSearchQuery.trim()}`
                  : ""}
                . Sorted by {tableSortLabel}.
              </p>

              {filteredTables.length === 0 ? (
                <div className="tables-empty-state-wrapper">
                  <p className="small">
                    {selectedFolderName ? `No tables in ${selectedFolderName}` : "No tables uploaded yet"}
                  </p>
                </div>
              ) : (
                <div className="tables-scroll" ref={tablesScrollRef}>
                  <ul>
                    {visibleTables.map((table) => {
                      const indexStatus = indexStatusByTable[table.dataset_id];
                      const indexState = indexStatus?.state || "ready";
                      const isPinned = pinnedTableIdSet.has(table.dataset_id);
                      const indexProgress = Math.max(
                    0,
                    Math.min(
                      100,
                      Math.round(
                        typeof indexStatus?.progress === "number"
                          ? indexStatus.progress
                          : indexState === "ready"
                            ? 100
                            : 0,
                      ),
                    ),
                  );
                  const indexLabel =
                    indexState === "queued"
                      ? "Queued"
                      : indexState === "indexing"
                        ? "Indexing"
                        : indexState === "error"
                          ? "Index failed"
                          : "Indexed";
                  const isIndexing = indexState === "indexing";
                  const readyStatusLabel = indexLabel;

                  return (
                    <li key={table.dataset_id}>
                      {/*
                        Multi-select needs to win over nested controls.
                        Use capture so ctrl/cmd/shift clicks don't get overridden by inner button clicks.
                      */}
                      <div
                        className={`list-row list-item ${selectedTableIds.includes(table.dataset_id) ? "selected" : ""
                          }`}
                        onClickCapture={(event) => {
                          if (event.shiftKey || event.metaKey || event.ctrlKey) {
                            applyTableSelectionFromEvent(event, table.dataset_id);
                            event.preventDefault();
                            event.stopPropagation();
                          }
                        }}
                      >
                        <button
                          type="button"
                          className={`icon-button ${isPinned ? "pinned" : "pin"}`}
                          onClick={() => onTogglePin(table.dataset_id)}
                          aria-label={
                            isPinned
                              ? `Unpin ${table.name}`
                              : `Pin ${table.name}`
                          }
                          title={isPinned ? "Unpin table" : "Pin table"}
                          disabled={
                            busy || Boolean(deletingTableIds[table.dataset_id])
                          }
                        >
                          <svg viewBox="0 0 24 24" role="presentation">
                            <path d="M9 3h6l-1 5 3 3v1h-4v7l-1 1-1-1v-7H7v-1l3-3-1-5z" />
                          </svg>
                        </button>

                        {editingId === table.dataset_id ? (
                          <div className="uploaded-table-main">
                            <input
                              ref={renameInputRef}
                              value={editingName}
                              onChange={(event) => {
                                setEditingName(
                                  sanitizeTableNameInput(event.target.value),
                                );
                                if (renameHintId === table.dataset_id) {
                                  setRenameHintId(null);
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  void onRename(table.dataset_id);
                                }
                              }}
                              className={`rename-input ${renameHintId === table.dataset_id
                                ? "invalid"
                                : ""
                                }`}
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
                              maxLength={SAFE_TABLE_NAME_MAX_LENGTH}
                              placeholder={
                                renameHintId === table.dataset_id
                                  ? "Name cannot be empty."
                                  : "Enter table name"
                              }
                              disabled={busy}
                              aria-label={`Rename ${table.name}`}
                              aria-invalid={renameHintId === table.dataset_id}
                            />
                            <input
                              value={editingDescription}
                              onChange={(event) => {
                                setEditingDescription(
                                  sanitizeTableDescriptionInput(
                                    event.target.value,
                                  ),
                                );
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  void onRename(table.dataset_id);
                                }
                              }}
                              className="rename-input uploaded-table-description-input"
                              maxLength={SAFE_TABLE_DESCRIPTION_MAX_LENGTH}
                              placeholder="Add table description"
                              disabled={busy}
                              aria-label={`Edit description for ${table.name}`}
                            />
                            {selectedFolderId === null &&
                              folders.length > 0 &&
                              (userIsAdmin || table.folder_privacy === "public") && (
                              <label className="upload-queue-folder-label">
                                <span className="upload-queue-folder-label-text">Folder</span>
                                <select
                                  className="upload-queue-folder-select"
                                  value={editingFolderId ?? ""}
                                  disabled={busy}
                                  aria-label="Assign to folder"
                                  onChange={(e) =>
                                    setEditingFolderId(
                                      e.target.value !== "" ? Number(e.target.value) : null,
                                    )
                                  }
                                >
                                  <option value="">No folder</option>
                                  {(userIsAdmin
                                    ? folders
                                    : folders.filter((f) => f.privacy === "public")
                                  ).map((f) => (
                                    <option key={f.folder_id} value={f.folder_id}>
                                      {f.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </div>
                        ) : (
                          <div className="uploaded-table-main">
                            <button
                              type="button"
                              className="list-button"
                              onClick={(event) => {
                                if (event.shiftKey || event.metaKey || event.ctrlKey) {
                                  applyTableSelectionFromEvent(event, table.dataset_id);
                                  return;
                                }
                                setSelectedTableIds([table.dataset_id]);
                                selectionAnchorIdRef.current = table.dataset_id;
                                if (activeTableId === table.dataset_id) {
                                  // Toggle off when clicking the currently selected table.
                                  setActiveTableId(null);
                                  setPreview(null);
                                  setPreviewErr(null);
                                  setPreviewBusy(false);
                                  setPreviewPage(1);
                                  setPreviewRowCount(0);
                                  setPreviewSearchQuery("");
                                  setPreviewSortColumn(null);
                                  setPreviewSortDirection("asc");
                                  return;
                                }
                                void loadPreview(table.dataset_id, 1, {
                                  sortColumn: null,
                                  sortDirection: "asc",
                                });
                              }}
                              aria-pressed={
                                activeTableId === table.dataset_id
                              }
                            >
                              <span className="uploaded-table-head">
                                <span className="uploaded-table-title-line">
                                  <span className="uploaded-table-name">
                                    {table.name}
                                  </span>
                                  {table.description?.trim() ? (
                                    <span className="small uploaded-table-description">
                                      {table.description.trim()}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="small uploaded-table-meta">
                                  ({table.row_count} rows,{" "}
                                  {table.column_count} cols)
                                </span>
                              </span>
                            </button>
                          </div>
                        )}

                        {isIndexing && (
                          <div
                            className="list-row-index"
                            title={indexStatus?.message || readyStatusLabel}
                            role="progressbar"
                            aria-label={`${table.name} index status`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={indexProgress}
                            aria-valuetext={`${indexLabel}. ${indexProgress}% complete.`}
                          >
                            <div className="list-row-index-track" aria-hidden="true">
                              <div
                                className="list-row-index-fill indexing"
                                style={{
                                  width: `${Math.max(4, indexProgress)}%`,
                                }}
                              />
                            </div>
                          </div>
                        )}

                        {(userIsAdmin || table.folder_privacy === "public") && (
                          <div
                            className="row-action-menu"
                            data-row-action-menu-root={table.dataset_id}
                          >
                            {/*
                              If multiple files are selected and this row is part of the selection,
                              only allow bulk delete from the kebab.
                            */}
                            <button
                              type="button"
                              className="icon-button row-action-menu__trigger"
                              aria-label={`Actions for ${table.name}`}
                              aria-haspopup="menu"
                              aria-expanded={rowActionMenuOpenId === table.dataset_id}
                              disabled={
                                busy || Boolean(deletingTableIds[table.dataset_id])
                              }
                              onClick={(e) => {
                                if (
                                  selectedTableIds.length > 1 &&
                                  !selectedTableIds.includes(table.dataset_id)
                                ) {
                                  setSelectedTableIds([table.dataset_id]);
                                  selectionAnchorIdRef.current = table.dataset_id;
                                }
                                const nextOpen =
                                  rowActionMenuOpenId === table.dataset_id
                                    ? null
                                    : table.dataset_id;
                                if (nextOpen === null) {
                                  setRowActionMenuOpenId(null);
                                  setRowActionMenuPos(null);
                                  return;
                                }
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setRowActionMenuOpenId(nextOpen);
                                setRowActionMenuPos({
                                  id: nextOpen,
                                  top: rect.bottom + 6,
                                  right: Math.max(8, window.innerWidth - rect.right),
                                });
                              }}
                            >
                              <svg viewBox="0 0 24 24" role="presentation">
                                <path d="M12 7.25a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm0 6.5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm0 6.5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5z" />
                              </svg>
                            </button>

                            {rowActionMenuOpenId === table.dataset_id &&
                              rowActionMenuPos?.id === table.dataset_id &&
                              createPortal(
                                <div
                                  className="row-action-menu__dropdown"
                                  role="menu"
                                  data-row-action-menu-root={table.dataset_id}
                                  style={{
                                    position: "fixed",
                                    top: rowActionMenuPos.top,
                                    right: rowActionMenuPos.right,
                                  }}
                                >
                                  {selectedTableIds.length > 1 &&
                                  selectedTableIds.includes(table.dataset_id) ? (
                                    <button
                                      type="button"
                                      className="row-action-menu__item row-action-menu__item--danger"
                                      role="menuitem"
                                      onClick={() => {
                                        setRowActionMenuOpenId(null);
                                        setRowActionMenuPos(null);
                                        setBulkDeleteConfirmIds(selectedTableIds);
                                      }}
                                    >
                                      Delete ({selectedTableIds.length})
                                    </button>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        className="row-action-menu__item"
                                        role="menuitem"
                                        onClick={() => {
                                          setRowActionMenuOpenId(null);
                                          setRowActionMenuPos(null);
                                          if (editingId === table.dataset_id) {
                                            void onRename(table.dataset_id);
                                            return;
                                          }
                                          setEditingId(table.dataset_id);
                                          setEditingName(table.name);
                                          setEditingDescription(
                                            sanitizeTableDescriptionInput(
                                              table.description || "",
                                            ),
                                          );
                                          setEditingFolderId(table.folder_id);
                                          setRenameHintId(null);
                                        }}
                                      >
                                        {editingId === table.dataset_id ? "Save" : "Edit"}
                                      </button>
                                      <button
                                        type="button"
                                        className="row-action-menu__item row-action-menu__item--danger"
                                        role="menuitem"
                                        onClick={() => {
                                          setRowActionMenuOpenId(null);
                                          setRowActionMenuPos(null);
                                          setDeleteConfirmTable(table);
                                        }}
                                      >
                                        Delete
                                      </button>
                                    </>
                                  )}
                                </div>,
                                document.body,
                              )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {hasMoreFilteredTables && (
                <div className="tables-load-more-wrap">
                  <button
                    type="button"
                    className="tables-load-more-btn"
                    onClick={() =>
                      setVisibleTableCount(
                        (current) => current + TABLES_RENDER_BATCH_SIZE,
                      )
                    }
                  >
                    Load more tables
                  </button>
                </div>
              )}
            </div>
          )}

            </div>
          </div>
        </div>

        {activeTableId !== null && (
          <div
            className="panel upload-preview"
            aria-hidden={isUploadPopupOpen}
          >
            <div className="preview-header">
              <div className="preview-header-left">
                <h3 style={{ marginBottom: 0 }}>Table Preview</h3>
                {activeTableName && (
                  <div className="preview-table-name" aria-live="polite">
                    <span className="preview-table-name-value">
                      {activeTableName}
                    </span>
                  </div>
                )}
              </div>
              <div className="preview-header-right">
                {preview && (
                  <label
                    className="tables-search-input-wrap"
                    aria-label="Search in preview"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      role="presentation"
                      className="tables-search-icon"
                      aria-hidden="true"
                    >
                      <path
                        d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
                        fill="currentColor"
                      />
                    </svg>
                    <input
                      type="text"
                      className="tables-search-input preview-search-input"
                      value={previewSearchQuery}
                      onChange={(e) => setPreviewSearchQuery(e.target.value)}
                      placeholder="Search"
                      aria-label="Search in preview"
                    />
                  </label>
                )}
                {activeTableId !== null && (
                  <Link
                    className="sort-toggle-button preview-open-link"
                    to={`/tables/${activeTableId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Edit Full Table (opens in new tab)"
                    title="Edit Full Table (new tab)"
                  >
                    <img
                      src={openIcon}
                      alt=""
                      className="preview-open-link-icon"
                      aria-hidden="true"
                    />
                    <span className="sort-toggle-text">Edit Full Table</span>
                  </Link>
                )}
              </div>
            </div>

            {previewBusy && (
              <p className="small" role="status" aria-live="polite">
                Loading preview...
              </p>
            )}
            {previewErr && (
              <p className="error" role="alert">
                {previewErr}
              </p>
            )}

            {preview && (
              <div className="table-area" ref={previewAreaRef}>
                <DataTable
                  columns={preview.columns}
                  rows={previewRows}
                  rowOffset={preview.offset}
                  rowIndices={preview.row_indices}
                  sortable
                  sortMode="server"
                  serverSortColumn={previewSortColumn}
                  serverSortDirection={previewSortDirection}
                  onSortChange={(column, direction) => {
                    if (activeTableId !== null) {
                      void loadPreview(activeTableId, 1, {
                        sortColumn: column,
                        sortDirection: direction,
                      });
                    }
                  }}
                  caption={`Preview of ${activeTableName || "the selected table"}. Showing ${valueMode} values.${hasPreviewSearch ? ` ${previewRowCount.toLocaleString()} matches.` : ""}`}
                />
              </div>
            )}

            {preview && previewRowCount > 0 && (
              <div
                className="table-view-pagination"
                aria-label="Table preview pagination"
              >
                <div className="table-view-pagination-controls">
                  <button
                    type="button"
                    className="table-view-page-btn"
                    disabled={previewSafeCurrentPage <= 1 || previewBusy}
                    onClick={() =>
                      activeTableId !== null &&
                      void loadPreview(activeTableId, 1)
                    }
                    aria-label="First page"
                    title="First page"
                  >
                    {"<<"}
                  </button>
                  <button
                    type="button"
                    className="table-view-page-btn"
                    disabled={previewSafeCurrentPage <= 1 || previewBusy}
                    onClick={() =>
                      activeTableId !== null &&
                      previewSafeCurrentPage > 1 &&
                      void loadPreview(
                        activeTableId,
                        previewSafeCurrentPage - 1,
                      )
                    }
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
                      style={{ width: `${previewPageInputWidthCh}ch` }}
                      value={previewPageInput}
                      onChange={(e) => {
                        const digitsOnly = e.target.value.replace(/[^\d]/g, "");
                        setPreviewPageInput(digitsOnly);
                      }}
                      onBlur={commitPreviewPageInput}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitPreviewPageInput();
                        else if (e.key === "Escape")
                          setPreviewPageInput(String(previewSafeCurrentPage));
                      }}
                      disabled={previewBusy}
                      aria-label="Current page number"
                      title="Enter page number"
                    />{" "}
                    of {previewTotalPages}
                  </span>
                  <button
                    type="button"
                    className="table-view-page-btn"
                    disabled={
                      previewSafeCurrentPage >= previewTotalPages || previewBusy
                    }
                    onClick={() =>
                      activeTableId !== null &&
                      previewSafeCurrentPage < previewTotalPages &&
                      void loadPreview(
                        activeTableId,
                        previewSafeCurrentPage + 1,
                      )
                    }
                    aria-label="Next page"
                    title="Next page"
                  >
                    {">"}
                  </button>
                  <button
                    type="button"
                    className="table-view-page-btn"
                    disabled={
                      previewSafeCurrentPage >= previewTotalPages || previewBusy
                    }
                    onClick={() =>
                      activeTableId !== null &&
                      void loadPreview(activeTableId, previewTotalPages)
                    }
                    aria-label="Last page"
                    title="Last page"
                  >
                    {">>"}
                  </button>
                </div>
                <span className="table-view-pagination-meta">
                  Showing rows{" "}
                  {(previewSafeCurrentPage - 1) * PREVIEW_ROWS_PER_PAGE + 1}–
                  {Math.min(
                    previewSafeCurrentPage * PREVIEW_ROWS_PER_PAGE,
                    previewRowCount,
                  )}{" "}
                  of {previewRowCount}
                </span>
              </div>
            )}

            {/*
          When no table is selected, the preview panel is hidden (activeTableId === null),
          so we don't need a "select a table" hint here.
        */}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  assignDatasetToFolder,
  listFolderDatasets,
  listTables,
  type Folder,
  type FolderDatasets,
  type TableSummary,
} from "../api";
import FolderPrivacyBadge from "./FolderPrivacyBadge";
import { trapFocus } from "../accessibility";

type Props = {
  folder: Folder | null;
  onClose: () => void;
  isAdmin: boolean;
  /** Called after any dataset assignment change so the parent can refresh. */
  onAssigned: () => void;
};

export default function FolderDetailPopup({ folder, onClose, isAdmin, onAssigned }: Props) {
  const [folderData, setFolderData] = useState<FolderDatasets | null>(null);
  const [unassigned, setUnassigned] = useState<TableSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [addingId, setAddingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isOpen = folder !== null;

  // Queriers can write to public folders.
  const canWrite = isAdmin || folder?.privacy === "public";

  // Load data when popup opens
  useEffect(() => {
    if (!folder) {
      setFolderData(null);
      setUnassigned([]);
      setSearch("");
      return;
    }

    const fetchAll = isAdmin || folder.privacy === "public";
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      listFolderDatasets(folder.folder_id),
      fetchAll ? listTables() : Promise.resolve([] as TableSummary[]),
    ])
      .then(([fd, all]) => {
        if (cancelled) return;
        setFolderData(fd);
        if (fetchAll) {
          setUnassigned(all.filter((t) => t.folder_id === null));
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load folder");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [folder, isAdmin]);

  // Focus close button when popup opens
  useEffect(() => {
    if (isOpen) {
      const rafId = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
      return () => window.cancelAnimationFrame(rafId);
    }
  }, [isOpen]);

  // Trap focus + Escape
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      trapFocus(e, dialogRef.current);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  async function handleRemove(datasetId: number) {
    if (!folder) return;
    setRemovingId(datasetId);
    setError(null);
    try {
      await assignDatasetToFolder(datasetId, null);
      setFolderData((prev) =>
        prev ? { ...prev, datasets: prev.datasets.filter((d) => d.dataset_id !== datasetId) } : prev,
      );
      // Move back to unassigned list
      const removed = folderData?.datasets.find((d) => d.dataset_id === datasetId);
      if (removed) {
        setUnassigned((prev) => [...prev, removed as unknown as TableSummary].sort((a, b) => a.name.localeCompare(b.name)));
      }
      onAssigned();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove dataset");
    } finally {
      setRemovingId(null);
    }
  }

  async function handleAdd(dataset: TableSummary) {
    if (!folder) return;
    setAddingId(dataset.dataset_id);
    setError(null);
    try {
      await assignDatasetToFolder(dataset.dataset_id, folder.folder_id);
      // Move from unassigned into folderData.datasets
      setUnassigned((prev) => prev.filter((d) => d.dataset_id !== dataset.dataset_id));
      setFolderData((prev) =>
        prev
          ? {
              ...prev,
              datasets: [
                ...prev.datasets,
                {
                  dataset_id: dataset.dataset_id,
                  name: dataset.name,
                  description: dataset.description,
                  row_count: dataset.row_count,
                  column_count: dataset.column_count,
                  created_at: dataset.created_at,
                },
              ].sort((a, b) => a.name.localeCompare(b.name)),
            }
          : prev,
      );
      onAssigned();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add dataset");
    } finally {
      setAddingId(null);
    }
  }

  if (!isOpen) return null;

  const normalizedSearch = search.trim().toLowerCase();
  const filteredUnassigned = normalizedSearch
    ? unassigned.filter((d) => d.name.toLowerCase().includes(normalizedSearch))
    : unassigned;

  return (
    <div
      className="confirm-modal-overlay folder-detail-overlay"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="confirm-modal folder-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Folder: ${folder.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="folder-detail-header">
          <span className="folder-detail-title-row">
            <svg className="folder-detail-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
            <span className="folder-detail-name">{folder.name}</span>
            <FolderPrivacyBadge privacy={folder.privacy} />
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button folder-detail-close"
            aria-label="Close"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {error && <p className="folder-detail-error" role="alert">{error}</p>}

        {loading ? (
          <p className="folder-detail-muted">Loading…</p>
        ) : (
          <>
            {/* Datasets in this folder */}
            <section className="folder-detail-section">
              <h4 className="folder-detail-section-title">
                Datasets in this folder
                <span className="folder-detail-count">{folderData?.datasets.length ?? 0}</span>
              </h4>
              {folderData && folderData.datasets.length === 0 ? (
                <p className="folder-detail-muted">No datasets yet.</p>
              ) : (
                <ul className="folder-detail-list" role="list">
                  {folderData?.datasets.map((d) => (
                    <li key={d.dataset_id} className="folder-detail-item">
                      <span className="folder-detail-item-name">{d.name}</span>
                      <span className="folder-detail-item-meta">
                        {d.row_count} rows · {d.column_count} cols
                      </span>
                      {canWrite && (
                        <button
                          type="button"
                          className="surface-btn folder-detail-remove-btn"
                          disabled={removingId === d.dataset_id}
                          onClick={() => void handleRemove(d.dataset_id)}
                          aria-label={`Remove ${d.name} from folder`}
                          title="Remove from folder"
                        >
                          {removingId === d.dataset_id ? "…" : "Remove"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Add existing datasets (admin, or member in a public folder) */}
            {canWrite && (
              <section className="folder-detail-section">
                <h4 className="folder-detail-section-title">
                  Add existing datasets
                  {unassigned.length > 0 && (
                    <span className="folder-detail-count">{unassigned.length} unassigned</span>
                  )}
                </h4>
                {unassigned.length === 0 ? (
                  <p className="folder-detail-muted">No unassigned datasets available.</p>
                ) : (
                  <>
                    <label className="tables-search-input-wrap folder-detail-search">
                      <svg viewBox="0 0 24 24" role="presentation" className="tables-search-icon" aria-hidden="true">
                        <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="currentColor" />
                      </svg>
                      <input
                        type="text"
                        className="tables-search-input"
                        placeholder="Filter datasets"
                        value={search}
                        aria-label="Filter unassigned datasets"
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                    {filteredUnassigned.length === 0 ? (
                      <p className="folder-detail-muted">No datasets match.</p>
                    ) : (
                      <ul className="folder-detail-list folder-detail-list--add" role="list">
                        {filteredUnassigned.map((d) => (
                          <li key={d.dataset_id} className="folder-detail-item">
                            <span className="folder-detail-item-name">{d.name}</span>
                            <span className="folder-detail-item-meta">
                              {d.row_count} rows · {d.column_count} cols
                            </span>
                            <button
                              type="button"
                              className="login-btn folder-detail-add-btn"
                              disabled={addingId === d.dataset_id}
                              onClick={() => void handleAdd(d)}
                              aria-label={`Add ${d.name} to folder`}
                            >
                              {addingId === d.dataset_id ? "Adding…" : "Add"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

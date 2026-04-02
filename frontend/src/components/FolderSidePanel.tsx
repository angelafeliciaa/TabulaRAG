import { useEffect, useRef, useState } from "react";
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
  type Folder,
  type FolderPrivacy,
} from "../api";
import FolderPrivacyBadge from "./FolderPrivacyBadge";

type Props = {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  /** Called when the user clicks a folder name — parent opens the detail popup. */
  onSelectFolder: (folder: Folder) => void;
};

type EditState = { folderId: number; name: string };

export default function FolderSidePanel({ open, onClose, isAdmin, onSelectFolder }: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // inline rename
  const [editing, setEditing] = useState<EditState | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // delete
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // privacy change busy
  const [privacyBusyId, setPrivacyBusyId] = useState<number | null>(null);

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrivacy, setNewPrivacy] = useState<FolderPrivacy>("protected");
  const [createBusy, setCreateBusy] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);

  // load folders whenever panel opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFolders()
      .then((list) => { if (!cancelled) setFolders(list); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load folders"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // focus rename input when editing starts
  useEffect(() => {
    if (editing) renameInputRef.current?.focus();
  }, [editing]);

  // focus create input when form appears
  useEffect(() => {
    if (showCreate) createInputRef.current?.focus();
  }, [showCreate]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handlePrivacyChange(folder: Folder, privacy: FolderPrivacy) {
    setPrivacyBusyId(folder.folder_id);
    setError(null);
    try {
      const updated = await updateFolder(folder.folder_id, { privacy });
      setFolders((prev) => prev.map((f) => (f.folder_id === updated.folder_id ? updated : f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update folder");
    } finally {
      setPrivacyBusyId(null);
    }
  }

  function startRename(folder: Folder) {
    setEditing({ folderId: folder.folder_id, name: folder.name });
  }

  async function commitRename() {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (!trimmed) { setEditing(null); return; }
    setRenameBusy(true);
    setError(null);
    try {
      const updated = await updateFolder(editing.folderId, { name: trimmed });
      setFolders((prev) => prev.map((f) => (f.folder_id === updated.folder_id ? updated : f)));
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename folder");
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleDelete(folder: Folder) {
    if (!window.confirm(`Delete folder "${folder.name}"? Datasets inside will become unassigned.`)) return;
    setDeletingId(folder.folder_id);
    setError(null);
    try {
      await deleteFolder(folder.folder_id);
      setFolders((prev) => prev.filter((f) => f.folder_id !== folder.folder_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete folder");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreateBusy(true);
    setError(null);
    try {
      const created = await createFolder(trimmed, newPrivacy);
      setFolders((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName("");
      setNewPrivacy("protected");
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <>
      {/* backdrop */}
      <div
        className={`folder-panel-backdrop${open ? " folder-panel-backdrop--open" : ""}`}
        aria-hidden="true"
        onClick={onClose}
      />

      {/* panel */}
      <aside
        className={`folder-panel${open ? " folder-panel--open" : ""}`}
        aria-label="Folders"
        role="complementary"
      >
        <div className="folder-panel__header">
          <h2 className="folder-panel__title">Folders</h2>
          <button
            type="button"
            className="icon-button folder-panel__close"
            aria-label="Close folders panel"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {error && <p className="folder-panel__error" role="alert">{error}</p>}

        <div className="folder-panel__body">
          {loading ? (
            <p className="folder-panel__muted">Loading…</p>
          ) : folders.length === 0 && !showCreate ? (
            <p className="folder-panel__muted">No folders yet.</p>
          ) : (
            <ul className="folder-panel__list" role="list">
              {folders.map((folder) => {
                const isDeleting = deletingId === folder.folder_id;
                const isPrivacyBusy = privacyBusyId === folder.folder_id;
                const isEditing = editing?.folderId === folder.folder_id;

                return (
                  <li key={folder.folder_id} className="folder-panel__item">
                    <div className="folder-panel__item-main">
                      {isEditing ? (
                        <input
                          ref={renameInputRef}
                          className="input folder-panel__rename-input"
                          value={editing.name}
                          disabled={renameBusy}
                          aria-label="Folder name"
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename();
                            if (e.key === "Escape") setEditing(null);
                          }}
                          onBlur={() => void commitRename()}
                        />
                      ) : (
                        <button
                          type="button"
                          className="folder-panel__folder-name"
                          onClick={() => onSelectFolder(folder)}
                          title="View datasets in this folder"
                        >
                          <svg className="folder-panel__folder-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                          </svg>
                          <span>{folder.name}</span>
                          <span className="folder-panel__dataset-count">{folder.dataset_count}</span>
                        </button>
                      )}
                    </div>

                    <div className="folder-panel__item-actions">
                      {isAdmin ? (
                        <FolderPrivacyBadge
                          privacy={folder.privacy}
                          disabled={isPrivacyBusy || isDeleting}
                          onChange={(p) => void handlePrivacyChange(folder, p)}
                        />
                      ) : (
                        <FolderPrivacyBadge privacy={folder.privacy} />
                      )}

                      {isAdmin && !isEditing && (
                        <>
                          <button
                            type="button"
                            className="icon-button folder-panel__action-btn"
                            aria-label={`Rename "${folder.name}"`}
                            title="Rename"
                            disabled={isDeleting || isPrivacyBusy}
                            onClick={() => startRename(folder)}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="icon-button folder-panel__action-btn folder-panel__action-btn--danger"
                            aria-label={`Delete "${folder.name}"`}
                            title="Delete folder"
                            disabled={isDeleting || isPrivacyBusy}
                            onClick={() => void handleDelete(folder)}
                          >
                            {isDeleting ? "…" : (
                              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                              </svg>
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* create folder form */}
          {isAdmin && (
            showCreate ? (
              <form className="folder-panel__create-form" onSubmit={(e) => void handleCreate(e)}>
                <input
                  ref={createInputRef}
                  className="input folder-panel__create-input"
                  placeholder="Folder name"
                  value={newName}
                  disabled={createBusy}
                  aria-label="New folder name"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { setShowCreate(false); setNewName(""); } }}
                />
                <div className="folder-panel__create-row">
                  <FolderPrivacyBadge
                    privacy={newPrivacy}
                    onChange={setNewPrivacy}
                    disabled={createBusy}
                  />
                  <button
                    type="submit"
                    className="login-btn folder-panel__create-submit"
                    disabled={createBusy || !newName.trim()}
                  >
                    {createBusy ? "Creating…" : "Create"}
                  </button>
                  <button
                    type="button"
                    className="surface-btn"
                    disabled={createBusy}
                    onClick={() => { setShowCreate(false); setNewName(""); }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="folder-panel__new-btn"
                onClick={() => setShowCreate(true)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                </svg>
                New folder
              </button>
            )
          )}
        </div>
      </aside>
    </>
  );
}

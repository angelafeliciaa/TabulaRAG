import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createFolder,
  deleteFolder,
  grantGroupFolderAccess,
  isOwner,
  listFolderGroups,
  listFolders,
  listGroups,
  reorderFolders,
  revokeGroupFolderAccess,
  updateFolder,
  type Folder,
  type FolderGroupGrant,
  type FolderPrivacy,
  type UserGroup,
} from "../api";
import FolderPrivacyBadge from "./FolderPrivacyBadge";

type Props = {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  /** Called when the user clicks a folder name — parent opens the detail popup. */
  onSelectFolder: (folder: Folder) => void;
  /** Render as an overlay drawer (default) or an in-panel sidebar. */
  variant?: "overlay" | "embedded";
  /** Optional current selection (used for embedded folder filtering). */
  selectedFolderId?: number | null;
  /** Optional collapse/expand toggle (used by embedded pane header). */
  onTogglePane?: () => void;
  togglePaneLabel?: string;
  /** Trigger a refetch when this value changes (e.g., after upload/delete). */
  refreshKey?: number;
};

type EditState = { folderId: number; name: string };
type GroupsState = { grants: FolderGroupGrant[]; loading: boolean; error: string | null };

function moveFolderInList(
  list: Folder[],
  draggedId: number,
  targetId: number,
): Folder[] {
  if (draggedId === targetId) return list;
  const from = list.findIndex((f) => f.folder_id === draggedId);
  const to = list.findIndex((f) => f.folder_id === targetId);
  if (from < 0 || to < 0) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export default function FolderSidePanel({
  open,
  onClose,
  isAdmin,
  onSelectFolder,
  variant = "overlay",
  selectedFolderId = null,
  onTogglePane,
  togglePaneLabel = "Collapse folders pane",
  refreshKey = 0,
}: Props) {
  const isEmbedded = variant === "embedded";
  const isOverlay = !isEmbedded;
  const isOpen = isEmbedded ? true : open;

  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // inline rename
  const [editing, setEditing] = useState<EditState | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // delete
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirmFolder, setDeleteConfirmFolder] = useState<Folder | null>(null);

  // per-folder action menu
  const [folderActionMenuOpenId, setFolderActionMenuOpenId] = useState<number | null>(null);
  const [folderActionMenuPos, setFolderActionMenuPos] = useState<
    { id: number; top: number; right: number } | null
  >(null);

  // privacy change busy (via privacy icon dropdown)
  const [privacyBusyId, setPrivacyBusyId] = useState<number | null>(null);

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrivacy, setNewPrivacy] = useState<FolderPrivacy>("protected");
  const [createBusy, setCreateBusy] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createFormRef = useRef<HTMLFormElement | null>(null);

  // group restriction picker (admin, protected folders only)
  const [allGroups, setAllGroups] = useState<UserGroup[]>([]);
  const [expandedGroupsFolderId, setExpandedGroupsFolderId] = useState<number | null>(null);
  const [folderGroupsMap, setFolderGroupsMap] = useState<Map<number, GroupsState>>(new Map());
  const [addGroupId, setAddGroupId] = useState<number | "">("");
  const [addGroupBusy, setAddGroupBusy] = useState(false);
  const [addGroupError, setAddGroupError] = useState<string | null>(null);
  const [revokingGroupId, setRevokingGroupId] = useState<number | null>(null);
  const [draggingFolderId, setDraggingFolderId] = useState<number | null>(null);
  /** When true, drag handles appear and rows can be reordered (any member; not admin-only). */
  const [folderReorderMode, setFolderReorderMode] = useState(false);

  // load folders (and groups for admin) whenever panel opens / refreshes
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpandedGroupsFolderId(null);
    setFolderGroupsMap(new Map());

    const fetches: [Promise<Folder[]>, Promise<UserGroup[]>] = [
      listFolders(),
      isAdmin ? listGroups() : Promise.resolve([]),
    ];

    Promise.all(fetches)
      .then(([folderList, groupList]) => {
        if (cancelled) return;
        setFolders(folderList);
        setAllGroups(groupList);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load folders"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, isAdmin, refreshKey]);

  useEffect(() => {
    if (!isOpen) {
      setFolderReorderMode(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (folders.length <= 1) {
      setFolderReorderMode(false);
    }
  }, [folders.length]);

  /** Click outside the folder panel (or its portaled menus) ends reorder mode. */
  useEffect(() => {
    if (!folderReorderMode) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".folder-panel")) return;
      if (target.closest("[data-folder-panel-popover]")) return;
      if (target.closest(".privacy-badge-menu") || target.closest(".privacy-badge-wrap")) {
        return;
      }
      setFolderReorderMode(false);
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [folderReorderMode]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (folderReorderMode) {
        setFolderReorderMode(false);
        return;
      }
      if (folderActionMenuOpenId !== null) {
        setFolderActionMenuOpenId(null);
        setFolderActionMenuPos(null);
        return;
      }
      if (isOverlay && isOpen) onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [folderReorderMode, folderActionMenuOpenId, isOverlay, isOpen, onClose]);

  // focus rename input when editing starts
  useEffect(() => {
    if (editing) renameInputRef.current?.focus();
  }, [editing]);

  // focus create input when form appears
  useEffect(() => {
    if (showCreate) createInputRef.current?.focus();
  }, [showCreate]);

  // click-away should cancel create (unless busy)
  useEffect(() => {
    if (!showCreate) return;

    function cancelCreate() {
      setShowCreate(false);
      setNewName("");
    }

    function commitCreateIfNeeded() {
      const trimmed = newName.trim();
      if (!trimmed) {
        cancelCreate();
        return;
      }
      if (createBusy) {
        return;
      }
      void handleCreate(trimmed);
    }

    function onPointerDown(event: PointerEvent) {
      if (createBusy) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (createFormRef.current?.contains(target)) return;
      // Privacy dropdown is rendered in a portal; interacting with it should not cancel create.
      if (target.closest(".privacy-badge-menu")) return;
      if (target.closest(".privacy-badge-wrap")) return;
      commitCreateIfNeeded();
    }

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [createBusy, showCreate, newName]);

  useEffect(() => {
    if (folderActionMenuOpenId === null) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(`[data-folder-action-menu-root="${folderActionMenuOpenId}"]`)) {
        return;
      }
      setFolderActionMenuOpenId(null);
    }

    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [folderActionMenuOpenId]);

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

  function toggleGroupsPicker(folderId: number) {
    if (expandedGroupsFolderId === folderId) {
      setExpandedGroupsFolderId(null);
      return;
    }
    setExpandedGroupsFolderId(folderId);
    setAddGroupId("");
    setAddGroupError(null);
    if (!folderGroupsMap.has(folderId)) {
      setFolderGroupsMap((prev) => {
        const next = new Map(prev);
        next.set(folderId, { grants: [], loading: true, error: null });
        return next;
      });
      listFolderGroups(folderId)
        .then((grants) => {
          setFolderGroupsMap((prev) => {
            const next = new Map(prev);
            next.set(folderId, { grants, loading: false, error: null });
            return next;
          });
        })
        .catch((err) => {
          setFolderGroupsMap((prev) => {
            const next = new Map(prev);
            next.set(folderId, { grants: [], loading: false, error: err instanceof Error ? err.message : "Failed to load groups" });
            return next;
          });
        });
    }
  }

  async function handleGrantGroup(folderId: number) {
    if (addGroupId === "") return;
    const gid = Number(addGroupId);
    const groupName = allGroups.find((g) => g.group_id === gid)?.name ?? "";
    setAddGroupBusy(true);
    setAddGroupError(null);
    try {
      const access = await grantGroupFolderAccess(gid, folderId);
      const grant: FolderGroupGrant = {
        access_id: access.access_id,
        group_id: gid,
        group_name: groupName,
        granted_at: access.granted_at,
      };
      setFolderGroupsMap((prev) => {
        const next = new Map(prev);
        const state = next.get(folderId);
        if (state) {
          const already = state.grants.some((g) => g.group_id === gid);
          next.set(folderId, {
            ...state,
            grants: already ? state.grants : [...state.grants, grant]
              .sort((a, b) => a.group_name.localeCompare(b.group_name)),
          });
        }
        return next;
      });
      setAddGroupId("");
    } catch (err) {
      setAddGroupError(err instanceof Error ? err.message : "Failed to grant access");
    } finally {
      setAddGroupBusy(false);
    }
  }

  async function handleRevokeGroup(folderId: number, groupId: number) {
    setRevokingGroupId(groupId);
    try {
      await revokeGroupFolderAccess(groupId, folderId);
      setFolderGroupsMap((prev) => {
        const next = new Map(prev);
        const state = next.get(folderId);
        if (state) {
          next.set(folderId, { ...state, grants: state.grants.filter((g) => g.group_id !== groupId) });
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke access");
    } finally {
      setRevokingGroupId(null);
    }
  }

  async function handleCreate(trimmedName: string) {
    const trimmed = trimmedName.trim();
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
      {deleteConfirmFolder && (
        <div
          className="confirm-modal-overlay"
          onClick={() => {
            if (deletingId !== null) return;
            setDeleteConfirmFolder(null);
          }}
        >
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-delete-confirm-title"
            aria-describedby="folder-delete-confirm-description"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="folder-delete-confirm-title">Delete folder permanently?</h3>
            <p id="folder-delete-confirm-description" className="small">
              This will permanently delete{" "}
              <span className="confirm-modal-table-name">
                {deleteConfirmFolder.name}
              </span>
              . Any files inside this folder will also be permanently deleted.
            </p>
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="surface-btn"
                onClick={() => setDeleteConfirmFolder(null)}
                disabled={deletingId !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete-button"
                onClick={() => {
                  const folder = deleteConfirmFolder;
                  setDeleteConfirmFolder(null);
                  void handleDelete(folder);
                }}
                disabled={deletingId !== null}
              >
                {deletingId === deleteConfirmFolder.folder_id ? "Deleting..." : "Permanently delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* backdrop (overlay only) */}
      {isOverlay && (
        <div
          className={`folder-panel-backdrop${isOpen ? " folder-panel-backdrop--open" : ""}`}
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* panel */}
      <aside
        className={[
          "folder-panel",
          isOpen ? "folder-panel--open" : "",
          isEmbedded ? "folder-panel--embedded" : "",
        ].filter(Boolean).join(" ")}
        aria-label="Folders"
        role="complementary"
      >
        <div className="folder-panel__header">
          <div className="folder-panel__header-start">
            <h2 className="folder-panel__title">Folders</h2>
          </div>
          {isEmbedded && onTogglePane && (
            <button
              type="button"
              className="icon-button folder-panel__collapse"
              aria-label={togglePaneLabel}
              title={togglePaneLabel}
              onClick={onTogglePane}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                {/* Sidebar / panel icon */}
                <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm6 0H6v14h4V5zm2 0v14h6V5h-6z" />
              </svg>
            </button>
          )}
          {isOverlay && (
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
          )}
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

                const isGroupsExpanded = expandedGroupsFolderId === folder.folder_id;
                const groupsState = folderGroupsMap.get(folder.folder_id);
                const grantedGroupIds = new Set(groupsState?.grants.map((g) => g.group_id) ?? []);
                const addableGroups = allGroups.filter((g) => !grantedGroupIds.has(g.group_id));
                const reorderingActive = folderReorderMode && !isEditing;

                return (
                  <li
                    key={folder.folder_id}
                    className={`folder-panel__item${draggingFolderId === folder.folder_id ? " folder-panel__item--dragging" : ""}`}
                    onDragOver={
                      reorderingActive
                        ? (e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                          }
                        : undefined
                    }
                    onDrop={
                      reorderingActive
                        ? (e) => {
                            e.preventDefault();
                            const raw = e.dataTransfer.getData("text/plain");
                            const draggedId = parseInt(raw, 10);
                            if (!Number.isFinite(draggedId)) return;
                            setFolders((prev) => {
                              const next = moveFolderInList(prev, draggedId, folder.folder_id);
                              void reorderFolders(next.map((f) => f.folder_id)).catch(() => {
                                void listFolders().then(setFolders);
                              });
                              return next;
                            });
                            setDraggingFolderId(null);
                          }
                        : undefined
                    }
                  >
                    <div className="folder-panel__item-main">
                      {reorderingActive && (
                        <div
                          className="folder-panel__drag-handle"
                          draggable
                          onDragStart={(e) => {
                            setDraggingFolderId(folder.folder_id);
                            e.dataTransfer.setData("text/plain", String(folder.folder_id));
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => setDraggingFolderId(null)}
                          aria-label={`Drag to reorder ${folder.name}`}
                          title="Drag to reorder"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width={14} height={14}>
                            <circle cx="9" cy="7" r="1.5" fill="currentColor" />
                            <circle cx="15" cy="7" r="1.5" fill="currentColor" />
                            <circle cx="9" cy="12" r="1.5" fill="currentColor" />
                            <circle cx="15" cy="12" r="1.5" fill="currentColor" />
                            <circle cx="9" cy="17" r="1.5" fill="currentColor" />
                            <circle cx="15" cy="17" r="1.5" fill="currentColor" />
                          </svg>
                        </div>
                      )}
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
                          aria-current={selectedFolderId === folder.folder_id ? "true" : undefined}
                        >
                          <svg className="folder-panel__folder-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                          </svg>
                          <span className="folder-panel__folder-label">{folder.name}</span>
                          <span className="folder-panel__dataset-count">{folder.dataset_count}</span>
                        </button>
                      )}
                    </div>

                    <div className="folder-panel__item-actions">
                      {!isEditing && (isAdmin || folders.length > 1) && (
                        <div
                          className="folder-action-menu"
                          data-folder-action-menu-root={folder.folder_id}
                        >
                          <button
                            type="button"
                            className={`icon-button folder-action-menu__trigger${folderReorderMode && folders.length > 1 ? " folder-action-menu__trigger--reorder-active" : ""}`}
                            aria-label={`Folder actions for "${folder.name}"`}
                            aria-haspopup="menu"
                            aria-expanded={folderActionMenuOpenId === folder.folder_id}
                            disabled={isDeleting}
                            onClick={(e) => {
                              e.stopPropagation();
                              const nextOpen =
                                folderActionMenuOpenId === folder.folder_id
                                  ? null
                                  : folder.folder_id;
                              if (nextOpen === null) {
                                setFolderActionMenuOpenId(null);
                                setFolderActionMenuPos(null);
                                return;
                              }
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setFolderActionMenuOpenId(nextOpen);
                              setFolderActionMenuPos({
                                id: nextOpen,
                                top: rect.bottom + 6,
                                right: Math.max(8, window.innerWidth - rect.right),
                              });
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                              <path d="M12 7.25a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm0 6.5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm0 6.5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5z" />
                            </svg>
                          </button>

                          {folderActionMenuOpenId === folder.folder_id &&
                            folderActionMenuPos?.id === folder.folder_id &&
                            createPortal(
                              <div
                                className="folder-action-menu__dropdown"
                                role="menu"
                                data-folder-panel-popover
                                data-folder-action-menu-root={folder.folder_id}
                                style={{
                                  position: "fixed",
                                  top: folderActionMenuPos.top,
                                  right: folderActionMenuPos.right,
                                }}
                              >
                                {folders.length > 1 && (
                                  <button
                                    type="button"
                                    className="folder-action-menu__item"
                                    role="menuitem"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      setFolderReorderMode((v) => !v);
                                      setFolderActionMenuOpenId(null);
                                      setFolderActionMenuPos(null);
                                    }}
                                  >
                                    {folderReorderMode ? "Done reordering" : "Reorder"}
                                  </button>
                                )}
                                {isAdmin && isOwner() && folder.privacy === "protected" && (
                                  <button
                                    type="button"
                                    className="folder-action-menu__item"
                                    role="menuitem"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      setFolderActionMenuOpenId(null);
                                      setFolderActionMenuPos(null);
                                      toggleGroupsPicker(folder.folder_id);
                                    }}
                                  >
                                    {isGroupsExpanded ? "Hide group restrictions" : "Group restrictions"}
                                  </button>
                                )}
                                {isAdmin && (
                                  <button
                                    type="button"
                                    className="folder-action-menu__item"
                                    role="menuitem"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      setFolderActionMenuOpenId(null);
                                      setFolderActionMenuPos(null);
                                      startRename(folder);
                                    }}
                                  >
                                    Rename
                                  </button>
                                )}
                                {isAdmin && (
                                  <button
                                    type="button"
                                    className="folder-action-menu__item folder-action-menu__item--danger"
                                    role="menuitem"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      setFolderActionMenuOpenId(null);
                                      setFolderActionMenuPos(null);
                                      setDeleteConfirmFolder(folder);
                                    }}
                                  >
                                    Delete
                                  </button>
                                )}
                              </div>,
                              document.body,
                            )}
                        </div>
                      )}

                      <FolderPrivacyBadge
                        privacy={folder.privacy}
                        disabled={isDeleting || isPrivacyBusy}
                        onChange={
                          isAdmin
                            ? (p) => void handlePrivacyChange(folder, p)
                            : undefined
                        }
                      />
                    </div>

                    {/* Group restrictions inline panel */}
                    {isOwner() && isGroupsExpanded && (
                      <div className="folder-panel__groups-panel">
                        <p className="folder-panel__groups-label">Group restrictions</p>
                        {groupsState?.loading ? (
                          <p className="folder-panel__groups-muted">Loading…</p>
                        ) : groupsState?.error ? (
                          <p className="folder-panel__groups-muted folder-panel__groups-error">{groupsState.error}</p>
                        ) : (
                          <>
                            {groupsState?.grants.length === 0 ? (
                              <p className="folder-panel__groups-muted">
                                No restrictions. All members can see this folder.
                              </p>
                            ) : (
                              <ul className="folder-panel__groups-list" role="list">
                                {groupsState?.grants.map((grant) => (
                                  <li key={grant.group_id} className="folder-panel__groups-row">
                                    <span className="folder-panel__groups-name">{grant.group_name}</span>
                                    <button
                                      type="button"
                                      className="surface-btn folder-panel__groups-revoke"
                                      disabled={revokingGroupId === grant.group_id}
                                      onClick={() => void handleRevokeGroup(folder.folder_id, grant.group_id)}
                                    >
                                      {revokingGroupId === grant.group_id ? "…" : "Revoke"}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {addableGroups.length > 0 && (
                              <div className="folder-panel__groups-add-row">
                                <select
                                  className="input folder-panel__groups-select"
                                  value={addGroupId}
                                  onChange={(e) => setAddGroupId(e.target.value === "" ? "" : Number(e.target.value))}
                                  aria-label="Select group to grant access"
                                >
                                  <option value="">Add a group…</option>
                                  {addableGroups.map((g) => (
                                    <option key={g.group_id} value={g.group_id}>{g.name}</option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="login-btn folder-panel__groups-grant-btn"
                                  disabled={addGroupId === "" || addGroupBusy}
                                  onClick={() => void handleGrantGroup(folder.folder_id)}
                                >
                                  {addGroupBusy ? "…" : "Grant"}
                                </button>
                              </div>
                            )}
                            {addGroupError && (
                              <p className="folder-panel__groups-muted folder-panel__groups-error">{addGroupError}</p>
                            )}
                            {allGroups.length === 0 && (
                              <p className="folder-panel__groups-muted">
                                No groups exist yet. Create groups in Settings, then open Groups.
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* create folder form */}
          {isAdmin && (
            showCreate ? (
              <form
                ref={createFormRef}
                className="folder-panel__create-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCreate(newName);
                }}
              >
                <div className="folder-panel__create-input-wrap">
                  <input
                    ref={createInputRef}
                    className="input folder-panel__create-input"
                    placeholder="Folder name"
                    value={newName}
                    disabled={createBusy}
                    aria-label="New folder name"
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setShowCreate(false);
                        setNewName("");
                      }
                    }}
                    onBlur={() => {
                      // Clicking the privacy badge should not commit; pointerdown handler already guards it.
                      const trimmed = newName.trim();
                      if (!trimmed) return;
                      if (createBusy) return;
                      void handleCreate(trimmed);
                    }}
                  />
                  <div className="folder-panel__create-privacy">
                    <FolderPrivacyBadge
                      privacy={newPrivacy}
                      onChange={setNewPrivacy}
                      disabled={createBusy}
                    />
                  </div>
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

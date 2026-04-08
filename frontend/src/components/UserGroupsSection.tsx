import { useEffect, useState } from "react";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  grantGroupFolderAccess,
  listFolders,
  listGroupFolderAccesses,
  listGroupMembers,
  listGroups,
  listMembers,
  removeGroupMember,
  revokeGroupFolderAccess,
  updateGroup,
  type Folder,
  type GroupFolderAccess,
  type GroupMember,
  type Member,
  type UserGroup,
} from "../api";

type GroupDetail = {
  members: GroupMember[];
  folderAccesses: GroupFolderAccess[];
  loading: boolean;
  error: string | null;
};

export default function UserGroupsSection() {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New group form
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Expanded group + its detail data
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [details, setDetails] = useState<Map<number, GroupDetail>>(new Map());

  // Rename state
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  // Delete state
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Workspace members + protected folders (loaded once on mount)
  const [wsMembers, setWsMembers] = useState<Member[]>([]);
  const [protectedFolders, setProtectedFolders] = useState<Folder[]>([]);

  // Add-member / add-folder per expanded group
  const [addMemberUserId, setAddMemberUserId] = useState<number | "">("");
  const [addFolderId, setAddFolderId] = useState<number | "">("");
  const [addMemberBusy, setAddMemberBusy] = useState(false);
  const [addFolderBusy, setAddFolderBusy] = useState(false);
  const [addMemberError, setAddMemberError] = useState<string | null>(null);
  const [addFolderError, setAddFolderError] = useState<string | null>(null);

  // Remove in-progress tracking
  const [removingMemberId, setRemovingMemberId] = useState<number | null>(null);
  const [revokingFolderId, setRevokingFolderId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([listGroups(), listMembers(), listFolders()])
      .then(([gs, ms, fs]) => {
        if (cancelled) return;
        setGroups(gs);
        setWsMembers(ms);
        setProtectedFolders(fs.filter((f) => f.privacy === "protected"));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load groups");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  function loadGroupDetail(groupId: number) {
    setDetails((prev) => {
      const next = new Map(prev);
      next.set(groupId, { members: [], folderAccesses: [], loading: true, error: null });
      return next;
    });

    Promise.all([listGroupMembers(groupId), listGroupFolderAccesses(groupId)])
      .then(([members, folderAccesses]) => {
        setDetails((prev) => {
          const next = new Map(prev);
          next.set(groupId, { members, folderAccesses, loading: false, error: null });
          return next;
        });
      })
      .catch((err) => {
        setDetails((prev) => {
          const next = new Map(prev);
          next.set(groupId, {
            members: [],
            folderAccesses: [],
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load group details",
          });
          return next;
        });
      });
  }

  function handleToggleExpand(groupId: number) {
    if (expandedId === groupId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(groupId);
    setAddMemberUserId("");
    setAddFolderId("");
    setAddMemberError(null);
    setAddFolderError(null);
    if (!details.has(groupId)) {
      loadGroupDetail(groupId);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createGroup(name);
      setGroups((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create group");
    } finally {
      setCreating(false);
    }
  }

  function startRename(group: UserGroup) {
    setRenamingId(group.group_id);
    setRenameDraft(group.name);
  }

  async function handleRename(groupId: number) {
    const name = renameDraft.trim();
    const original = groups.find((g) => g.group_id === groupId)?.name ?? "";
    if (!name || name === original) { setRenamingId(null); return; }
    setRenameBusy(true);
    try {
      const updated = await updateGroup(groupId, name);
      setGroups((prev) =>
        prev.map((g) => g.group_id === groupId ? { ...g, name: updated.name } : g)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setRenamingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename group");
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleDelete(groupId: number) {
    if (!window.confirm("Delete this group? Members will lose folder access granted via this group.")) return;
    setDeletingId(groupId);
    try {
      await deleteGroup(groupId);
      setGroups((prev) => prev.filter((g) => g.group_id !== groupId));
      if (expandedId === groupId) setExpandedId(null);
      setDetails((prev) => { const next = new Map(prev); next.delete(groupId); return next; });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete group");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleAddMember(groupId: number) {
    if (addMemberUserId === "") return;
    setAddMemberBusy(true);
    setAddMemberError(null);
    try {
      const member = await addGroupMember(groupId, Number(addMemberUserId));
      setDetails((prev) => {
        const next = new Map(prev);
        const d = next.get(groupId);
        if (d) {
          const already = d.members.some((m) => m.user_id === member.user_id);
          next.set(groupId, {
            ...d,
            members: already ? d.members : [...d.members, member].sort((a, b) => a.login.localeCompare(b.login)),
          });
        }
        return next;
      });
      setGroups((prev) =>
        prev.map((g) => g.group_id === groupId ? { ...g, member_count: g.member_count + 1 } : g),
      );
      setAddMemberUserId("");
    } catch (err) {
      setAddMemberError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAddMemberBusy(false);
    }
  }

  async function handleRemoveMember(groupId: number, userId: number) {
    setRemovingMemberId(userId);
    try {
      await removeGroupMember(groupId, userId);
      setDetails((prev) => {
        const next = new Map(prev);
        const d = next.get(groupId);
        if (d) next.set(groupId, { ...d, members: d.members.filter((m) => m.user_id !== userId) });
        return next;
      });
      setGroups((prev) =>
        prev.map((g) => g.group_id === groupId ? { ...g, member_count: Math.max(0, g.member_count - 1) } : g),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    } finally {
      setRemovingMemberId(null);
    }
  }

  async function handleAddFolder(groupId: number) {
    if (addFolderId === "") return;
    setAddFolderBusy(true);
    setAddFolderError(null);
    try {
      const access = await grantGroupFolderAccess(groupId, Number(addFolderId));
      setDetails((prev) => {
        const next = new Map(prev);
        const d = next.get(groupId);
        if (d) {
          const already = d.folderAccesses.some((a) => a.folder_id === access.folder_id);
          next.set(groupId, {
            ...d,
            folderAccesses: already ? d.folderAccesses : [...d.folderAccesses, access].sort((a, b) => a.folder_name.localeCompare(b.folder_name)),
          });
        }
        return next;
      });
      setGroups((prev) =>
        prev.map((g) => g.group_id === groupId ? { ...g, folder_access_count: g.folder_access_count + 1 } : g),
      );
      setAddFolderId("");
    } catch (err) {
      setAddFolderError(err instanceof Error ? err.message : "Failed to grant folder access");
    } finally {
      setAddFolderBusy(false);
    }
  }

  async function handleRevokeFolder(groupId: number, folderId: number) {
    setRevokingFolderId(folderId);
    try {
      await revokeGroupFolderAccess(groupId, folderId);
      setDetails((prev) => {
        const next = new Map(prev);
        const d = next.get(groupId);
        if (d) next.set(groupId, { ...d, folderAccesses: d.folderAccesses.filter((a) => a.folder_id !== folderId) });
        return next;
      });
      setGroups((prev) =>
        prev.map((g) => g.group_id === groupId ? { ...g, folder_access_count: Math.max(0, g.folder_access_count - 1) } : g),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke folder access");
    } finally {
      setRevokingFolderId(null);
    }
  }

  if (loading) return <p className="settings-groups-muted">Loading groups…</p>;

  return (
    <div className="settings-groups">
      <div className="settings-subsection-title-row">
        <h2 className="settings-subsection-title">User Groups</h2>
      </div>
      <p className="settings-subsection-desc">
        Groups control which members can see protected folders. A protected folder with no group
        restrictions is visible to all members. Assign groups to a folder to restrict access.
      </p>

      {error && <p className="login-error settings-groups-error" role="alert">{error}</p>}

      {/* Create group form */}
      <form className="settings-groups-create-form" onSubmit={(e) => void handleCreate(e)}>
        <input
          type="text"
          className="input settings-groups-create-input"
          placeholder="New group name"
          value={newName}
          maxLength={255}
          onChange={(e) => setNewName(e.target.value)}
          aria-label="New group name"
        />
        <button
          type="submit"
          className="login-btn settings-groups-create-btn"
          disabled={creating || !newName.trim()}
        >
          {creating ? "Creating…" : "Create group"}
        </button>
      </form>
      {createError && <p className="login-error" role="alert">{createError}</p>}

      {groups.length === 0 ? (
        <p className="settings-groups-muted">No groups yet. Create one above.</p>
      ) : (
        <ul className="settings-groups-list" role="list">
          {groups.map((group) => {
            const isExpanded = expandedId === group.group_id;
            const detail = details.get(group.group_id);
            const isDeleting = deletingId === group.group_id;
            const isRenaming = renamingId === group.group_id;

            // Members not yet in this group
            const memberIds = new Set(detail?.members.map((m) => m.user_id) ?? []);
            const addableMembers = wsMembers.filter((m) => !memberIds.has(m.id));

            // Protected folders not yet granted
            const grantedFolderIds = new Set(detail?.folderAccesses.map((a) => a.folder_id) ?? []);
            const addableFolders = protectedFolders.filter((f) => !grantedFolderIds.has(f.folder_id));

            return (
              <li key={group.group_id} className={`settings-groups-item${isExpanded ? " settings-groups-item--expanded" : ""}`}>
                {/* Group header row */}
                <div className="settings-groups-item-header">
                  <button
                    type="button"
                    className="settings-groups-item-toggle"
                    aria-expanded={isExpanded}
                    onClick={() => handleToggleExpand(group.group_id)}
                  >
                    <svg className={`settings-groups-chevron${isExpanded ? " settings-groups-chevron--open" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" fill="currentColor" />
                    </svg>
                    {isRenaming ? (
                      <input
                        type="text"
                        className="input settings-groups-rename-input"
                        value={renameDraft}
                        maxLength={255}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void handleRename(group.group_id); }
                          if (e.key === "Escape") { setRenamingId(null); }
                        }}
                        aria-label="Group name"
                      />
                    ) : (
                      <span className="settings-groups-item-name">{group.name}</span>
                    )}
                    <span className="settings-groups-item-meta">
                      {group.member_count} {group.member_count === 1 ? "member" : "members"}
                      {" · "}
                      {group.folder_access_count} {group.folder_access_count === 1 ? "folder" : "folders"}
                    </span>
                  </button>

                  <div className="settings-groups-item-actions">
                    {isRenaming ? (
                      <>
                        <button
                          type="button"
                          className="login-btn settings-groups-action-btn"
                          disabled={renameBusy}
                          onClick={() => void handleRename(group.group_id)}
                        >
                          {renameBusy ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          className="surface-btn settings-groups-action-btn"
                          disabled={renameBusy}
                          onClick={() => setRenamingId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="surface-btn settings-groups-action-btn"
                        onClick={() => startRename(group)}
                      >
                        Rename
                      </button>
                    )}
                    <button
                      type="button"
                      className="settings-groups-delete-btn"
                      disabled={isDeleting}
                      onClick={() => void handleDelete(group.group_id)}
                      aria-label={`Delete ${group.name}`}
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="settings-groups-detail">
                    {detail?.loading ? (
                      <p className="settings-groups-muted">Loading…</p>
                    ) : detail?.error ? (
                      <p className="login-error" role="alert">{detail.error}</p>
                    ) : (
                      <>
                        {/* Members */}
                        <div className="settings-groups-subsection">
                          <h3 className="settings-groups-subsection-title">Members</h3>
                          {detail?.members.length === 0 ? (
                            <p className="settings-groups-muted">No members yet.</p>
                          ) : (
                            <ul className="settings-groups-member-list" role="list">
                              {detail?.members.map((m) => (
                                <li key={m.user_id} className="settings-groups-member-row">
                                  <span className="settings-groups-member-login">{m.login}</span>
                                  <button
                                    type="button"
                                    className="surface-btn settings-groups-remove-btn"
                                    disabled={removingMemberId === m.user_id}
                                    onClick={() => void handleRemoveMember(group.group_id, m.user_id)}
                                  >
                                    {removingMemberId === m.user_id ? "…" : "Remove"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          {addableMembers.length > 0 && (
                            <div className="settings-groups-add-row">
                              <select
                                className="input settings-groups-add-select"
                                value={addMemberUserId}
                                onChange={(e) => setAddMemberUserId(e.target.value === "" ? "" : Number(e.target.value))}
                                aria-label="Select member to add"
                              >
                                <option value="">Select a member…</option>
                                {addableMembers.map((m) => (
                                  <option key={m.id} value={m.id}>{m.login}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="login-btn settings-groups-add-btn"
                                disabled={addMemberUserId === "" || addMemberBusy}
                                onClick={() => void handleAddMember(group.group_id)}
                              >
                                {addMemberBusy ? "Adding…" : "Add"}
                              </button>
                            </div>
                          )}
                          {addMemberError && <p className="login-error" role="alert">{addMemberError}</p>}
                        </div>

                        {/* Folder access */}
                        <div className="settings-groups-subsection">
                          <h3 className="settings-groups-subsection-title">Protected folder access</h3>
                          <p className="settings-groups-subsection-desc">
                            Only protected folders can be restricted by group. Adding a folder here
                            means only members of permitted groups can see it.
                          </p>
                          {detail?.folderAccesses.length === 0 ? (
                            <p className="settings-groups-muted">No folder access grants.</p>
                          ) : (
                            <ul className="settings-groups-folder-list" role="list">
                              {detail?.folderAccesses.map((a) => (
                                <li key={a.folder_id} className="settings-groups-folder-row">
                                  <span className="settings-groups-folder-name">{a.folder_name}</span>
                                  <button
                                    type="button"
                                    className="surface-btn settings-groups-remove-btn"
                                    disabled={revokingFolderId === a.folder_id}
                                    onClick={() => void handleRevokeFolder(group.group_id, a.folder_id)}
                                  >
                                    {revokingFolderId === a.folder_id ? "…" : "Revoke"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          {addableFolders.length > 0 && (
                            <div className="settings-groups-add-row">
                              <select
                                className="input settings-groups-add-select"
                                value={addFolderId}
                                onChange={(e) => setAddFolderId(e.target.value === "" ? "" : Number(e.target.value))}
                                aria-label="Select folder to grant access"
                              >
                                <option value="">Select a folder…</option>
                                {addableFolders.map((f) => (
                                  <option key={f.folder_id} value={f.folder_id}>{f.name}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="login-btn settings-groups-add-btn"
                                disabled={addFolderId === "" || addFolderBusy}
                                onClick={() => void handleAddFolder(group.group_id)}
                              >
                                {addFolderBusy ? "Adding…" : "Grant"}
                              </button>
                            </div>
                          )}
                          {addFolderError && <p className="login-error" role="alert">{addFolderError}</p>}
                          {protectedFolders.length === 0 && (
                            <p className="settings-groups-muted">No protected folders exist in this workspace.</p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

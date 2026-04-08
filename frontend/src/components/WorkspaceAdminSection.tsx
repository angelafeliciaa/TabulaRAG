import { useEffect, useMemo, useRef, useState } from "react";
import { useAppUi } from "../appUiContext";
import CopyClipboardButton from "./CopyClipboardButton";
import {
  adminRevokeMemberMcpToken,
  createInviteCode,
  getUser,
  applyEnterpriseSession,
  listInviteCodes,
  listMembers,
  removeMember,
  revokeInviteCode,
  transferEnterpriseOwnership,
  updateMemberRole,
  type InviteCode,
  type Member,
} from "../api";

type WorkspaceAdminSectionProps = {
  workspaceId: number;
  isAdmin: boolean;
  /** When false, admins can promote members but cannot demote another admin (owner only). */
  viewerIsOwner: boolean;
};

export default function WorkspaceAdminSection({ workspaceId, isAdmin, viewerIsOwner }: WorkspaceAdminSectionProps) {
  const { bumpSession } = useAppUi();
  const currentUser = getUser();

  const [members, setMembers] = useState<Member[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);
  const [removeConfirmMember, setRemoveConfirmMember] = useState<Member | null>(null);
  const removeConfirmCancelRef = useRef<HTMLButtonElement | null>(null);
  const [transferConfirmMember, setTransferConfirmMember] = useState<Member | null>(null);
  const transferConfirmCancelRef = useRef<HTMLButtonElement | null>(null);
  const [roleMenuOpenForId, setRoleMenuOpenForId] = useState<number | null>(null);
  const [roleMenuPos, setRoleMenuPos] = useState<{ top: number; left: number } | null>(null);

  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesError, setCodesError] = useState<string | null>(null);
  const [codesLoading, setCodesLoading] = useState(true);
  const [inviteBusy, setInviteBusy] = useState(false);

  const [roleUpdating, setRoleUpdating] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [revokingMcp, setRevokingMcp] = useState<number | null>(null);

  const inviteCodesSorted = useMemo(
    () =>
      [...codes].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [codes],
  );
  const activeInviteCodes = useMemo(
    () => inviteCodesSorted.filter((c) => !c.expired),
    [inviteCodesSorted],
  );
  const primaryInvite = activeInviteCodes[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    setMembersLoading(true);
    setMembersError(null);

    listMembers()
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch((err) => {
        if (!cancelled) setMembersError(err instanceof Error ? err.message : "Failed to load members");
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (removeConfirmMember) {
      removeConfirmCancelRef.current?.focus();
    }
  }, [removeConfirmMember]);

  useEffect(() => {
    if (transferConfirmMember) {
      transferConfirmCancelRef.current?.focus();
    }
  }, [transferConfirmMember]);

  useEffect(() => {
    if (roleMenuOpenForId === null) {
      return;
    }

    function close() {
      setRoleMenuOpenForId(null);
      setRoleMenuPos(null);
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-role-menu-root]")) return;
      close();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close, true);
    };
  }, [roleMenuOpenForId]);

  useEffect(() => {
    if (!isAdmin) {
      setCodes([]);
      setCodesError(null);
      setCodesLoading(false);
      return;
    }
    let cancelled = false;
    setCodesLoading(true);
    setCodesError(null);
    listInviteCodes()
      .then((list) => {
        if (!cancelled) setCodes(list);
      })
      .catch((err) => {
        if (!cancelled) setCodesError(err instanceof Error ? err.message : "Failed to load invite codes");
      })
      .finally(() => {
        if (!cancelled) setCodesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, isAdmin]);

  async function refreshInviteCodes() {
    const list = await listInviteCodes();
    setCodes(list);
  }

  async function handleRoleChange(member: Member, nextRole: Member["role"]) {
    if (member.role === "owner") return;
    if (nextRole === member.role) return;

    setRoleUpdating(member.id);
    setMembersError(null);
    try {
      if (nextRole === "owner") {
        if (!viewerIsOwner) {
          throw new Error("Only the workspace owner can transfer ownership");
        }
        // Use in-app confirmation modal (not browser confirm).
        setTransferConfirmMember(member);
        return;
      }

      const updated = await updateMemberRole(member.id, nextRole as "admin" | "querier");
      setMembers((prev) =>
        prev.map((m) => (m.id === updated.id ? { ...m, role: updated.role } : m)),
      );
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setRoleUpdating(null);
    }
  }

  async function confirmTransferOwnership() {
    if (!transferConfirmMember) return;
    const target = transferConfirmMember;
    setTransferConfirmMember(null);
    setRoleUpdating(target.id);
    setMembersError(null);
    try {
      const res = await transferEnterpriseOwnership(target.id);
      applyEnterpriseSession(res.token, workspaceId, res.role);
      bumpSession();
      const refreshed = await listMembers();
      setMembers(refreshed);
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Failed to transfer ownership");
    } finally {
      setRoleUpdating(null);
    }
  }

  async function handleRemove(member: Member) {
    setRemoving(member.id);
    try {
      await removeMember(member.id);
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Failed to remove member");
    } finally {
      setRemoving(null);
    }
  }

  async function confirmRemoveMember() {
    if (!removeConfirmMember) return;
    const member = removeConfirmMember;
    setRemoveConfirmMember(null);
    await handleRemove(member);
  }

  async function handleCreateOrRegenerateInvite() {
    setInviteBusy(true);
    setCodesError(null);
    try {
      for (const c of codes.filter((x) => !x.expired)) {
        await revokeInviteCode(c.code);
      }
      await createInviteCode();
      await refreshInviteCodes();
    } catch (err) {
      setCodesError(err instanceof Error ? err.message : "Failed to update invite code");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRevokeInvite() {
    setInviteBusy(true);
    setCodesError(null);
    try {
      for (const c of codes.filter((x) => !x.expired)) {
        await revokeInviteCode(c.code);
      }
      await refreshInviteCodes();
    } catch (err) {
      setCodesError(err instanceof Error ? err.message : "Failed to revoke invite code");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRevokeMcp(member: Member) {
    setRevokingMcp(member.id);
    setMembersError(null);
    try {
      await adminRevokeMemberMcpToken(member.id);
      setMembers((prev) =>
        prev.map((m) => (m.id === member.id ? { ...m, mcp_token_configured: false } : m)),
      );
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Failed to revoke MCP token");
    } finally {
      setRevokingMcp(null);
    }
  }

  function formatExpiry(code: InviteCode): string {
    if (!code.expires_at) return "No expiry";
    const d = new Date(code.expires_at);
    return d.toLocaleString();
  }

  function displayMemberRole(role: Member["role"]): string {
    if (role === "querier") return "Member";
    if (role === "admin") return "Admin";
    if (role === "owner") return "Owner";
    return role;
  }

  function openRoleMenu(member: Member, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    setRoleMenuOpenForId((prev) => (prev === member.id ? null : member.id));
    setRoleMenuPos({
      top: rect.bottom + 6,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 220)),
    });
  }

  return (
    <div className="settings-workspace-admin">
      {removeConfirmMember ? (
        <div
          className="confirm-modal-overlay"
          role="presentation"
          onClick={() => setRemoveConfirmMember(null)}
        >
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm member removal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Remove member?</h3>
            <p>
              Remove{" "}
              <span className="confirm-modal-table-name">{removeConfirmMember.display_name}</span>{" "}
              from this workspace.
            </p>
            <div className="confirm-modal-actions">
              <button
                ref={removeConfirmCancelRef}
                type="button"
                className="surface-btn"
                onClick={() => setRemoveConfirmMember(null)}
                disabled={removing === removeConfirmMember.id}
              >
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete-button"
                onClick={() => void confirmRemoveMember()}
                disabled={removing === removeConfirmMember.id}
              >
                {removing === removeConfirmMember.id ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {transferConfirmMember ? (
        <div
          className="confirm-modal-overlay"
          role="presentation"
          onClick={() => setTransferConfirmMember(null)}
        >
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm ownership transfer"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Transfer ownership?</h3>
            <p>
              Transfer ownership to{" "}
              <span className="confirm-modal-table-name">{transferConfirmMember.display_name}</span>.
              {" "}You will become an Admin after the transfer.
            </p>
            <div className="confirm-modal-actions">
              <button
                ref={transferConfirmCancelRef}
                type="button"
                className="surface-btn"
                onClick={() => setTransferConfirmMember(null)}
                disabled={roleUpdating === transferConfirmMember.id}
              >
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete-button"
                onClick={() => void confirmTransferOwnership()}
                disabled={roleUpdating === transferConfirmMember.id}
              >
                {roleUpdating === transferConfirmMember.id ? "Transferring…" : "Transfer"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="settings-workspace-admin-block">
        <h2 className="settings-workspace-admin-heading">Members</h2>
        {membersError ? <p className="login-error" role="alert">{membersError}</p> : null}
        {membersLoading ? (
          <p className="settings-workspace-admin-muted">Loading…</p>
        ) : members.length === 0 ? (
          <p className="settings-workspace-admin-muted">No members yet.</p>
        ) : (
          <div className="settings-workspace-admin-table-wrap">
            <table className="settings-workspace-admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  {isAdmin ? (
                    <>
                      <th>Joined</th>
                      <th>MCP</th>
                      <th></th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isSelf = member.is_self ?? false;
                  const isWorkspaceOwner = member.role === "owner";
                  const adminDemoteNeedsOwner =
                    isAdmin && !viewerIsOwner && member.role === "admin" && !isSelf;
                  const roleMenuOpen = roleMenuOpenForId === member.id;
                  return (
                    <tr key={member.id}>
                      <td>
                        <span className="settings-workspace-admin-email-cell">
                          <span className="settings-workspace-admin-member-name">{member.display_name}</span>
                          {isSelf ? (
                            <span className="settings-workspace-admin-you-badge">You</span>
                          ) : null}
                          {member.login ? (
                            <span className="settings-workspace-admin-member-email">{member.login}</span>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        {isWorkspaceOwner ? (
                          <span className="settings-workspace-admin-muted">Owner</span>
                        ) : isAdmin && adminDemoteNeedsOwner ? (
                          <span
                            className="settings-workspace-admin-muted"
                            title="Only the workspace owner can demote an admin to member"
                          >
                            Admin
                          </span>
                        ) : isAdmin ? (
                          <span className="sort-menu-wrap" data-role-menu-root>
                            <button
                              type="button"
                              className={`surface-btn settings-workspace-admin-table-btn${roleMenuOpen ? " active" : ""}`}
                              disabled={isSelf || roleUpdating === member.id}
                              onClick={(e) => openRoleMenu(member, e.currentTarget)}
                              aria-haspopup="menu"
                              aria-expanded={roleMenuOpen}
                              aria-label={`Role for ${member.display_name}`}
                              title={isSelf ? "Cannot change your own role" : undefined}
                            >
                              {roleUpdating === member.id ? "Saving…" : displayMemberRole(member.role)}
                            </button>

                            {roleMenuOpen && roleMenuPos ? (
                              <div
                                className="sort-menu"
                                role="menu"
                                aria-label={`Set role for ${member.display_name}`}
                                style={{
                                  position: "fixed",
                                  top: roleMenuPos.top,
                                  left: roleMenuPos.left,
                                  right: "auto",
                                  minWidth: 200,
                                  zIndex: 20050,
                                }}
                              >
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={member.role === "querier"}
                                  className={`sort-menu-item${member.role === "querier" ? " active" : ""}`}
                                  onClick={() => {
                                    setRoleMenuOpenForId(null);
                                    setRoleMenuPos(null);
                                    void handleRoleChange(member, "querier");
                                  }}
                                >
                                  Member
                                </button>
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={member.role === "admin"}
                                  className={`sort-menu-item${member.role === "admin" ? " active" : ""}`}
                                  onClick={() => {
                                    setRoleMenuOpenForId(null);
                                    setRoleMenuPos(null);
                                    void handleRoleChange(member, "admin");
                                  }}
                                >
                                  Admin
                                </button>
                                {viewerIsOwner ? (
                                  <button
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={member.role === "owner"}
                                    className="sort-menu-item"
                                    onClick={() => {
                                      setRoleMenuOpenForId(null);
                                      setRoleMenuPos(null);
                                      void handleRoleChange(member, "owner");
                                    }}
                                  >
                                    Owner (transfer)
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </span>
                        ) : (
                          <span className="settings-workspace-admin-muted">{displayMemberRole(member.role)}</span>
                        )}
                      </td>
                      {isAdmin ? (
                        <>
                          <td className="settings-workspace-admin-cell-muted">
                            {new Date(member.joined_at).toLocaleDateString()}
                          </td>
                          <td className="settings-workspace-admin-cell-sm">
                            {member.mcp_token_configured ? (
                              <button
                                type="button"
                                className="surface-btn settings-workspace-admin-mcp-revoke"
                                disabled={revokingMcp === member.id}
                                onClick={() => void handleRevokeMcp(member)}
                              >
                                {revokingMcp === member.id ? "…" : "Revoke"}
                              </button>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            {!isSelf && !isWorkspaceOwner ? (
                              <button
                                type="button"
                                className="surface-btn settings-workspace-admin-remove"
                                disabled={removing === member.id}
                                onClick={() => setRemoveConfirmMember(member)}
                              >
                                {removing === member.id ? "Removing…" : "Remove"}
                              </button>
                            ) : null}
                          </td>
                        </>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin ? (
      <section className="settings-workspace-admin-block">
        <h2 className="settings-workspace-admin-heading">Invite Code</h2>
        {codesError ? <p className="login-error" role="alert">{codesError}</p> : null}
        {codesLoading ? (
          <p className="settings-workspace-admin-muted">Loading…</p>
        ) : (
          <>
            <p className="settings-workspace-admin-invite-status">
              <span className="settings-workspace-admin-muted">Status:</span>{" "}
              <strong>{primaryInvite ? "Code active" : "No code — generate one to invite others"}</strong>
              {primaryInvite ? (
                <span className="settings-workspace-admin-invite-status-meta">
                  {" "}
                  · created {new Date(primaryInvite.created_at).toLocaleString()}
                  {" · "}
                  expires {formatExpiry(primaryInvite)}
                </span>
              ) : null}
            </p>
            {primaryInvite ? (
              <div className="settings-workspace-admin-invite-reveal">
                <div className="settings-workspace-admin-invite-reveal-row">
                  <input
                    className="input settings-workspace-admin-invite-reveal-input"
                    readOnly
                    value={primaryInvite.code}
                    aria-label="Invite code"
                  />
                  <CopyClipboardButton
                    ariaLabel="Copy invite code to clipboard"
                    onClick={() => void navigator.clipboard.writeText(primaryInvite.code)}
                  />
                </div>
              </div>
            ) : null}
            {activeInviteCodes.length > 1 ? (
              <p className="settings-workspace-admin-invite-legacy-hint">
                Multiple active codes are on file. Regenerate or revoke to consolidate to a single code.
              </p>
            ) : null}
            <div className="settings-workspace-admin-invite-actions">
              <button
                type="button"
                className="login-btn settings-workspace-admin-btn-primary"
                disabled={inviteBusy}
                onClick={() => void handleCreateOrRegenerateInvite()}
              >
                {inviteBusy ? "Working…" : primaryInvite ? "Regenerate code" : "Generate invite code"}
              </button>
              {primaryInvite ? (
                <button
                  type="button"
                  className="surface-btn"
                  disabled={inviteBusy}
                  onClick={() => void handleRevokeInvite()}
                >
                  Revoke code
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import CopyClipboardButton from "./CopyClipboardButton";
import {
  adminRevokeMemberMcpToken,
  createInviteCode,
  getUser,
  listInviteCodes,
  listMembers,
  removeMember,
  revokeInviteCode,
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
  const currentUser = getUser();

  const [members, setMembers] = useState<Member[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);

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

  async function handleRoleToggle(member: Member) {
    if (member.role === "owner") return;
    const nextRole = member.role === "admin" ? "querier" : "admin";
    setRoleUpdating(member.id);
    try {
      const updated = await updateMemberRole(member.id, nextRole);
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? { ...m, role: updated.role } : m)));
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Failed to update role");
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
    if (role === "querier") return "member";
    return role;
  }

  return (
    <div className="settings-workspace-admin">
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
                  <th>Email</th>
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
                  const isSelf = member.login === currentUser?.login;
                  const isWorkspaceOwner = member.role === "owner";
                  const adminDemoteNeedsOwner =
                    isAdmin && !viewerIsOwner && member.role === "admin" && !isSelf;
                  return (
                    <tr key={member.id}>
                      <td>
                        <span className="settings-workspace-admin-email-cell">
                          {member.login}
                          {isSelf ? (
                            <span className="settings-workspace-admin-you-badge">You</span>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        {isWorkspaceOwner ? (
                          <span className="settings-workspace-admin-muted">owner</span>
                        ) : isAdmin && adminDemoteNeedsOwner ? (
                          <span
                            className="settings-workspace-admin-muted"
                            title="Only the workspace owner can demote an admin to member"
                          >
                            admin
                          </span>
                        ) : isAdmin ? (
                          <button
                            type="button"
                            className="surface-btn settings-workspace-admin-table-btn"
                            disabled={isSelf || roleUpdating === member.id}
                            onClick={() => void handleRoleToggle(member)}
                            title={isSelf ? "Cannot change your own role" : undefined}
                          >
                            {roleUpdating === member.id ? "Saving…" : member.role}
                          </button>
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
                                onClick={() => void handleRemove(member)}
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

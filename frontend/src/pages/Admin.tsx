import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  adminRevokeMemberMcpToken,
  applyEnterpriseSession,
  createInviteCode,
  disbandEnterprise,
  getUser,
  isOwner,
  listInviteCodes,
  listMembers,
  listMyWorkspaces,
  patchStoredUser,
  removeMember,
  revokeInviteCode,
  switchWorkspace,
  transferEnterpriseOwnership,
  updateMemberRole,
  type InviteCode,
  type Member,
} from "../api";

export default function Admin() {
  const navigate = useNavigate();
  const currentUser = getUser();

  const [members, setMembers] = useState<Member[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);

  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesError, setCodesError] = useState<string | null>(null);
  const [codesLoading, setCodesLoading] = useState(true);
  const [creatingCode, setCreatingCode] = useState(false);

  const [roleUpdating, setRoleUpdating] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingMcp, setRevokingMcp] = useState<number | null>(null);

  const [transferTargetId, setTransferTargetId] = useState<string>("");
  const [transferring, setTransferring] = useState(false);
  const [disbandConfirm, setDisbandConfirm] = useState("");
  const [disbanding, setDisbanding] = useState(false);

  useEffect(() => {
    listMembers()
      .then(setMembers)
      .catch((err) => setMembersError(err instanceof Error ? err.message : "Failed to load members"))
      .finally(() => setMembersLoading(false));

    listInviteCodes()
      .then(setCodes)
      .catch((err) => setCodesError(err instanceof Error ? err.message : "Failed to load invite codes"))
      .finally(() => setCodesLoading(false));
  }, []);

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

  async function handleCreateCode() {
    setCreatingCode(true);
    setCodesError(null);
    try {
      const code = await createInviteCode();
      setCodes((prev) => [{ ...code, expired: false }, ...prev]);
    } catch (err) {
      setCodesError(err instanceof Error ? err.message : "Failed to create invite code");
    } finally {
      setCreatingCode(false);
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

  async function handleRevoke(code: string) {
    setRevoking(code);
    try {
      await revokeInviteCode(code);
      setCodes((prev) => prev.filter((c) => c.code !== code));
    } catch (err) {
      setCodesError(err instanceof Error ? err.message : "Failed to revoke invite code");
    } finally {
      setRevoking(null);
    }
  }

  async function handleTransferOwnership() {
    const id = Number(transferTargetId);
    if (!Number.isFinite(id) || id <= 0) return;
    const eid = currentUser?.enterprise_id;
    if (eid == null) return;
    setTransferring(true);
    setMembersError(null);
    try {
      const { token, role } = await transferEnterpriseOwnership(id);
      applyEnterpriseSession(token, eid, role);
      const list = await listMembers();
      setMembers(list);
      setTransferTargetId("");
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Failed to transfer ownership");
    } finally {
      setTransferring(false);
    }
  }

  async function handleDisbandEnterprise() {
    if (disbandConfirm.trim().toUpperCase() !== "DISBAND") return;
    const leftId = currentUser?.enterprise_id;
    setDisbanding(true);
    setMembersError(null);
    try {
      await disbandEnterprise();
      const ws = await listMyWorkspaces();
      if (ws.length > 0) {
        const next =
          ws.find((w) => w.is_active) ?? ws.find((w) => w.enterprise_id !== leftId) ?? ws[0];
        await switchWorkspace(next.enterprise_id);
        navigate("/", { replace: true });
      } else {
        patchStoredUser({ enterprise_id: null, role: null });
        navigate("/onboarding", { replace: true });
      }
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Failed to disband enterprise");
    } finally {
      setDisbanding(false);
      setDisbandConfirm("");
    }
  }

  function formatExpiry(code: InviteCode): string {
    if (!code.expires_at) return "No expiry";
    const d = new Date(code.expires_at);
    return d.toLocaleString();
  }

  return (
    <div className="page" style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "2rem" }}>Admin Panel</h1>

      {isOwner() && (
        <section
          style={{
            marginBottom: "2rem",
            padding: "1rem 1.25rem",
            border: "1px solid var(--border-color, #ddd)",
            borderRadius: 8,
            background: "var(--surface-elevated, rgba(0,0,0,0.03))",
          }}
        >
          <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.75rem" }}>Enterprise owner</h2>
          <p style={{ margin: "0 0 1rem", fontSize: "0.9rem", opacity: 0.85 }}>
            Transfer ownership to an existing admin (you become an admin). Disbanding deletes this
            workspace, all datasets, and memberships permanently.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <span>Transfer to</span>
              <select
                className="surface-btn"
                style={{ fontSize: "0.85rem", padding: "0.35rem 0.6rem" }}
                value={transferTargetId}
                onChange={(e) => setTransferTargetId(e.target.value)}
                aria-label="Select admin to receive ownership"
              >
                <option value="">— choose admin —</option>
                {members
                  .filter((m) => m.role === "admin" && m.login !== currentUser?.login)
                  .map((m) => (
                    <option key={m.id} value={String(m.id)}>
                      {m.login}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="login-btn"
              style={{ fontSize: "0.85rem", padding: "0.4rem 1rem" }}
              disabled={
                !transferTargetId ||
                transferring ||
                members.filter((m) => m.role === "admin" && m.login !== currentUser?.login).length === 0
              }
              onClick={() => void handleTransferOwnership()}
            >
              {transferring ? "Transferring…" : "Transfer ownership"}
            </button>
          </div>
          {members.filter((m) => m.role === "admin" && m.login !== currentUser?.login).length === 0 && (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.85rem", opacity: 0.75 }}>
              Promote another member to admin before you can transfer ownership.
            </p>
          )}
          <div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px solid var(--border-color, #eee)" }}>
            <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", opacity: 0.8 }}>
              Type <strong>DISBAND</strong> to confirm deleting this enterprise.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
              <input
                type="text"
                className="surface-btn"
                style={{ fontSize: "0.85rem", padding: "0.35rem 0.6rem", minWidth: 200 }}
                placeholder="DISBAND"
                value={disbandConfirm}
                onChange={(e) => setDisbandConfirm(e.target.value)}
                aria-label="Type DISBAND to confirm"
              />
              <button
                type="button"
                className="surface-btn"
                style={{
                  fontSize: "0.85rem",
                  padding: "0.4rem 1rem",
                  color: "var(--danger-color, #c00)",
                  borderColor: "var(--danger-color, #c00)",
                }}
                disabled={disbandConfirm.trim().toUpperCase() !== "DISBAND" || disbanding}
                onClick={() => void handleDisbandEnterprise()}
              >
                {disbanding ? "Disbanding…" : "Disband enterprise"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Members */}
      <section style={{ marginBottom: "2.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Members</h2>
        {membersError && <p className="login-error" role="alert">{membersError}</p>}
        {membersLoading ? (
          <p style={{ opacity: 0.6 }}>Loading...</p>
        ) : members.length === 0 ? (
          <p style={{ opacity: 0.6 }}>No members yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color, #ddd)" }}>
                <th style={{ padding: "0.5rem 0.75rem" }}>Email</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Role</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Joined</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>MCP</th>
                <th style={{ padding: "0.5rem 0.75rem" }}></th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isSelf = member.login === currentUser?.login;
                const isEnterpriseOwner = member.role === "owner";
                return (
                  <tr key={member.id} style={{ borderBottom: "1px solid var(--border-color, #eee)" }}>
                    <td style={{ padding: "0.5rem 0.75rem" }}>{member.login}</td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      {isEnterpriseOwner ? (
                        <span style={{ fontSize: "0.85rem", opacity: 0.9 }}>owner</span>
                      ) : (
                        <button
                          type="button"
                          className="surface-btn"
                          style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem" }}
                          disabled={isSelf || roleUpdating === member.id}
                          onClick={() => void handleRoleToggle(member)}
                          title={isSelf ? "Cannot change your own role" : undefined}
                        >
                          {roleUpdating === member.id ? "Saving..." : member.role}
                        </button>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", opacity: 0.6, fontSize: "0.8rem" }}>
                      {new Date(member.joined_at).toLocaleDateString()}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.8rem" }}>
                      {member.mcp_token_configured ? (
                        <span>
                          Yes{" "}
                          <button
                            type="button"
                            className="surface-btn"
                            style={{ fontSize: "0.75rem", padding: "0.15rem 0.45rem", marginLeft: "0.35rem" }}
                            disabled={revokingMcp === member.id}
                            onClick={() => void handleRevokeMcp(member)}
                          >
                            {revokingMcp === member.id ? "…" : "Revoke"}
                          </button>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      {!isSelf && !isEnterpriseOwner && (
                        <button
                          type="button"
                          className="surface-btn"
                          style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem", color: "var(--danger-color, #c00)" }}
                          disabled={removing === member.id}
                          onClick={() => void handleRemove(member)}
                        >
                          {removing === member.id ? "Removing..." : "Remove"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Invite Codes */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Invite Codes</h2>
          <button
            type="button"
            className="login-btn"
            style={{ fontSize: "0.85rem", padding: "0.4rem 1rem" }}
            disabled={creatingCode}
            onClick={handleCreateCode}
          >
            {creatingCode ? "Generating..." : "Generate code"}
          </button>
        </div>
        {codesError && <p className="login-error" role="alert">{codesError}</p>}
        {codesLoading ? (
          <p style={{ opacity: 0.6 }}>Loading...</p>
        ) : codes.length === 0 ? (
          <p style={{ opacity: 0.6 }}>No invite codes. Generate one to invite team members.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color, #ddd)" }}>
                <th style={{ padding: "0.5rem 0.75rem" }}>Code</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Expires</th>
                <th style={{ padding: "0.5rem 0.75rem" }}>Status</th>
                <th style={{ padding: "0.5rem 0.75rem" }}></th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.code} style={{ borderBottom: "1px solid var(--border-color, #eee)", opacity: c.expired ? 0.5 : 1 }}>
                  <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", letterSpacing: "0.1em" }}>
                    {c.code}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.8rem", opacity: 0.7 }}>
                    {formatExpiry(c)}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.8rem" }}>
                    {c.expired ? "Expired" : "Active"}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem" }}>
                    <button
                      type="button"
                      className="surface-btn"
                      style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem", color: "var(--danger-color, #c00)" }}
                      disabled={revoking === c.code}
                      onClick={() => handleRevoke(c.code)}
                    >
                      {revoking === c.code ? "Revoking..." : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

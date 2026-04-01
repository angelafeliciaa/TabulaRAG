import { useEffect, useState } from "react";
import {
  adminRevokeMemberMcpToken,
  createInviteCode,
  listInviteCodes,
  listMembers,
  removeMember,
  revokeInviteCode,
  updateMemberRole,
  getUser,
  type InviteCode,
  type Member,
} from "../api";

export default function Admin() {
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

  function formatExpiry(code: InviteCode): string {
    if (!code.expires_at) return "No expiry";
    const d = new Date(code.expires_at);
    return d.toLocaleString();
  }

  return (
    <div className="page" style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "2rem" }}>Admin Panel</h1>

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
                return (
                  <tr key={member.id} style={{ borderBottom: "1px solid var(--border-color, #eee)" }}>
                    <td style={{ padding: "0.5rem 0.75rem" }}>{member.login}</td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      <button
                        type="button"
                        className="surface-btn"
                        style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem" }}
                        disabled={isSelf || roleUpdating === member.id}
                        onClick={() => handleRoleToggle(member)}
                        title={isSelf ? "Cannot change your own role" : undefined}
                      >
                        {roleUpdating === member.id ? "Saving..." : member.role}
                      </button>
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
                      {!isSelf && (
                        <button
                          type="button"
                          className="surface-btn"
                          style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem", color: "var(--danger-color, #c00)" }}
                          disabled={removing === member.id}
                          onClick={() => handleRemove(member)}
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

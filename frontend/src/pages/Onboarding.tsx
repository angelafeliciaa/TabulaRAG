import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createEnterprise, joinEnterprise, getUser } from "../api";

export default function Onboarding() {
  const navigate = useNavigate();
  const user = getUser();

  const [enterpriseName, setEnterpriseName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [joinLoading, setJoinLoading] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreateLoading(true);
    try {
      await createEnterprise(enterpriseName.trim());
      navigate("/", { replace: true });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create enterprise");
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setJoinError(null);
    setJoinLoading(true);
    try {
      await joinEnterprise(inviteCode.trim().toUpperCase());
      navigate("/", { replace: true });
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "Failed to join enterprise");
    } finally {
      setJoinLoading(false);
    }
  }

  const hasWorkspace = Boolean(user?.enterprise_id);

  return (
    <div className="login-page">
      {hasWorkspace && (
        <p className="login-subtitle" style={{ maxWidth: 560, marginBottom: "1.25rem", textAlign: "center" }}>
          You can create another workspace or join one with an invite code. Use the menu switcher to move between workspaces.
        </p>
      )}
      <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap", justifyContent: "center", width: "100%", maxWidth: 760 }}>
        <div className="login-card" style={{ flex: 1, minWidth: 280 }}>
          <h2 className="login-title" style={{ fontSize: "1.25rem" }}>Create Enterprise</h2>
          <p className="login-subtitle">Start a new workspace. You'll be the admin.</p>
          <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <input
              className="input"
              type="text"
              placeholder="Enterprise name"
              value={enterpriseName}
              onChange={(e) => setEnterpriseName(e.target.value)}
              required
              autoComplete="off"
            />
            {createError && (
              <p className="login-error" role="alert">{createError}</p>
            )}
            <button
              type="submit"
              className="login-btn"
              disabled={createLoading || !enterpriseName.trim()}
            >
              {createLoading ? "Creating..." : "Create"}
            </button>
          </form>
        </div>

        <div className="login-card" style={{ flex: 1, minWidth: 280 }}>
          <h2 className="login-title" style={{ fontSize: "1.25rem" }}>Join Enterprise</h2>
          <p className="login-subtitle">Enter an invite code from your admin.</p>
          <form onSubmit={handleJoin} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <input
              className="input"
              type="text"
              placeholder="Invite code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              required
              autoComplete="off"
              style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}
            />
            {joinError && (
              <p className="login-error" role="alert">{joinError}</p>
            )}
            <button
              type="submit"
              className="login-btn"
              disabled={joinLoading || !inviteCode.trim()}
            >
              {joinLoading ? "Joining..." : "Join"}
            </button>
          </form>
        </div>
      </div>

      {user && (
        <p style={{ marginTop: "1.5rem", opacity: 0.6, fontSize: "0.875rem" }}>
          Signed in as <strong>{user.login}</strong>
        </p>
      )}
    </div>
  );
}

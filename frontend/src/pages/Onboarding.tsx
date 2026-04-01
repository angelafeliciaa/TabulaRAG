import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createEnterprise, joinEnterprise, getUser } from "../api";

type OnboardingMode = "create" | "join";

export default function Onboarding() {
  const navigate = useNavigate();
  const user = getUser();
  const displayName = (user?.name || user?.login || "there").trim();

  const [mode, setMode] = useState<OnboardingMode>("create");
  const [workspaceName, setWorkspaceName] = useState("");
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
      await createEnterprise(workspaceName.trim());
      navigate("/", { replace: true });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workspace");
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
      setJoinError(err instanceof Error ? err.message : "Failed to join workspace");
    } finally {
      setJoinLoading(false);
    }
  }

  return (
    <div className="login-page onboarding-page">
      <div className="login-card onboarding-panel">
        {user ? <p className="onboarding-greeting">Hello {displayName}!</p> : null}

        <div className="onboarding-tabs" role="tablist" aria-label="Create or join workspace">
          <button
            type="button"
            role="tab"
            id="onboarding-tab-create"
            aria-selected={mode === "create"}
            aria-controls="onboarding-panel-create"
            tabIndex={0}
            className={`onboarding-tab${mode === "create" ? " onboarding-tab--active" : ""}`}
            onClick={() => setMode("create")}
          >
            Create workspace
          </button>
          <button
            type="button"
            role="tab"
            id="onboarding-tab-join"
            aria-selected={mode === "join"}
            aria-controls="onboarding-panel-join"
            tabIndex={0}
            className={`onboarding-tab${mode === "join" ? " onboarding-tab--active" : ""}`}
            onClick={() => setMode("join")}
          >
            Join enterprise
          </button>
        </div>

        {mode === "create" ? (
          <div
            id="onboarding-panel-create"
            role="tabpanel"
            aria-labelledby="onboarding-tab-create"
            className="onboarding-tab-panel"
          >
            <p className="login-subtitle onboarding-panel-desc">
              Start a new workspace. You&apos;ll be the owner.
            </p>
            <form className="login-form" onSubmit={handleCreate}>
              <input
                className="input"
                type="text"
                placeholder="Workspace name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                required
                autoComplete="off"
              />
              {createError ? (
                <p className="login-error" role="alert">
                  {createError}
                </p>
              ) : null}
              <button type="submit" className="login-btn" disabled={createLoading || !workspaceName.trim()}>
                {createLoading ? "Creating..." : "Create workspace"}
              </button>
            </form>
          </div>
        ) : (
          <div
            id="onboarding-panel-join"
            role="tabpanel"
            aria-labelledby="onboarding-tab-join"
            className="onboarding-tab-panel"
          >
            <p className="login-subtitle onboarding-panel-desc">Enter an invite code from your admin.</p>
            <form className="login-form" onSubmit={handleJoin}>
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
              {joinError ? (
                <p className="login-error" role="alert">
                  {joinError}
                </p>
              ) : null}
              <button type="submit" className="login-btn" disabled={joinLoading || !inviteCode.trim()}>
                {joinLoading ? "Joining..." : "Join workspace"}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

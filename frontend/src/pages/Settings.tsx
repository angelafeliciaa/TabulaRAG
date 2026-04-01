import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAppUi } from "../appUiContext";
import McpTokenPanel from "../components/McpTokenPanel";
import {
  getUser,
  isAdmin,
  isOwner,
  listMyWorkspaces,
  logout,
  switchWorkspace,
  type WorkspaceSummary,
} from "../api";
type SettingsTab = "account" | "workspace" | "appearance" | "mcp";

const TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: "account", label: "Account", description: "Your profile and sign-in" },
  { id: "workspace", label: "Workspace", description: "Active organization and links" },
  { id: "appearance", label: "Appearance", description: "Theme and table value display" },
  { id: "mcp", label: "MCP", description: "Cursor and external tool access" },
];

export default function Settings() {
  const user = getUser();
  const { theme, setTheme, valueMode, setValueMode, bumpSession } = useAppUi();
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [wsError, setWsError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Settings | TabulaRAG";
  }, []);

  useEffect(() => {
    if (!user?.enterprise_id) {
      setWorkspaces([]);
      return;
    }
    let cancelled = false;
    listMyWorkspaces()
      .then((list) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch(() => {
        if (!cancelled) {
          setWsError("Could not load workspaces");
          setWorkspaces([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.enterprise_id]);

  function handleLogout() {
    logout();
    window.location.replace("/");
  }

  const roleLabel = user?.role ?? "—";
  const tabMeta = TABS.find((t) => t.id === activeTab) ?? TABS[0];

  return (
    <div className="settings-page">
      <div className="panel settings-shell">
        <nav className="settings-nav" aria-label="Settings categories">
          <div className="settings-nav-title">Settings</div>
          <ul className="settings-nav-list" role="tablist">
            {TABS.map((tab) => (
              <li key={tab.id} role="none">
                <button
                  type="button"
                  role="tab"
                  id={`settings-tab-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  aria-controls={`settings-panel-${tab.id}`}
                  tabIndex={0}
                  className={`settings-nav-item${activeTab === tab.id ? " settings-nav-item--active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="settings-nav-item-label">{tab.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div
          className="settings-content"
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
        >
          <header className="settings-content-header">
            <h1 className="settings-content-title">{tabMeta.label}</h1>
            <p className="settings-content-desc">{tabMeta.description}</p>
          </header>

          {activeTab === "account" && (
            <section className="settings-pane" aria-label="Account">
              <div className="settings-section-body">
                <div className="settings-account-row">
                  {user?.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt=""
                      className="settings-account-avatar"
                      width={56}
                      height={56}
                    />
                  ) : null}
                  <div className="settings-account-meta">
                    <div className="settings-account-name">{user?.name || user?.login || "—"}</div>
                    <div className="small" style={{ opacity: 0.85 }}>
                      {user?.login}
                    </div>
                    <div className="small" style={{ marginTop: "0.35rem", opacity: 0.85 }}>
                      Role in this workspace: <strong>{roleLabel}</strong>
                      {isOwner() ? " (enterprise owner)" : null}
                      {!isOwner() && isAdmin() ? " (can manage tables and invites)" : null}
                      {!isAdmin() ? " (read-only for tables)" : null}
                    </div>
                  </div>
                  <button type="button" className="logout-btn" onClick={handleLogout}>
                    Sign out
                  </button>
                </div>
              </div>
            </section>
          )}

          {activeTab === "workspace" && (
            <section className="settings-pane" aria-label="Workspace">
              <div className="settings-section-body">
                {wsError && (
                  <p className="login-error" role="alert">
                    {wsError}
                  </p>
                )}
                {workspaces.length === 0 ? (
                  <p className="small" style={{ margin: 0, opacity: 0.85 }}>
                    No workspaces loaded. You can create or join one from onboarding.
                  </p>
                ) : (
                  <>
                    <label htmlFor="settings-workspace-select" className="small" style={{ display: "block" }}>
                      Active workspace
                    </label>
                    <select
                      id="settings-workspace-select"
                      className="workspace-select"
                      style={{ maxWidth: "100%", width: "min(100%, 32rem)" }}
                      aria-label="Active workspace"
                      value={user?.enterprise_id ?? ""}
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        if (!Number.isFinite(id) || id === user?.enterprise_id) return;
                        void switchWorkspace(id).then(() => bumpSession());
                      }}
                    >
                      {workspaces.map((w) => (
                        <option key={w.enterprise_id} value={w.enterprise_id}>
                          {w.enterprise_name}
                          {w.role === "owner"
                            ? " · owner"
                            : w.role === "admin"
                              ? " · admin"
                              : w.role === "querier"
                                ? " · querier"
                                : ""}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <div className="settings-workspace-actions">
                  <Link className="surface-btn" to="/onboarding" style={{ fontSize: "0.85rem", padding: "0.35rem 0.9rem" }}>
                    Add or join workspace
                  </Link>
                  {isAdmin() && (
                    <Link className="surface-btn" to="/admin" style={{ fontSize: "0.85rem", padding: "0.35rem 0.9rem" }}>
                      Admin panel
                    </Link>
                  )}
                </div>
              </div>
            </section>
          )}

          {activeTab === "appearance" && (
            <section className="settings-pane" aria-label="Appearance">
              <div className="settings-section-body">
                <div className="settings-toggle-list">
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-row-text">
                      <div className="settings-toggle-title" id="settings-appearance-dark-label">
                        Dark mode
                      </div>
                      <p className="settings-toggle-desc" id="settings-appearance-dark-desc">
                        Use dark backgrounds and light text across the app.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      className="settings-switch"
                      aria-checked={theme === "dark"}
                      aria-labelledby="settings-appearance-dark-label"
                      aria-describedby="settings-appearance-dark-desc"
                      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                    >
                      <span className="settings-switch-thumb" aria-hidden />
                    </button>
                  </div>
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-row-text">
                      <div className="settings-toggle-title" id="settings-appearance-values-label">
                        Show original table values
                      </div>
                      <p className="settings-toggle-desc" id="settings-appearance-values-desc">
                        When off, tables use normalized values. Same as the Values control in the top bar.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      className="settings-switch"
                      aria-checked={valueMode === "original"}
                      aria-labelledby="settings-appearance-values-label"
                      aria-describedby="settings-appearance-values-desc"
                      onClick={() =>
                        setValueMode(valueMode === "original" ? "normalized" : "original")
                      }
                    >
                      <span className="settings-switch-thumb" aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeTab === "mcp" && (
            <section className="settings-pane settings-pane--mcp" aria-label="MCP">
              <McpTokenPanel embedded />
            </section>
          )}

          <p className="settings-back-link">
            <Link to="/">← Back to home</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

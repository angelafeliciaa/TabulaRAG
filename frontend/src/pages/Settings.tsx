import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAppUi } from "../appUiContext";
import McpTokenPanel from "../components/McpTokenPanel";
import UserGroupsSection from "../components/UserGroupsSection";
import WorkspaceAdminSection from "../components/WorkspaceAdminSection";
import {
  avatarPlaceholderStyle,
  deleteAccount,
  disbandEnterprise,
  fetchAuthMe,
  getUser,
  isAdmin,
  isOwner,
  leaveWorkspace,
  listMyWorkspaces,
  logout,
  patchStoredUser,
  renameWorkspace,
  switchWorkspace,
  updateDisplayName,
  type WorkspaceSummary,
} from "../api";

type SettingsTab = "account" | "workspace" | "groups" | "appearance" | "mcp";

const ALL_TABS: Array<{ id: SettingsTab; label: string; description: string; adminOnly?: boolean }> = [
  { id: "account", label: "Account", description: "Your profile and workspaces" },
  {
    id: "workspace",
    label: "Workspace",
    description: "Active workspace, members, and invites for this organization",
  },
  {
    id: "groups",
    label: "Groups",
    description: "User groups and their access to protected folders",
    adminOnly: true,
  },
  { id: "appearance", label: "Appearance", description: "Theme and table value display" },
  { id: "mcp", label: "MCP", description: "External tool access" },
];

function tabFromSearchParam(tab: string | null): SettingsTab | null {
  if (tab === "workspace" || tab === "appearance" || tab === "mcp" || tab === "account" || tab === "groups") {
    return tab;
  }
  return null;
}

export default function Settings() {
  const user = getUser();
  const navigate = useNavigate();
  const { theme, setTheme, valueMode, setValueMode, bumpSession, sessionRev } = useAppUi();
  const disbandNameInputRef = useRef<HTMLInputElement | null>(null);
  const leaveModalCancelRef = useRef<HTMLButtonElement | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    return tabFromSearchParam(searchParams.get("tab")) ?? "account";
  });
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [wsError, setWsError] = useState<string | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<number | null>(null);
  const [activeEnterpriseId, setActiveEnterpriseId] = useState<number | null>(
    () => getUser()?.enterprise_id ?? null,
  );
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);

  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameConfirmOpen, setRenameConfirmOpen] = useState(false);
  const [renamePendingName, setRenamePendingName] = useState<string | null>(null);
  const renameConfirmCancelRef = useRef<HTMLButtonElement | null>(null);

  const [disbandModalOpen, setDisbandModalOpen] = useState(false);
  const [disbandNameInput, setDisbandNameInput] = useState("");
  const [disbanding, setDisbanding] = useState(false);
  const [disbandError, setDisbandError] = useState<string | null>(null);

  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);

  const [authMe, setAuthMe] = useState<{ has_password: boolean; is_local: boolean; display_name: string } | null>(null);
  const [authMeError, setAuthMeError] = useState<string | null>(null);

  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Settings | TabulaRAG";
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAuthMeError(null);
    fetchAuthMe()
      .then((m) => {
        if (!cancelled) {
          setAuthMe(m);
          setNameDraft(m.display_name || "");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthMeError("Could not load account security settings.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionRev]);

  useEffect(() => {
    const fromUrl = tabFromSearchParam(searchParams.get("tab"));
    const next: SettingsTab = fromUrl ?? "account";
    setActiveTab((prev) => (prev === next ? prev : next));
  }, [searchParams]);

  function selectTab(tab: SettingsTab) {
    setActiveTab(tab);
    if (tab === "account") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab }, { replace: true });
    }
  }

  useEffect(() => {
    if (!user?.enterprise_id) {
      setWorkspaces([]);
      setWorkspacesLoading(false);
      setWsError(null);
      return;
    }
    let cancelled = false;
    setWorkspacesLoading(true);
    setWsError(null);
    listMyWorkspaces()
      .then((list) => {
        if (!cancelled) {
          setWorkspaces(list);
          setWorkspaceSwitchError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWsError("Could not load workspaces");
          setWorkspaces([]);
        }
      })
      .finally(() => {
        if (!cancelled) setWorkspacesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.enterprise_id, sessionRev]);

  useEffect(() => {
    setActiveEnterpriseId(getUser()?.enterprise_id ?? null);
  }, [sessionRev, user?.enterprise_id]);

  const workspacesSorted = useMemo(() => {
    return [...workspaces].sort((a, b) => {
      return a.enterprise_name.localeCompare(b.enterprise_name, undefined, { sensitivity: "base" });
    });
  }, [workspaces]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.enterprise_id === user?.enterprise_id) ?? null,
    [workspaces, user?.enterprise_id],
  );
  const activeWorkspaceName = activeWorkspace?.enterprise_name ?? "";

  useEffect(() => {
    setWorkspaceRenameDraft(activeWorkspaceName);
    setRenameError(null);
  }, [activeWorkspaceName]);

  const disbandNameMatches =
    activeWorkspaceName.length > 0 && disbandNameInput.trim() === activeWorkspaceName.trim();

  useEffect(() => {
    if (!disbandModalOpen) return;
    const t = window.setTimeout(() => disbandNameInputRef.current?.focus(), 50);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDisbandModalOpen(false);
        setDisbandNameInput("");
        setDisbandError(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [disbandModalOpen]);

  useEffect(() => {
    if (!leaveModalOpen) return;
    const t = window.setTimeout(() => leaveModalCancelRef.current?.focus(), 50);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !leaveBusy) {
        setLeaveModalOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [leaveModalOpen, leaveBusy]);

  useEffect(() => {
    if (!renameConfirmOpen) return;
    const t = window.setTimeout(() => renameConfirmCancelRef.current?.focus(), 50);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !renameBusy) {
        setRenameConfirmOpen(false);
        setRenamePendingName(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [renameConfirmOpen, renameBusy]);

  function workspaceRoleLabel(role: WorkspaceSummary["role"]): string {
    if (role === "owner") return "Owner";
    if (role === "admin") return "Admin";
    return "Member";
  }

  function handleLogout() {
    logout();
    window.location.replace("/");
  }

  async function handleConfirmDeleteAccount() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      if (authMe?.has_password) {
        await deleteAccount({ password: deletePassword });
      } else {
        await deleteAccount({ confirmation: deleteConfirmText });
      }
      logout();
      window.location.replace("/");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete account.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const TABS = ALL_TABS.filter((t) => !t.adminOnly || isAdmin());
  const tabMeta = TABS.find((t) => t.id === activeTab) ?? TABS[0];
  const workspaceId = user?.enterprise_id;

  async function handleRenameWorkspace() {
    const name = workspaceRenameDraft.trim();
    if (!name || name === activeWorkspaceName.trim()) return;
    setRenameError(null);
    setRenamePendingName(name);
    setRenameConfirmOpen(true);
  }

  async function handleConfirmRenameWorkspace() {
    const name = (renamePendingName ?? "").trim();
    if (!name || name === activeWorkspaceName.trim()) {
      setRenameConfirmOpen(false);
      setRenamePendingName(null);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await renameWorkspace(name);
      bumpSession();
      setRenameConfirmOpen(false);
      setRenamePendingName(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Failed to rename workspace");
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleConfirmDisbandWorkspace() {
    if (!disbandNameMatches || workspaceId == null) return;
    setDisbanding(true);
    setDisbandError(null);
    const leftId = user?.enterprise_id;
    try {
      await disbandEnterprise();
      const ws = await listMyWorkspaces();
      if (ws.length > 0) {
        const next =
          ws.find((w) => w.is_active) ?? ws.find((w) => w.enterprise_id !== leftId) ?? ws[0];
        await switchWorkspace(next.enterprise_id);
        bumpSession();
        navigate("/", { replace: true });
      } else {
        patchStoredUser({ enterprise_id: null, role: null });
        bumpSession();
        navigate("/onboarding", { replace: true });
      }
      setDisbandModalOpen(false);
      setDisbandNameInput("");
    } catch (err) {
      setDisbandError(err instanceof Error ? err.message : "Failed to disband workspace");
    } finally {
      setDisbanding(false);
    }
  }

  async function handleConfirmLeaveWorkspace() {
    if (workspaceId == null || !activeWorkspaceName) return;
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      const data = await leaveWorkspace();
      setLeaveModalOpen(false);
      bumpSession();
      if (data.enterprise_id == null) {
        navigate("/onboarding", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "Could not leave workspace");
    } finally {
      setLeaveBusy(false);
    }
  }

  return (
    <div className="settings-page">
      <div className="panel settings-shell">
        <Link
          to="/"
          className="settings-close"
          aria-label="Close settings and return home"
        >
          <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M5.47 5.47a.75.75 0 0 1 1.06 0L12 10.94l5.47-5.47a.75.75 0 1 1 1.06 1.06L13.06 12l5.47 5.47a.75.75 0 1 1-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 0 1 0-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </Link>
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
                  onClick={() => selectTab(tab.id)}
                >
                  <span className="settings-nav-item-label">{tab.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="settings-content">
          <div
            className="settings-content-tabpanel"
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
          >
            <header className="settings-content-header">
              <h1 className="settings-content-title">{tabMeta.label}</h1>
              <p className="settings-content-desc">{tabMeta.description}</p>
            </header>

            <div className="settings-content-scroll">
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
                  ) : (
                    <span
                      className="settings-account-avatar settings-account-avatar--placeholder"
                      style={user ? avatarPlaceholderStyle(user) : undefined}
                      aria-hidden
                    >
                      {(user?.name || user?.login || "?").trim().slice(0, 1).toUpperCase() || "?"}
                    </span>
                  )}
                  <div className="settings-account-meta">
                    <div className="settings-account-name">{user?.name || user?.login || "—"}</div>
                    <div className="small" style={{ opacity: 0.85 }}>
                      {user?.login}
                    </div>
                  </div>
                  <div className="settings-account-actions">
                    <button
                      type="button"
                      className="surface-btn"
                      disabled={!authMe}
                      onClick={() => {
                        setNameDraft(authMe?.display_name || user?.name || "");
                        setNameError(null);
                        setEditProfileOpen(true);
                      }}
                    >
                      Edit profile
                    </button>
                    <button type="button" className="logout-btn" onClick={handleLogout}>
                      Log out
                    </button>
                  </div>
                </div>

                <div className="settings-my-workspaces">
                  <h2 className="settings-subsection-title">My Workspaces</h2>
                  <p className="settings-subsection-desc">
                    All workspaces associated with your account.
                  </p>
                  {wsError ? (
                    <p className="login-error" role="alert">
                      {wsError}
                    </p>
                  ) : null}
                  {workspaceSwitchError ? (
                    <p className="login-error" role="alert">
                      {workspaceSwitchError}
                    </p>
                  ) : null}
                  {workspacesLoading ? (
                    <p className="settings-my-workspaces-muted">Loading workspaces…</p>
                  ) : workspacesSorted.length === 0 ? (
                    <p className="settings-my-workspaces-muted">
                      No workspaces found. You can create or join one below.
                    </p>
                  ) : (
                    <div className="settings-my-workspaces-list-scroll-outer">
                      <ul className="settings-my-workspaces-list" aria-label="Your workspaces">
                        {workspacesSorted.map((w) => {
                          const isCurrent = w.enterprise_id === activeEnterpriseId;
                          const busy = switchingWorkspaceId === w.enterprise_id;
                          return (
                            <li key={w.enterprise_id} className="settings-my-workspace-row">
                              <div className="settings-my-workspace-row-main">
                                <div className="settings-my-workspace-name">{w.enterprise_name}</div>
                                <div className="settings-my-workspace-role">
                                  {workspaceRoleLabel(w.role)}
                                  <span className="settings-my-workspace-member-count">
                                    {" · "}
                                    {w.member_count} {w.member_count === 1 ? "member" : "members"}
                                  </span>
                                </div>
                              </div>
                              {isCurrent ? (
                                <span className="settings-my-workspace-current-label">Current workspace</span>
                              ) : (
                                <button
                                  type="button"
                                  className="surface-btn settings-my-workspace-switch"
                                  disabled={switchingWorkspaceId != null}
                                  aria-busy={busy}
                                  onClick={() => {
                                    setWorkspaceSwitchError(null);
                                    setSwitchingWorkspaceId(w.enterprise_id);
                                    void switchWorkspace(w.enterprise_id)
                                      .then((data) => {
                                        setActiveEnterpriseId(data.enterprise_id);
                                        bumpSession();
                                      })
                                      .catch((err) => {
                                        setWorkspaceSwitchError(
                                          err instanceof Error ? err.message : "Could not switch workspace",
                                        );
                                      })
                                      .finally(() => setSwitchingWorkspaceId(null));
                                  }}
                                >
                                  {busy ? "Switching…" : "Switch"}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  <div className="settings-workspace-actions settings-my-workspaces-actions">
                    <Link className="settings-my-workspaces-add-link" to="/onboarding">
                      Add or join workspace
                    </Link>
                  </div>
                </div>

                <div className="settings-account-delete-section">
                  {authMeError ? (
                    <p className="login-error" role="alert">
                      {authMeError}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="settings-delete-account-open"
                    disabled={authMe === null}
                    title={authMe === null ? "Loading account security…" : undefined}
                    onClick={() => {
                      setDeleteError(null);
                      setDeletePassword("");
                      setDeleteConfirmText("");
                      setDeleteModalOpen(true);
                    }}
                  >
                    Delete account
                  </button>
                </div>
              </div>
            </section>
          )}

          {activeTab === "workspace" && (
            <section className="settings-pane" aria-label="Workspace">
              <div className="settings-section-body">
                <div className="settings-account-workspace settings-account-workspace--pane">
                  <div className="settings-workspace-active-summary small">
                    <strong>{activeWorkspaceName || "—"}</strong>
                    {" · "}
                    <span className="settings-workspace-active-summary-role">
                      Your role:{" "}
                      <strong>
                        {activeWorkspace ? workspaceRoleLabel(activeWorkspace.role) : "—"}
                      </strong>
                      {activeWorkspace?.role === "querier" ? " (member access)" : null}
                    </span>
                  </div>
                </div>

                {isOwner() && workspaceId != null ? (
                  <div className="settings-workspace-rename">
                    <label className="settings-workspace-rename-label" htmlFor="settings-workspace-rename-input">
                      Workspace name
                    </label>
                    <div className="settings-workspace-rename-row">
                      <input
                        id="settings-workspace-rename-input"
                        type="text"
                        className="input settings-workspace-rename-input"
                        maxLength={255}
                        value={workspaceRenameDraft}
                        onChange={(e) => setWorkspaceRenameDraft(e.target.value)}
                        aria-invalid={renameError ? true : undefined}
                      />
                      <button
                        type="button"
                        className="login-btn settings-workspace-rename-save"
                        disabled={
                          renameBusy
                          || !workspaceRenameDraft.trim()
                          || workspaceRenameDraft.trim() === activeWorkspaceName.trim()
                        }
                        onClick={() => void handleRenameWorkspace()}
                      >
                        {renameBusy ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {renameError ? (
                      <p className="login-error settings-workspace-rename-error" role="alert">
                        {renameError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {workspaceId != null ? (
                  <WorkspaceAdminSection
                    workspaceId={workspaceId}
                    isAdmin={isAdmin()}
                    viewerIsOwner={isOwner()}
                  />
                ) : null}

                {!isOwner() && workspaceId != null && activeWorkspaceName ? (
                  <footer className="settings-leave-footer">
                    {leaveError && !leaveModalOpen ? (
                      <p className="login-error settings-leave-footer-error" role="alert">
                        {leaveError}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="settings-leave-footer-btn"
                      disabled={leaveBusy}
                      onClick={() => {
                        setLeaveError(null);
                        setLeaveModalOpen(true);
                      }}
                    >
                      Leave workspace
                    </button>
                  </footer>
                ) : null}

                {isOwner() && activeWorkspaceName ? (
                  <footer className="settings-disband-footer">
                    <button
                      type="button"
                      className="settings-disband-footer-btn"
                      onClick={() => {
                        setDisbandError(null);
                        setDisbandNameInput("");
                        setDisbandModalOpen(true);
                      }}
                    >
                      Disband workspace
                    </button>
                  </footer>
                ) : null}
              </div>
            </section>
          )}

          {activeTab === "groups" && isAdmin() && (
            <section className="settings-pane" aria-label="Groups">
              <div className="settings-section-body">
                <UserGroupsSection />
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
                        When off, tables display normalized values.
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
            </div>
          </div>
        </div>
      </div>

      {editProfileOpen ? (
        <div className="settings-modal-backdrop" role="presentation" aria-hidden="true">
          <div
            className="settings-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-edit-profile-title"
          >
            <h2 id="settings-edit-profile-title" className="settings-modal-title">
              Edit profile
            </h2>
            <label className="settings-workspace-rename-label" htmlFor="settings-edit-profile-name">
              Display name
            </label>
            <input
              id="settings-edit-profile-name"
              type="text"
              className="input settings-modal-input"
              maxLength={255}
              placeholder="Your name"
              autoComplete="name"
              value={nameDraft}
              onChange={(e) => {
                setNameDraft(e.target.value);
                setNameError(null);
              }}
              disabled={nameSaving}
            />
            {nameError ? (
              <p className="login-error" role="alert">{nameError}</p>
            ) : null}
            <div className="settings-modal-actions">
              <button
                type="button"
                className="surface-btn"
                disabled={nameSaving}
                onClick={() => {
                  setEditProfileOpen(false);
                  setNameError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="login-btn"
                disabled={
                  nameSaving
                  || !nameDraft.trim()
                  || nameDraft.trim() === (authMe?.display_name || "").trim()
                }
                onClick={async () => {
                  setNameSaving(true);
                  setNameError(null);
                  try {
                    const result = await updateDisplayName(nameDraft.trim());
                    setAuthMe((prev) => prev ? { ...prev, display_name: result.display_name } : prev);
                    bumpSession();
                    setEditProfileOpen(false);
                  } catch (err) {
                    setNameError(err instanceof Error ? err.message : "Failed to update name");
                  } finally {
                    setNameSaving(false);
                  }
                }}
              >
                {nameSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteModalOpen ? (
        <div className="settings-modal-backdrop" role="presentation" aria-hidden="true">
          <div
            className="settings-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-delete-account-title"
          >
            <h2 id="settings-delete-account-title" className="settings-modal-title">
              Delete your account?
            </h2>
            <p className="settings-modal-body">
              {authMe?.has_password
                ? <>This action is permanent. Enter your <strong>password</strong> to confirm.</>
                : <>This action is permanent. Type <strong>DELETE</strong> to confirm.</>}
            </p>
            {authMe?.has_password ? (
              <input
                type="password"
                className="input settings-modal-input"
                placeholder="password"
                autoComplete="current-password"
                value={deletePassword}
                onChange={(ev) => setDeletePassword(ev.target.value)}
                disabled={deleteBusy}
              />
            ) : (
              <input
                type="text"
                className="input settings-modal-input"
                placeholder="Type DELETE"
                autoComplete="off"
                value={deleteConfirmText}
                onChange={(ev) => setDeleteConfirmText(ev.target.value)}
                disabled={deleteBusy}
              />
            )}
            {deleteError ? (
              <p className="login-error" role="alert">
                {deleteError}
              </p>
            ) : null}
            <div className="settings-modal-actions">
              <button
                type="button"
                className="surface-btn"
                disabled={deleteBusy}
                onClick={() => {
                  setDeleteModalOpen(false);
                  setDeleteError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-modal-disband-confirm"
                disabled={deleteBusy}
                onClick={() => void handleConfirmDeleteAccount()}
              >
                {deleteBusy ? "Deleting…" : "Delete account"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {disbandModalOpen ? (
        <div className="settings-modal-backdrop" role="presentation" aria-hidden="true">
          <div
            className="settings-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-disband-dialog-title"
          >
            <h2 id="settings-disband-dialog-title" className="settings-modal-title">
              Disband workspace?
            </h2>
            <p className="settings-modal-body">
              This permanently deletes the workspace <strong>{activeWorkspaceName}</strong>, all datasets in it, and all
              memberships. This cannot be undone.
            </p>
            <p className="settings-modal-body settings-modal-body--muted">
              Type the workspace name exactly to confirm:
            </p>
            <input
              ref={disbandNameInputRef}
              type="text"
              className="input settings-modal-input"
              autoComplete="off"
              placeholder={activeWorkspaceName}
              value={disbandNameInput}
              onChange={(e) => setDisbandNameInput(e.target.value)}
              aria-label="Workspace name to confirm disband"
            />
            {disbandError ? (
              <p className="login-error" role="alert">
                {disbandError}
              </p>
            ) : null}
            <div className="settings-modal-actions">
              <button
                type="button"
                className="surface-btn"
                disabled={disbanding}
                onClick={() => {
                  setDisbandModalOpen(false);
                  setDisbandNameInput("");
                  setDisbandError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-modal-disband-confirm"
                disabled={!disbandNameMatches || disbanding}
                onClick={() => void handleConfirmDisbandWorkspace()}
              >
                {disbanding ? "Disbanding…" : "Disband workspace"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {leaveModalOpen ? (
        <div className="settings-modal-backdrop" role="presentation" aria-hidden="true">
          <div
            className="settings-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-leave-dialog-title"
          >
            <h2 id="settings-leave-dialog-title" className="settings-modal-title">
              Leave workspace?
            </h2>
            <p className="settings-modal-body">
              You will lose access to <strong>{activeWorkspaceName}</strong> until someone invites you again. This does
              not delete the workspace or its data.
            </p>
            {leaveError ? (
              <p className="login-error" role="alert">
                {leaveError}
              </p>
            ) : null}
            <div className="settings-modal-actions">
              <button
                ref={leaveModalCancelRef}
                type="button"
                className="surface-btn"
                disabled={leaveBusy}
                onClick={() => {
                  setLeaveModalOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-modal-disband-confirm"
                disabled={leaveBusy}
                onClick={() => void handleConfirmLeaveWorkspace()}
              >
                {leaveBusy ? "Leaving…" : "Leave workspace"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameConfirmOpen ? (
        <div className="settings-modal-backdrop" role="presentation" aria-hidden="true">
          <div
            className="settings-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-rename-confirm-title"
          >
            <h2 id="settings-rename-confirm-title" className="settings-modal-title">
              Update workspace name?
            </h2>
            <p className="settings-modal-body">
              Change workspace name to <strong>{renamePendingName || workspaceRenameDraft.trim()}</strong>?
            </p>
            {renameError ? (
              <p className="login-error" role="alert">
                {renameError}
              </p>
            ) : null}
            <div className="settings-modal-actions">
              <button
                ref={renameConfirmCancelRef}
                type="button"
                className="surface-btn"
                disabled={renameBusy}
                onClick={() => {
                  setRenameConfirmOpen(false);
                  setRenamePendingName(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="login-btn"
                disabled={renameBusy}
                onClick={() => void handleConfirmRenameWorkspace()}
              >
                {renameBusy ? "Updating…" : "Update"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

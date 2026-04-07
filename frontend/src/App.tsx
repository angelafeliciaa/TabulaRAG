import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppUiProvider, useAppUi } from "./appUiContext";
import {
  getUser,
  isAuthenticated,
  listMyWorkspaces,
  logout,
  redirectToGoogleSignIn,
  switchWorkspace,
  type WorkspaceSummary,
} from "./api";
import logo from "./images/logo-64.webp";
import logoutIcon from "./images/logout.png";
import switchIcon from "./images/switch.png";
import HighlightView from "./pages/HighlightView";
import TableView from "./pages/TableView";
import Upload from "./pages/Upload";
import AggregateTableView from "./pages/AggregateTable";
import AuthCallback from "./pages/AuthCallback";
import Login from "./pages/Login";
import Onboarding from "./pages/Onboarding";
import Settings from "./pages/Settings";

function AuthGuard({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) return <Login />;
  return <>{children}</>;
}

function EnterpriseGuard({ children }: { children: React.ReactNode }) {
  const user = getUser();
  if (!user?.enterprise_id) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function workspaceRoleLabel(role: WorkspaceSummary["role"]): string {
  if (role === "owner") {
    return "Owner";
  }
  if (role === "admin") {
    return "Admin";
  }
  if (role === "querier") {
    return "Member";
  }
  return "";
}

function AppContent() {
  const location = useLocation();
  const { sessionRev, bumpSession, headerNotice } = useAppUi();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);

  const user = getUser();
  const workspaceKey = `${user?.enterprise_id ?? "none"}-${sessionRev}`;
  const onHomePage = location.pathname === "/";
  const onSettingsPage = location.pathname === "/settings";
  const onDatasetTablePage = location.pathname.startsWith("/tables/") && location.pathname !== "/tables/virtual";
  const showWorkspaceSwitcher = Boolean(onHomePage && user?.enterprise_id);
  const showInlineTableHeader = !onHomePage && onDatasetTablePage;
  const useIconOnlyBrand = onSettingsPage || onDatasetTablePage;

  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const workspaceMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMenuId = useId();
  const accountMenuId = useId();

  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const accountMenuButtonRef = useRef<HTMLButtonElement | null>(null);

  const currentWorkspace = useMemo(
    () => workspaces.find((w) => w.enterprise_id === user?.enterprise_id) ?? null,
    [workspaces, user?.enterprise_id],
  );

  const currentWorkspaceRoleLabel = currentWorkspace
    ? workspaceRoleLabel(currentWorkspace.role)
    : null;

  const workspaceToggleTitle = currentWorkspace
    ? `${currentWorkspace.enterprise_name} · ${currentWorkspaceRoleLabel}`
    : "Workspace";

  const workspaceToggleLabel = workspaces.length === 0
    ? "Workspace"
    : "Select workspace";

  useEffect(() => {
    if (!isAuthenticated()) {
      queueMicrotask(() => setWorkspaces([]));
      return;
    }
    const u = getUser();
    if (!u?.enterprise_id) {
      queueMicrotask(() => setWorkspaces([]));
      return;
    }
    let cancelled = false;
    listMyWorkspaces()
      .then((list) => {
        if (!cancelled) {
          setWorkspaces(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaces([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionRev, user?.enterprise_id]);

  useEffect(() => {
    if (!workspaceMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (workspaceMenuWrapRef.current && !workspaceMenuWrapRef.current.contains(target)) {
        setWorkspaceMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuOpen(false);
        workspaceMenuButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [workspaceMenuOpen]);

  useEffect(() => {
    if (!accountMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accountMenuWrapRef.current && !accountMenuWrapRef.current.contains(target)) {
        setAccountMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
        accountMenuButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    queueMicrotask(() => {
      setAccountMenuOpen(false);
      setWorkspaceMenuOpen(false);
    });
  }, [location.pathname, location.search]);

  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (location.pathname === "/") {
      document.title = "Home | TabulaRAG";
    }
  }, [location.pathname]);

  useEffect(() => {
    let pointerActive = false;
    function handlePointerDown() {
      pointerActive = true;
    }
    function handleKeyDown() {
      pointerActive = false;
    }
    function handleFocusIn(e: FocusEvent) {
      if (!pointerActive) return;
      const el = e.target as Node;
      if (
        el &&
        el instanceof HTMLElement &&
        (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button")
      ) {
        requestAnimationFrame(() => el.blur());
      }
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
    };
  }, []);

  function handleAccountLogout() {
    setAccountMenuOpen(false);
    logout();
    window.location.replace("/");
  }

  async function handleSwitchAccount() {
    setAccountMenuOpen(false);
    logout();
    try {
      await redirectToGoogleSignIn({ prompt: "select_account" });
    } catch {
      window.location.replace("/");
    }
  }

  const topBarControls =
    isAuthenticated() && user ? (
      <div className="user-menu user-menu--compact">
        {showWorkspaceSwitcher && (
          <div className="sort-menu-wrap top-bar-workspace-menu-wrap" ref={workspaceMenuWrapRef}>
            <button
              ref={workspaceMenuButtonRef}
              type="button"
              className={`sort-toggle-button top-bar-workspace-toggle ${workspaceMenuOpen ? "active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={workspaceMenuOpen}
              aria-controls={workspaceMenuOpen ? workspaceMenuId : undefined}
              aria-label={`Workspace: ${workspaceToggleTitle}. Open menu to switch or add a workspace.`}
              title={workspaceToggleTitle}
              onClick={() => {
                setAccountMenuOpen(false);
                setWorkspaceMenuOpen((open) => !open);
              }}
            >
              {currentWorkspace ? (
                <span className="sort-toggle-text top-bar-workspace-toggle-text top-bar-workspace-label">
                  <span className="top-bar-workspace-name">{currentWorkspace.enterprise_name}</span>
                  <span
                    className={`top-bar-workspace-role-badge top-bar-workspace-role-badge--${currentWorkspace.role}`}
                  >
                    {currentWorkspaceRoleLabel}
                  </span>
                </span>
              ) : (
                <span className="sort-toggle-text top-bar-workspace-toggle-text">{workspaceToggleLabel}</span>
              )}
              <svg
                viewBox="0 0 24 24"
                width={14}
                height={14}
                className="top-bar-workspace-chevron"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  fill="currentColor"
                  d="M7 10l5 5 5-5H7z"
                />
              </svg>
            </button>
            {workspaceMenuOpen && (
              <div
                id={workspaceMenuId}
                className="sort-menu top-bar-workspace-menu"
                role="menu"
                aria-label="Workspace actions"
              >
                {workspaces.map((w) => (
                  <button
                    key={w.enterprise_id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={w.enterprise_id === user.enterprise_id}
                    className={`sort-menu-item ${w.enterprise_id === user.enterprise_id ? "active" : ""}`}
                    onClick={() => {
                      if (w.enterprise_id === user.enterprise_id) {
                        setWorkspaceMenuOpen(false);
                        return;
                      }
                      void switchWorkspace(w.enterprise_id).then(() => {
                        bumpSession();
                        setWorkspaceMenuOpen(false);
                      });
                    }}
                  >
                    <span className="top-bar-workspace-menu-item">
                      <span className="top-bar-workspace-name">{w.enterprise_name}</span>
                      <span className={`top-bar-workspace-role-badge top-bar-workspace-role-badge--${w.role}`}>
                        {workspaceRoleLabel(w.role)}
                      </span>
                    </span>
                  </button>
                ))}
                {workspaces.length > 0 ? (
                  <div className="top-bar-workspace-menu-sep" aria-hidden="true" />
                ) : null}
                <Link
                  to="/onboarding"
                  role="menuitem"
                  className="sort-menu-item top-bar-workspace-menu-add"
                  onClick={() => setWorkspaceMenuOpen(false)}
                >
                  Add or join workspace
                </Link>
              </div>
            )}
          </div>
        )}
        <div className="sort-menu-wrap top-bar-account-menu-wrap" ref={accountMenuWrapRef}>
          <button
            ref={accountMenuButtonRef}
            type="button"
            className={`top-bar-account-trigger${accountMenuOpen ? " top-bar-account-trigger--open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            aria-controls={accountMenuOpen ? accountMenuId : undefined}
            aria-label={`Account menu (${user.name || user.login})`}
            onClick={() => {
              setWorkspaceMenuOpen(false);
              setAccountMenuOpen((open) => !open);
            }}
          >
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" className="user-avatar" />
            ) : (
              <span className="user-avatar user-avatar--placeholder" aria-hidden>
                {(user.name || user.login || "?").trim().slice(0, 1).toUpperCase() || "?"}
              </span>
            )}
          </button>
          {accountMenuOpen ? (
            <div
              id={accountMenuId}
              className="sort-menu top-bar-account-menu"
              role="menu"
              aria-label="Account"
            >
              <div className="top-bar-account-menu-header" role="presentation">
                <span className="top-bar-account-name" title={user.name || user.login || undefined}>
                  {user.name || user.login}
                </span>
                {user.name && user.login !== user.name ? (
                  <span className="top-bar-account-login" title={user.login}>
                    {user.login}
                  </span>
                ) : null}
              </div>
              <div className="top-bar-workspace-menu-sep" aria-hidden="true" />
              <Link
                to="/settings"
                role="menuitem"
                className={`sort-menu-item top-bar-account-menu-link${onSettingsPage ? " top-bar-account-menu-link--active" : ""}`}
                onClick={() => setAccountMenuOpen(false)}
              >
                <span className="top-bar-account-menu-item-content">
                  <svg
                    viewBox="0 0 24 24"
                    width={16}
                    height={16}
                    className="top-bar-account-menu-icon"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      fill="currentColor"
                      d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.52-.4-1.08-.73-1.69-.98l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.61.25-1.17.59-1.69.98l-2.39-.96a.5.5 0 0 0-.6.22l-1.92 3.32a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.52.4 1.08.73 1.69.98l.36 2.54c.03.24.24.42.49.42h3.84c.25 0 .46-.18.49-.42l.36-2.54c.61-.25 1.17-.59 1.69-.98l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
                    />
                  </svg>
                  <span>Settings</span>
                </span>
              </Link>
              <button type="button" role="menuitem" className="sort-menu-item top-bar-account-menu-action" onClick={() => void handleSwitchAccount()}>
                <span className="top-bar-account-menu-item-content">
                  <img
                    src={switchIcon}
                    alt=""
                    aria-hidden="true"
                    className="top-bar-account-menu-icon top-bar-account-menu-icon-image"
                  />
                  <span>Switch account</span>
                </span>
              </button>
              <div className="top-bar-workspace-menu-sep" aria-hidden="true" />
              <button type="button" role="menuitem" className="sort-menu-item top-bar-account-menu-action top-bar-account-menu-logout" onClick={handleAccountLogout}>
                <span className="top-bar-account-menu-item-content">
                  <img
                    src={logoutIcon}
                    alt=""
                    aria-hidden="true"
                    className="top-bar-account-menu-icon top-bar-account-menu-icon-image top-bar-account-menu-icon-image--logout"
                  />
                  <span>Log out</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    ) : null;

  return (
    <div className="app-shell">
      {!onHomePage && !showInlineTableHeader && (
        <Link
          className={`app-brand${useIconOnlyBrand ? " app-brand--icon-only" : ""}`}
          to="/"
          aria-label="Go to home"
        >
          <img src={logo} alt="" aria-hidden="true" />
          {!useIconOnlyBrand ? (
            <span className="app-brand-text">TabulaRAG</span>
          ) : null}
        </Link>
      )}

      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      {isAuthenticated() && user && !onHomePage && !showInlineTableHeader && (
        <div
          className={`top-bar top-bar--compact${showWorkspaceSwitcher ? " top-bar--with-workspace-switch" : ""}`}
        >
          {topBarControls}
        </div>
      )}

      {isAuthenticated() && user && showInlineTableHeader && (
        <div className="table-shell-top-row">
          <Link className="app-brand app-brand--icon-only app-brand--inline" to="/" aria-label="Go to home">
            <img src={logo} alt="" aria-hidden="true" />
          </Link>
          {headerNotice ? (
            <div className="table-view-edit-mode-banner app-shell-edit-mode-banner" role="note" aria-label="Edit mode hint">
              <span className="table-view-edit-mode-banner__label">{headerNotice.label}</span>
              <span className="table-view-edit-mode-banner__text">{headerNotice.text}</span>
            </div>
          ) : (
            <div className="table-shell-top-row-spacer" aria-hidden="true" />
          )}
          <div className="top-bar top-bar--compact top-bar--inline">
            {topBarControls}
          </div>
        </div>
      )}

      <main id="main-content" className="content" tabIndex={-1}>
        <Routes>
          <Route
            path="/"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <Upload key={workspaceKey} homeControls={topBarControls} />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/tables/virtual"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <AggregateTableView key={workspaceKey} />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/tables/:datasetId"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <TableView key={workspaceKey} />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/highlight/:highlightId"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <HighlightView key={workspaceKey} />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/onboarding"
            element={
              <AuthGuard>
                <Onboarding />
              </AuthGuard>
            }
          />
          <Route
            path="/settings"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <Settings />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/admin"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <Navigate to="/settings?tab=workspace" replace />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/auth/callback"
            element={<AuthCallback />}
          />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppUiProvider>
      <AppContent />
    </AppUiProvider>
  );
}

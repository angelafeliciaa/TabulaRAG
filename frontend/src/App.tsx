import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { logout, getUser, isAuthenticated, isAdmin } from "./api";
import logo from "./images/logo-64.webp";
import moonIcon from "./images/moon.png";
import sunIcon from "./images/sun.png";
import HighlightView from "./pages/HighlightView";
import TableView from "./pages/TableView";
import Upload from "./pages/Upload";
import AggregateTableView from "./pages/AggregateTable";
import AuthCallback from "./pages/AuthCallback";
import Login from "./pages/Login";
import Onboarding from "./pages/Onboarding";
import Admin from "./pages/Admin";
import { type ValueMode } from "./valueMode";

function AuthGuard({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) return <Login />;
  return <>{children}</>;
}

function EnterpriseGuard({ children }: { children: React.ReactNode }) {
  const user = getUser();
  if (!user?.enterprise_id) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  if (!isAdmin()) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [location.pathname, location.search]);

  // Set tab title for the home page.
  useEffect(() => {
    if (location.pathname === "/") {
      document.title = "Home | TabulaRAG";
    }
  }, [location.pathname]);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const storedTheme = window.localStorage.getItem("theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme;
    }
    return "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("theme", theme);
  }, [theme]);
  const [valueMode, setValueMode] = useState<ValueMode>(() => {
    const storedValueMode = window.localStorage.getItem("valueMode");
    if (storedValueMode === "normalized" || storedValueMode === "original") {
      return storedValueMode;
    }
    return "normalized";
  });
  useEffect(() => {
    window.localStorage.setItem("valueMode", valueMode);
  }, [valueMode]);

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

  const user = getUser();

  function handleLogout() {
    logout();
    window.location.replace("/");
  }

  return (
    <div className="app-shell">
      {location.pathname !== "/" && (
        <Link className="app-brand" to="/" aria-label="Go to home">
          <img src={logo} alt="" aria-hidden="true" />
          <span className="app-brand-text">TabulaRAG</span>
        </Link>
      )}

      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <div className="top-bar">
        <div className="user-menu">
          {user?.avatar_url && (
            <img src={user.avatar_url} alt="" className="user-avatar" />
          )}
          <span className="user-name">{user?.name || user?.login}</span>
          {isAdmin() && (
            <Link className="surface-btn" to="/admin" style={{ fontSize: "0.8rem", padding: "0.2rem 0.7rem" }}>
              Admin
            </Link>
          )}
          <button
            className="logout-btn"
            onClick={handleLogout}
            type="button"
          >
            Sign out
          </button>
        </div>

        <label className="global-value-mode-toggle">
          <span className="global-value-mode-label">Values:</span>
          <select
            value={valueMode}
            onChange={(event) => setValueMode(event.target.value as ValueMode)}
            aria-label="Show original or normalized values"
          >
            <option value="normalized">Normalized</option>
            <option value="original">Original</option>
          </select>
        </label>
        <button
          className="theme-toggle"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          aria-pressed={theme === "dark"}
          type="button"
        >
          <span className="sr-only">
            {theme === "dark" ? "Dark theme enabled" : "Light theme enabled"}
          </span>
          <span className="toggle-track">
            <span className="toggle-thumb">
              <img src={theme === "dark" ? moonIcon : sunIcon} alt="" />
            </span>
          </span>
        </button>
      </div>

      <main id="main-content" className="content" tabIndex={-1}>
        <Routes>
          <Route
            path="/"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <Upload valueMode={valueMode} />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/tables/virtual"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <AggregateTableView valueMode={valueMode} />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/tables/:datasetId"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <TableView valueMode={valueMode} />
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route
            path="/highlight/:highlightId"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <HighlightView />
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
            path="/admin"
            element={
              <AuthGuard>
                <EnterpriseGuard>
                  <AdminGuard>
                    <Admin />
                  </AdminGuard>
                </EnterpriseGuard>
              </AuthGuard>
            }
          />
          <Route path="/auth/callback" element={<AuthCallback onLogin={() => {}} />} />
        </Routes>
      </main>
    </div>
  );
}

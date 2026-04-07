import { useEffect, useState } from "react";
import logo64 from "../images/logo-64.webp";
import logo128 from "../images/logo-128.webp";
import { redirectToGoogleSignIn } from "../api";

const TABULARAG_REPO_URL = "https://github.com/angelafeliciaa/tabulaRAG";
type LoginIntroPhase = "active" | "exiting" | "done";

export default function Login() {
  const [introPhase, setIntroPhase] = useState<LoginIntroPhase>(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return "done";
    }
    return "active";
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (introPhase !== "active") {
      return;
    }
    const exitTimer = window.setTimeout(() => setIntroPhase("exiting"), 760);
    const doneTimer = window.setTimeout(() => setIntroPhase("done"), 1380);
    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(doneTimer);
    };
  }, [introPhase]);

  async function handleGoogleLogin() {
    setLoading(true);
    setError(null);
    try {
      await redirectToGoogleSignIn();
    } catch {
      setError("Failed to start Google login. Is the server running?");
      setLoading(false);
    }
  }

  return (
    <div className="login-page login-page--split" data-intro-phase={introPhase}>
      {introPhase !== "done" ? (
        <div className="login-intro-splash" aria-hidden="true">
          <img
            src={logo64}
            srcSet={`${logo64} 1x, ${logo128} 2x`}
            width={128}
            height={128}
            alt=""
            className="login-intro-logo"
          />
        </div>
      ) : null}
      <div className="login-split-panel">
        <section className="login-split-overview" aria-labelledby="login-overview-heading">
          <div className="login-split-overview-brand">
            <img
              src={logo64}
              srcSet={`${logo64} 1x, ${logo128} 2x`}
              width={64}
              height={64}
              alt=""
              className="login-split-overview-logo"
            />
            <h1 id="login-overview-heading" className="login-split-overview-title">
              TabulaRAG
            </h1>
          </div>
          <p className="login-split-overview-tagline">
            Fast-ingesting tabular data RAG with cell-level citations
          </p>
          <ul className="login-split-overview-list">
            <li>Fast uploads for CSV and TSV files.</li>
            <li>Connect with your LLM of choice and query tables in natural language.</li>
            <li>Traceable answers with direct cell highlights.</li>
            <li>Workspaces for teams with role-based access.</li>
            <li>Customizable folders for building knowledge bases.</li>
          </ul>
          <a
            className="login-repo-btn"
            href={TABULARAG_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="TabulaRAG on GitHub (opens in a new tab)"
          >
            <svg
              className="login-repo-github-icon"
              viewBox="0 0 24 24"
              width={18}
              height={18}
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.113.793-.258.793-.577 0-.285-.014-1.23-.015-2.235-3.338.726-4.042-1.416-4.042-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.466-1.334-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.135-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.96-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.823 1.096.823 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.694.801.576C20.565 21.795 24 17.31 24 12c0-6.63-5.37-12-12-12z"
              />
            </svg>
            View on GitHub
          </a>
        </section>

        <div className="login-split-auth">
          <div className="login-auth-card">
            <h2 className="login-auth-title">Sign in</h2>
            <p className="login-auth-subtitle">Use your Google account to continue</p>
            {error ? (
              <p className="login-error" role="alert">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              className="login-btn login-btn-google login-btn-google--large"
              onClick={handleGoogleLogin}
              disabled={loading}
            >
              <svg
                className="github-icon"
                viewBox="0 0 24 24"
                width={22}
                height={22}
                aria-hidden="true"
              >
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              {loading ? "Redirecting…" : "Sign in with Google"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

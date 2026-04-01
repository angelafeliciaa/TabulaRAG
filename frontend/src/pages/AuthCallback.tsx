import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppUi } from "../appUiContext";
import { exchangeGoogleCode } from "../api";

export default function AuthCallback() {
  const { bumpSession } = useAppUi();
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const code = new URLSearchParams(window.location.search).get("code");
  const redirectUri = `${window.location.origin}/auth/callback`;

  useEffect(() => {
    if (!code) return;

    exchangeGoogleCode(code, redirectUri)
      .then((data) => {
        bumpSession();
        if (data.onboarding_required) {
          navigate("/onboarding", { replace: true });
        } else {
          navigate("/", { replace: true });
        }
      })
      .catch(() => {
        setError("Google authentication failed. Please try again.");
      });
  }, [code, bumpSession, navigate, redirectUri]);

  if (!code) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-error" role="alert">
            No authorization code received from Google.
          </p>
          <button
            type="button"
            className="login-btn"
            onClick={() => navigate("/", { replace: true })}
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="login-btn"
            onClick={() => navigate("/", { replace: true })}
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <p className="login-subtitle" role="status" aria-live="polite">
          Signing in with Google...
        </p>
      </div>
    </div>
  );
}

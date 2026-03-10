import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { exchangeGithubCode } from "../api";

interface AuthCallbackProps {
  onLogin: () => void;
}

export default function AuthCallback({ onLogin }: AuthCallbackProps) {
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    if (!code) {
      setError("No authorization code received from GitHub.");
      return;
    }

    exchangeGithubCode(code)
      .then(() => {
        onLogin();
        navigate("/", { replace: true });
      })
      .catch(() => {
        setError("GitHub authentication failed. Please try again.");
      });
  }, [onLogin, navigate]);

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-error">{error}</p>
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
        <p className="login-subtitle">Signing in with GitHub...</p>
      </div>
    </div>
  );
}

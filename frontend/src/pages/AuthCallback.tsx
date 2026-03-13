import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { exchangeGithubCode, exchangeGoogleCode } from "../api";

interface AuthCallbackProps {
  onLogin: () => void;
}

export default function AuthCallback({ onLogin }: AuthCallbackProps) {
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const provider = params.get("provider") || "github";

  useEffect(() => {
    if (!code) return;

    async function exchange() {
      try {
        if (provider === "google") {
          const redirectUri = `${window.location.origin}/auth/callback?provider=google`;
          await exchangeGoogleCode(code!, redirectUri);
        } else {
          await exchangeGithubCode(code!);
        }
        onLogin();
        navigate("/", { replace: true });
      } catch {
        setError(`${provider === "google" ? "Google" : "GitHub"} authentication failed. Please try again.`);
      }
    }

    exchange();
  }, [code, provider, onLogin, navigate]);

  if (!code) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-error">No authorization code received.</p>
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
        <p className="login-subtitle">
          Signing in with {provider === "google" ? "Google" : "GitHub"}...
        </p>
      </div>
    </div>
  );
}

import { type FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { resetPasswordWithToken } from "../api";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const tokenFromUrl = useMemo(() => (searchParams.get("token") || "").trim(), [searchParams]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (!tokenFromUrl) {
      setError("Missing reset token. Open the link from your email.");
      return;
    }
    setLoading(true);
    try {
      const r = await resetPasswordWithToken(tokenFromUrl, password);
      setDoneMessage(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page login-page--split" data-intro-phase="done">
      <div className="login-split-panel">
        <div className="login-split-auth">
          <div className="login-auth-card">
            <h2 className="login-auth-title">Set new password</h2>
            <p className="login-auth-subtitle">Choose a new password for your account.</p>
            {error ? (
              <p className="login-error" role="alert">
                {error}
              </p>
            ) : null}
            {doneMessage ? (
              <p className="settings-subsection-desc" role="status">
                {doneMessage}
              </p>
            ) : null}
            {!doneMessage ? (
              <form className="login-form" onSubmit={(ev) => void onSubmit(ev)}>
                <label className="login-field-label login-password-wrap">
                  <span className="sr-only">New password</span>
                  <input
                    type="password"
                    className="login-input login-input--password"
                    autoComplete="new-password"
                    placeholder="New password"
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    disabled={loading}
                    minLength={8}
                    required
                  />
                </label>
                <label className="login-field-label login-password-wrap">
                  <span className="sr-only">Confirm password</span>
                  <input
                    type="password"
                    className="login-input login-input--password"
                    autoComplete="new-password"
                    placeholder="Confirm password"
                    value={confirm}
                    onChange={(ev) => setConfirm(ev.target.value)}
                    disabled={loading}
                    minLength={8}
                    required
                  />
                </label>
                <button type="submit" className="login-btn" disabled={loading || !tokenFromUrl}>
                  {loading ? "Please wait…" : "Update password"}
                </button>
              </form>
            ) : null}
            <p className="login-auth-switch" style={{ marginTop: "1rem" }}>
              <Link to="/" className="login-auth-switch-btn">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppUi } from "../appUiContext";
import {
  forgotPasswordRequest,
  INVALID_EMAIL_MESSAGE,
  isGoogleAccountExists,
  isRegisterPending,
  isValidEmailShape,
  loginWithEmail,
  redirectToGoogleSignIn,
  registerWithEmail,
  resendVerificationEmail,
  verifyEmailWithCode,
} from "../api";
import logo64 from "../images/logo-64.webp";
import logo128 from "../images/logo-128.webp";

const TABULARAG_REPO_URL = "https://github.com/angelafeliciaa/tabulaRAG";
const VERIFY_CODE_LEN = 6;

function emptyVerifyCodeDigits(): string[] {
  return Array.from({ length: VERIFY_CODE_LEN }, () => "");
}

type LoginIntroPhase = "active" | "exiting" | "done";
type AuthMode = "signin" | "signup" | "forgot";
type SignupStep = "form" | "verify" | "google_found";

function IconEyeOpen() {
  return (
    <svg className="login-password-toggle-icon" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"
      />
      <circle cx={12} cy={12} r={3} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

function IconEyeClosed() {
  return (
    <svg className="login-password-toggle-icon" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"
      />
      <path fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" d="M1 1l22 22" />
    </svg>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { bumpSession } = useAppUi();
  const [introPhase, setIntroPhase] = useState<LoginIntroPhase>(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return "done";
    }
    return "active";
  });
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [signupStep, setSignupStep] = useState<SignupStep>("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [codeDigits, setCodeDigits] = useState<string[]>(() => emptyVerifyCodeDigits());
  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [verifyHint, setVerifyHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [forgotDoneMessage, setForgotDoneMessage] = useState<string | null>(null);
  const [googleFoundMessage, setGoogleFoundMessage] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendLoading, setResendLoading] = useState(false);

  const signupFormComplete = useMemo(() => {
    const em = email.trim();
    return (
      firstName.trim().length > 0 &&
      isValidEmailShape(em) &&
      password.length >= 8 &&
      password === confirmPassword
    );
  }, [firstName, email, password, confirmPassword]);

  const verifyCodeComplete = useMemo(
    () =>
      codeDigits.length === VERIFY_CODE_LEN &&
      codeDigits.every((d) => /^\d$/.test(d)),
    [codeDigits],
  );

  useEffect(() => {
    const st = location.state as { openForgotPassword?: boolean } | null;
    if (st?.openForgotPassword) {
      setAuthMode("forgot");
      setForgotDoneMessage(null);
      setError(null);
      navigate(".", { replace: true, state: {} });
    }
  }, [location.state, navigate]);

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

  useEffect(() => {
    if (resendCooldown <= 0) {
      return;
    }
    const id = window.setInterval(() => {
      setResendCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendCooldown > 0]);

  useEffect(() => {
    if (authMode === "signup" && signupStep === "verify") {
      requestAnimationFrame(() => codeInputRefs.current[0]?.focus());
    }
  }, [authMode, signupStep]);

  function focusVerifyDigit(index: number) {
    requestAnimationFrame(() => {
      codeInputRefs.current[index]?.focus();
      codeInputRefs.current[index]?.select();
    });
  }

  function handleVerifyDigitChange(index: number, value: string) {
    const digitsOnly = value.replace(/\D/g, "");
    if (digitsOnly.length > 1) {
      const next = emptyVerifyCodeDigits();
      for (let i = 0; i < Math.min(digitsOnly.length, VERIFY_CODE_LEN); i++) {
        next[i] = digitsOnly[i]!;
      }
      setCodeDigits(next);
      focusVerifyDigit(Math.min(digitsOnly.length, VERIFY_CODE_LEN - 1));
      return;
    }
    const digit = digitsOnly.slice(-1);
    setCodeDigits((prev) => {
      const next = [...prev];
      next[index] = digit;
      return next;
    });
    if (digit && index < VERIFY_CODE_LEN - 1) {
      focusVerifyDigit(index + 1);
    }
  }

  function handleVerifyDigitKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      if (codeDigits[index]) {
        return;
      }
      if (index > 0) {
        e.preventDefault();
        focusVerifyDigit(index - 1);
      }
      return;
    }
    if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      focusVerifyDigit(index - 1);
    }
    if (e.key === "ArrowRight" && index < VERIFY_CODE_LEN - 1) {
      e.preventDefault();
      focusVerifyDigit(index + 1);
    }
  }

  function handleVerifyCodePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, VERIFY_CODE_LEN);
    if (!text) {
      return;
    }
    const next = emptyVerifyCodeDigits();
    for (let i = 0; i < text.length; i++) {
      next[i] = text[i]!;
    }
    setCodeDigits(next);
    const focusIdx = Math.min(text.length, VERIFY_CODE_LEN - 1);
    focusVerifyDigit(focusIdx);
  }

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

  function clearPasswordFields() {
    setPassword("");
    setConfirmPassword("");
  }

  async function handleEmailSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter your email address.");
      if (authMode === "signin" || authMode === "signup") {
        clearPasswordFields();
      }
      return;
    }
    if (!isValidEmailShape(trimmedEmail)) {
      setError(INVALID_EMAIL_MESSAGE);
      if (authMode === "signin" || authMode === "signup") {
        clearPasswordFields();
      }
      return;
    }
    if (authMode === "signup") {
      if (!firstName.trim()) {
        setError("Enter your first name.");
        return;
      }
      if (password.length < 8) {
        setError("Password must be at least 8 characters.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
    }
    setLoading(true);
    try {
      if (authMode === "signup") {
        const f = firstName.trim();
        const l = lastName.trim();
        const combinedName = l ? `${f} ${l}` : f;
        const reg = await registerWithEmail({
          email: trimmedEmail,
          password,
          name: combinedName,
        });
        if (isGoogleAccountExists(reg)) {
          setSignupStep("google_found");
          setGoogleFoundMessage(reg.message);
          setError(null);
          setLoading(false);
          return;
        }
        if (isRegisterPending(reg)) {
          setSignupStep("verify");
          setCodeDigits(emptyVerifyCodeDigits());
          setResendCooldown(30);
          if (reg.email_sent) {
            setError(null);
            setVerifyHint(`We sent a 6-digit code to ${reg.email}`);
          } else {
            setVerifyHint(null);
            setError(
              `Email was not sent — configure SMTP in the backend .env and restart, or find your verification code in the backend logs for ${reg.email}.`,
            );
          }
          setLoading(false);
          return;
        }
        bumpSession();
        navigate(reg.onboarding_required ? "/onboarding" : "/", { replace: true });
        return;
      }
      const data = await loginWithEmail(trimmedEmail, password);
      bumpSession();
      navigate(data.onboarding_required ? "/onboarding" : "/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      if (authMode === "signin" || authMode === "signup") {
        clearPasswordFields();
      }
      setLoading(false);
    }
  }

  async function handleVerifySubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedEmail = email.trim();
    if (!isValidEmailShape(trimmedEmail)) {
      setError(INVALID_EMAIL_MESSAGE);
      clearPasswordFields();
      return;
    }
    const digits = codeDigits.join("");
    if (digits.length !== VERIFY_CODE_LEN || !/^\d{6}$/.test(digits)) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setLoading(true);
    try {
      const data = await verifyEmailWithCode(trimmedEmail, digits);
      bumpSession();
      navigate(data.onboarding_required ? "/onboarding" : "/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      clearPasswordFields();
      setLoading(false);
    }
  }

  async function handleForgotSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter your email address.");
      clearPasswordFields();
      return;
    }
    if (!isValidEmailShape(trimmedEmail)) {
      setError(INVALID_EMAIL_MESSAGE);
      clearPasswordFields();
      return;
    }
    setLoading(true);
    try {
      const r = await forgotPasswordRequest(trimmedEmail);
      setForgotDoneMessage(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      clearPasswordFields();
    } finally {
      setLoading(false);
    }
  }

  function backToSignInFromForgot() {
    setAuthMode("signin");
    setForgotDoneMessage(null);
    setError(null);
  }

  async function handleResendCode() {
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter your email address.");
      clearPasswordFields();
      return;
    }
    if (!isValidEmailShape(trimmedEmail)) {
      setError(INVALID_EMAIL_MESSAGE);
      clearPasswordFields();
      return;
    }
    if (resendCooldown > 0 || resendLoading) {
      return;
    }
    setResendLoading(true);
    try {
      const r = await resendVerificationEmail(
        trimmedEmail,
        authMode === "signup" && signupStep === "verify" && password ? password : undefined,
      );
      setResendCooldown(30);
      if (r.email_sent) {
        setError(null);
        setVerifyHint(`We resent a 6-digit code to ${r.email}.`);
      } else {
        setVerifyHint(null);
        setError(
          `Email was not sent — the server has no outbound SMTP (or sending failed). Check backend logs for your verification code for ${r.email}. Configure SMTP_HOST and Brevo credentials in the backend .env, then restart.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      clearPasswordFields();
    } finally {
      setResendLoading(false);
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
            <h1
              id="login-overview-heading"
              className="login-split-overview-title"
              aria-label="TabulaRAG"
            >
              <span className="upload-home-brand__title-tabula">Tabula</span>
              <span className="upload-home-brand__title-rag">
                <span className="upload-home-brand__title-r">R</span>AG
              </span>
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
            <h2 className="login-auth-title">
              {authMode === "signup" && signupStep === "verify"
                ? "Verify your email"
                : authMode === "signup" && signupStep === "google_found"
                  ? "Account found"
                  : authMode === "forgot"
                    ? "Forgot password"
                    : authMode === "signin"
                      ? "Sign in"
                      : "Create account"}
            </h2>
            <p className="login-auth-subtitle">
              {authMode === "signup" && signupStep === "verify"
                ? verifyHint ||
                  (email.trim()
                    ? `We sent a 6-digit code to ${email.trim()}`
                    : "We sent a 6-digit code to your email")
                : authMode === "signup" && signupStep === "google_found"
                  ? googleFoundMessage ||
                    "This email is already registered with Google. Sign in with Google to continue—the password you entered will be saved for email sign-in too."
                : authMode === "forgot"
                  ? forgotDoneMessage ||
                    "Enter the email for your account. If it exists and uses a password, we will send reset instructions."
                  : authMode === "signin"
                    ? "Use your email or Google account"
                    : "Create a TabulaRAG account with your email"}
            </p>
            <div className="login-auth-error-slot" aria-live="polite">
              {error ? (
                <p className="login-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            {authMode === "signup" && signupStep === "verify" ? (
              <form className="login-form" onSubmit={handleVerifySubmit} noValidate>
                <div
                  className="login-verify-code-row"
                  role="group"
                  aria-label="6-digit verification code"
                >
                  {Array.from({ length: VERIFY_CODE_LEN }, (_, i) => (
                    <input
                      key={i}
                      ref={(el) => {
                        codeInputRefs.current[i] = el;
                      }}
                      id={i === 0 ? "login-verify-code-0" : undefined}
                      type="text"
                      inputMode="numeric"
                      autoComplete={i === 0 ? "one-time-code" : "off"}
                      aria-label={`Digit ${i + 1} of ${VERIFY_CODE_LEN}`}
                      className="login-input login-verify-code-digit"
                      maxLength={1}
                      value={codeDigits[i] ?? ""}
                      onChange={(e) => handleVerifyDigitChange(i, e.target.value)}
                      onKeyDown={(e) => handleVerifyDigitKeyDown(i, e)}
                      onPaste={handleVerifyCodePaste}
                      disabled={loading}
                    />
                  ))}
                </div>
                <button type="submit" className="login-btn" disabled={loading || !verifyCodeComplete}>
                  {loading ? "Please wait…" : "Verify"}
                </button>
                <button
                  type="button"
                  className="login-btn login-btn-secondary"
                  disabled={loading || resendLoading || resendCooldown > 0}
                  aria-busy={resendLoading}
                  onClick={() => void handleResendCode()}
                >
                  {resendLoading
                    ? "Sending…"
                    : resendCooldown > 0
                      ? `Resend code (${resendCooldown}s)`
                      : "Resend code"}
                </button>
                <button
                  type="button"
                  className="login-auth-switch-btn login-verify-back"
                  disabled={loading || resendLoading}
                  onClick={() => {
                    setSignupStep("form");
                    setCodeDigits(emptyVerifyCodeDigits());
                    setVerifyHint(null);
                    setGoogleFoundMessage(null);
                    setResendCooldown(0);
                    setError(null);
                    setEmail("");
                    clearPasswordFields();
                  }}
                >
                  Use another email
                </button>
              </form>
            ) : authMode === "signup" && signupStep === "google_found" ? (
              <div className="login-form">
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
                <button
                  type="button"
                  className="login-auth-switch-btn login-verify-back"
                  disabled={loading}
                  onClick={() => {
                    setSignupStep("form");
                    setGoogleFoundMessage(null);
                    setError(null);
                    setEmail("");
                    setFirstName("");
                    setLastName("");
                    clearPasswordFields();
                  }}
                >
                  Use another email
                </button>
              </div>
            ) : authMode === "forgot" ? (
              forgotDoneMessage ? (
                <div className="login-form">
                  <button
                    type="button"
                    className="login-btn login-btn-secondary"
                    onClick={backToSignInFromForgot}
                  >
                    Back to sign in
                  </button>
                </div>
              ) : (
                <form className="login-form" onSubmit={handleForgotSubmit} noValidate>
                  <label className="login-field-label">
                    <span className="sr-only">Email</span>
                    <input
                      type="email"
                      className="login-input"
                      autoComplete="email"
                      placeholder="Email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </label>
                  <button
                    type="submit"
                    className="login-btn"
                    disabled={loading || !email.trim()}
                  >
                    {loading ? "Please wait…" : "Send reset link"}
                  </button>
                  <button
                    type="button"
                    className="login-auth-switch-btn login-verify-back"
                    disabled={loading}
                    onClick={backToSignInFromForgot}
                  >
                    Back to sign in
                  </button>
                </form>
              )
            ) : (
              <form className="login-form" onSubmit={handleEmailSubmit} noValidate>
                {authMode === "signup" ? (
                  <div className="login-name-row">
                    <label className="login-field-label login-name-field">
                      <span className="sr-only">First name (required)</span>
                      <input
                        type="text"
                        className="login-input"
                        autoComplete="given-name"
                        placeholder="First"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        disabled={loading}
                        required
                        aria-required={true}
                      />
                    </label>
                    <label className="login-field-label login-name-field">
                      <span className="sr-only">Last name (optional)</span>
                      <input
                        type="text"
                        className="login-input"
                        autoComplete="family-name"
                        placeholder="Last (optional)"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        disabled={loading}
                      />
                    </label>
                  </div>
                ) : null}
                <label className="login-field-label">
                  <span className="sr-only">Email</span>
                  <input
                    type="email"
                    className="login-input"
                    autoComplete="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    required
                  />
                </label>
                <div className="login-field-label login-password-wrap">
                  <span className="sr-only">Password</span>
                  <input
                    type={showPassword ? "text" : "password"}
                    className="login-input login-input--password"
                    autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    required
                    minLength={authMode === "signup" ? 8 : undefined}
                  />
                  <button
                    type="button"
                    className="login-password-toggle icon-button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                    disabled={loading}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <IconEyeClosed /> : <IconEyeOpen />}
                  </button>
                </div>
                {authMode === "signin" ? (
                  <p className="login-forgot-password-row">
                    <button
                      type="button"
                      className="login-auth-switch-btn"
                      onClick={() => {
                        setAuthMode("forgot");
                        setForgotDoneMessage(null);
                        setError(null);
                      }}
                    >
                      Forgot password?
                    </button>
                  </p>
                ) : null}
                {authMode === "signup" ? (
                  <div className="login-field-label login-password-wrap">
                    <span className="sr-only">Confirm password</span>
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      className="login-input login-input--password"
                      autoComplete="new-password"
                      placeholder="Confirm password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={loading}
                      required
                      minLength={8}
                    />
                    <button
                      type="button"
                      className="login-password-toggle icon-button"
                      aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                      title={showConfirmPassword ? "Hide password" : "Show password"}
                      disabled={loading}
                      onClick={() => setShowConfirmPassword((v) => !v)}
                    >
                      {showConfirmPassword ? <IconEyeClosed /> : <IconEyeOpen />}
                    </button>
                  </div>
                ) : null}
                <button
                  type="submit"
                  className="login-btn"
                  disabled={
                    loading ||
                    (authMode === "signup" && !signupFormComplete) ||
                    (authMode === "signin" && (!email.trim() || password.length === 0))
                  }
                >
                  {loading
                    ? "Please wait…"
                    : authMode === "signin"
                      ? "Sign in"
                      : "Create account"}
                </button>
              </form>
            )}

            {authMode !== "forgot" &&
            !(authMode === "signup" && (signupStep === "google_found" || signupStep === "verify")) ? (
            <div className="login-auth-card-footer">
              <p className="login-auth-divider" aria-hidden="true">
                or
              </p>

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

              <p className="login-auth-switch">
                {authMode === "signin" ? (
                  <>
                    New here?{" "}
                    <button
                      type="button"
                      className="login-auth-switch-btn"
                      onClick={() => {
                        setAuthMode("signup");
                        setSignupStep("form");
                        setError(null);
                        setVerifyHint(null);
                        setCodeDigits(emptyVerifyCodeDigits());
                        setGoogleFoundMessage(null);
                        setForgotDoneMessage(null);
                        setShowPassword(false);
                        setShowConfirmPassword(false);
                      }}
                    >
                      Create an account
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{" "}
                    <button
                      type="button"
                      className="login-auth-switch-btn"
                      onClick={() => {
                        setAuthMode("signin");
                        setSignupStep("form");
                        setError(null);
                        setVerifyHint(null);
                        setCodeDigits(emptyVerifyCodeDigits());
                        setGoogleFoundMessage(null);
                        setConfirmPassword("");
                        setFirstName("");
                        setLastName("");
                        setForgotDoneMessage(null);
                        setShowPassword(false);
                        setShowConfirmPassword(false);
                      }}
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

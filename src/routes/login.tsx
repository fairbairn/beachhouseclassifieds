import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";

import { redirectIfSessionExists } from "@/core/auth/auth-guards";
import { loginWithProxy } from "@/core/client/auth/auth-proxy";

export const Route = createFileRoute("/login")({
  beforeLoad: (ctx) => redirectIfSessionExists(ctx),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [passwordBlurred, setPasswordBlurred] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedEmail = email.trim().toLowerCase();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const passwordValid = password.length >= 8;
  const canSubmit = emailValid && passwordValid && !submitting;

  const emailError =
    emailBlurred && email.length > 0 && !emailValid
      ? "Please enter a valid email address"
      : null;
  const passwordError =
    passwordBlurred && password.length > 0 && !passwordValid
      ? "Password must be at least 8 characters"
      : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      setEmailBlurred(true);
      setPasswordBlurred(true);
      return;
    }

    setSubmitting(true);
    setError(null);

    const result = await loginWithProxy({
      email: normalizedEmail,
      password,
    });

    if (!result.ok) {
      setError(result.message);
      setSubmitting(false);
      return;
    }

    await navigate({ to: "/", replace: true });
  }

  return (
    <section className="login-page">
      <div className="card login-card">
        <h1 style={{ marginTop: 0, marginBottom: "0.35rem" }}>Sign in</h1>
        <p style={{ marginTop: 0, color: "#64748b", fontSize: "0.92rem" }}>
          Continue to your workspace.
        </p>

        <form className="form-stack" onSubmit={onSubmit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onBlur={() => setEmailBlurred(true)}
              onChange={(event) => setEmail(event.target.value)}
            />
            {emailError ? (
              <p className="error-text field-error">{emailError}</p>
            ) : null}
          </label>

          <label>
            Password
            <div className="password-input-wrap">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onBlur={() => setPasswordBlurred(true)}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="password-visibility-button"
                onClick={() => setShowPassword((previous) => !previous)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {passwordError ? (
              <p className="error-text field-error">{passwordError}</p>
            ) : null}
          </label>

          {error ? <p className="error-text">{error}</p> : null}

          <p
            className={`form-status ${canSubmit ? "is-ready" : ""}`}
            aria-live="polite"
          >
            {canSubmit
              ? "Form looks good. You can sign in."
              : "Complete a valid email and an 8+ character password to continue."}
          </p>

          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </section>
  );
}

function EyeIcon() {
  return (
    <svg className="field-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle
        cx="12"
        cy="12"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg className="field-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2 2l20 20M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-4.4M9.9 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10.5 7 10.5 7a19 19 0 0 1-4.1 4.9M6.1 6.1A19.8 19.8 0 0 0 1.5 12s4 7 10.5 7a10.8 10.8 0 0 0 4.1-.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

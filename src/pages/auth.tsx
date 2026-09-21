import { useState, type FormEvent } from "react";
import { ArrowRight, Layers3, ShieldCheck } from "lucide-react";
import type { AuthStatus } from "../../shared/types";
import { api, message } from "../lib/api";
import { Button, ErrorNotice } from "../components/ui/primitives";
export function AuthPage({
  status,
  reload,
}: {
  status: AuthStatus;
  reload: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      await api(`/api/auth/${status.setupRequired ? "setup" : "login"}`, {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(data)),
      });
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand">
          <Layers3 /> Threadline
        </div>
        <div>
          <span className="eyebrow">LESS FRICTION. MORE FORWARD.</span>
          <h1>
            Great work starts
            <br />
            with a clear thread.
          </h1>
          <p>
            A thoughtful space for your projects, issues, and the conversations
            that move them forward.
          </p>
          <div className="story-lines">
            <span />
            <span />
            <span />
          </div>
        </div>
        <small>Built for teams that build together.</small>
      </section>
      <section className="auth-main">
        <div className="auth-card">
          <div className="brand mobile-brand">
            <Layers3 /> Threadline
          </div>
          <div className="auth-icon">
            <ShieldCheck />
          </div>
          <h2>
            {status.setupRequired
              ? "Make this workspace yours"
              : "Welcome back"}
          </h2>
          <p className="muted">
            {status.setupRequired
              ? "Create the first administrator account to get started."
              : "Sign in to pick up where you left off."}
          </p>
          <form onSubmit={submit} className="form-stack">
            {status.setupRequired && (
              <label>
                Full name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                maxLength={254}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={
                  status.setupRequired ? "new-password" : "current-password"
                }
                required
                minLength={status.setupRequired ? 12 : 1}
                maxLength={1024}
              />
            </label>
            {status.setupRequired && (
              <small className="muted">
                Use at least 12 characters. Keep this local administrator
                account as your recovery access if single sign-on is
                unavailable.
              </small>
            )}
            <ErrorNotice error={error} />
            <Button disabled={busy}>
              {busy
                ? "Please wait…"
                : status.setupRequired
                  ? "Create workspace"
                  : "Sign in"}
              <ArrowRight size={16} />
            </Button>
          </form>
          {!status.setupRequired && status.oidc.enabled && (
            <>
              <div className="divider">or continue with</div>
              <a
                className="btn btn-secondary full-width"
                href="/api/auth/oidc/login"
              >
                Sign in with {status.oidc.name || "single sign-on"}
              </a>
            </>
          )}
          <p className="auth-footnote">Your team’s work, all in one place.</p>
        </div>
      </section>
    </main>
  );
}

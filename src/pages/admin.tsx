import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck, UserPlus } from "lucide-react";
import type { OidcSettings } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Loading } from "../components/ui/primitives";
export function AdminPage() {
  const { user, refresh, users } = useWorkspace();
  const [settings, setSettings] = useState<OidcSettings | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (user.role !== "admin") return;
    setError("");
    api<OidcSettings>("/api/admin/oidc")
      .then(setSettings)
      .catch((e) => setError(message(e)));
  }, [user.role, retry]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { enabled, name, issuer, clientId, allowSignup } = settings;
      setSettings(
        await api<OidcSettings>("/api/admin/oidc", {
          method: "PUT",
          body: JSON.stringify({
            enabled,
            name,
            issuer,
            clientId,
            allowSignup,
            ...(secret ? { clientSecret: secret } : {}),
          }),
        }),
      );
      setSecret("");
      setNotice("Single sign-on settings saved.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      form.reset();
      await refresh();
      setNotice("Local user created. Share their credentials securely.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (user.role !== "admin")
    return (
      <div className="empty-state">
        <ShieldCheck />
        <h1>Administrator access required</h1>
        <p>Contact your workspace administrator to manage authentication.</p>
      </div>
    );
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE SETTINGS</span>
          <h1>Administration</h1>
          <p className="muted">A secure workspace. A connected team.</p>
        </div>
      </header>
      <ErrorNotice error={error} />
      <p className="success" role="status">
        {notice}
      </p>
      <div className="admin-grid">
        <section className="settings-card">
          <h2>
            <ShieldCheck size={20} />
            Single sign-on
          </h2>
          <p className="muted">
            Connect your team’s OpenID Connect identity provider.
          </p>
          {!settings ? (
            error ? (
              <Button onClick={() => setRetry((v) => v + 1)}>
                Retry settings
              </Button>
            ) : (
              <Loading />
            )
          ) : (
            <form onSubmit={save} className="form-stack">
              <fieldset disabled={busy}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) =>
                      setSettings({ ...settings, enabled: e.target.checked })
                    }
                  />
                  Enable OIDC login
                </label>
                <label>
                  Provider name
                  <input
                    maxLength={100}
                    value={settings.name}
                    onChange={(e) =>
                      setSettings({ ...settings, name: e.target.value })
                    }
                    placeholder="Company SSO"
                    required
                  />
                </label>
                <label>
                  Issuer URL
                  <input
                    type="url"
                    value={settings.issuer}
                    onChange={(e) =>
                      setSettings({ ...settings, issuer: e.target.value })
                    }
                    required={settings.enabled}
                    placeholder="https://identity.example.com"
                  />
                </label>
                <label>
                  Client ID
                  <input
                    value={settings.clientId}
                    onChange={(e) =>
                      setSettings({ ...settings, clientId: e.target.value })
                    }
                    required={settings.enabled}
                  />
                </label>
                <label>
                  Client secret
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={
                      settings.hasClientSecret
                        ? "Secret saved — leave blank to keep"
                        : "Enter client secret"
                    }
                  />
                </label>
                <label>
                  Callback URL
                  <input readOnly value={settings.callbackUrl} />
                </label>
                <small className="muted">
                  Register this exact callback URL with your identity provider.
                  A blank client secret preserves the saved secret.
                </small>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.allowSignup}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        allowSignup: e.target.checked,
                      })
                    }
                  />
                  Allow new users to join through SSO
                </label>
                <Button disabled={busy}>
                  {busy ? "Saving…" : "Save OIDC settings"}
                </Button>
              </fieldset>
            </form>
          )}
        </section>
        <div>
          <section className="recovery-note">
            <ShieldCheck size={22} />
            <div>
              <h3>Keep a way back in</h3>
              <p>
                Local email and password login remains available when SSO is
                enabled. Keep your first administrator’s credentials secure so
                you can recover access if your identity provider is unavailable.
              </p>
            </div>
          </section>
          <section className="settings-card">
            <h2>
              <UserPlus size={20} />
              Create local user
            </h2>
            <p className="muted">
              Add a member who can collaborate on all projects and issues.
            </p>
            <form className="form-stack" onSubmit={create}>
              <label>
                Full name
                <input
                  name="name"
                  maxLength={100}
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                Email address
                <input
                  name="email"
                  maxLength={254}
                  type="email"
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                Temporary password
                <input
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  maxLength={1024}
                  autoComplete="new-password"
                />
              </label>
              <small className="muted">
                Use at least 12 characters and share credentials securely.
              </small>
              <Button disabled={busy}>Create user</Button>
            </form>
          </section>
          <section className="settings-card">
            <h2>
              Members <span className="count">{users.length}</span>
            </h2>
            {users.map((u) => (
              <div className="member-row" key={u.id}>
                <span className="avatar">{u.name.slice(0, 1)}</span>
                <div>
                  <strong>{u.name}</strong>
                  <small>{u.email}</small>
                </div>
                <span className="tag">{u.role}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </>
  );
}

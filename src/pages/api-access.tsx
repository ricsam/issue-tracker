import { useEffect, useState, type FormEvent } from "react";
import type { ApiKeyInfo } from "../../shared/api-access";
import { api, message } from "../lib/api";
import { Button, ErrorNotice, Loading, Modal } from "../components/ui/primitives";
import "./api-access.css";

const date = (value: string) => new Date(value).toLocaleString();
export function ApiAccessPage() {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [revoke, setRevoke] = useState<ApiKeyInfo | null>(null);
  async function load() {
    setError("");
    try { setKeys((await api<{ keys: ApiKeyInfo[] }>("/api/me/api-keys")).keys); }
    catch (e) { setError(message(e)); }
  }
  useEffect(() => { void load(); }, []);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError("");
    try {
      const result = await api<{ key: ApiKeyInfo; token: string }>("/api/me/api-keys", {
        method: "POST", body: JSON.stringify({ name: data.get("name"), scopes: data.get("scopes") === "write" ? ["read", "write"] : ["read"], expiresInDays: Number(data.get("days")) }),
      });
      setKeys(current => [result.key, ...(current || [])]);
      setCopied(false); setCopyError(""); setToken(result.token); form.reset();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  async function copyToken() {
    setCopyError("");
    try { await navigator.clipboard.writeText(token); setCopied(true); }
    catch { setCopyError("Could not copy. Select and copy the token manually before dismissing."); }
  }
  async function confirmRevoke() {
    if (!revoke || busy) return;
    setBusy(true); setError("");
    try {
      await api(`/api/me/api-keys/${encodeURIComponent(revoke.id)}`, { method: "DELETE" });
      setRevoke(null); await load();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <section className="api-access-page">
    <header><h1>API access</h1><p className="muted">Manage personal API keys and CLI access. Keys act as you and never grant more access than your account.</p></header>
    {!revoke && <ErrorNotice error={error} />}
    <section className="access-panel" aria-labelledby="create-key-title">
      <h2 id="create-key-title">Create API key</h2>
      <form className="form-stack" onSubmit={create}>
        <label>Key name<input name="name" required maxLength={100} placeholder="My integration" /></label>
        <label>Permissions<select name="scopes" defaultValue="read"><option value="read">Read only</option><option value="write">Read and write</option></select></label>
        <label>Expires in (days)<input name="days" type="number" min={1} max={365} required defaultValue={90} /></label>
        <Button disabled={busy || !keys}>Create key</Button>
      </form>
    </section>
    <section aria-labelledby="your-keys-title"><h2 id="your-keys-title">Your keys</h2>
      {!keys ? error ? <Button onClick={() => void load()}>Retry loading keys</Button> : <Loading /> : !keys.length ? <p className="muted">No API keys yet.</p> : <ul className="access-key-list">{keys.map(key => {
        const state = key.revokedAt ? "Revoked" : new Date(key.expiresAt).getTime() <= Date.now() ? "Expired" : "Active";
        return <li className="access-panel" key={key.id}><div className="access-key-heading"><h3>{key.name}</h3><span>{state}</span></div>
          <code>{key.prefix}…</code>
          <dl className="access-metadata"><dt>Permissions</dt><dd>{key.scopes.includes("write") ? "Read and write" : "Read only"}</dd><dt>Source</dt><dd>{key.source === "cli" ? "CLI" : "Manual"}</dd><dt>Created</dt><dd>{date(key.createdAt)}</dd><dt>Expires</dt><dd>{date(key.expiresAt)}</dd><dt>Last used</dt><dd>{key.lastUsedAt ? date(key.lastUsedAt) : "Never"}</dd>{key.revokedAt && <><dt>Revoked</dt><dd>{date(key.revokedAt)}</dd></>}</dl>
          {!key.revokedAt && <Button variant="secondary" disabled={busy} onClick={() => { setError(""); setRevoke(key); }}>Revoke {key.name}</Button>}
        </li>;
      })}</ul>}
    </section>
    <Modal title="Copy your API key now" description="This token is shown only once. Save it somewhere secure before dismissing this dialog. Treat it like a password." open={!!token} onOpenChange={open => { if (!open) { setToken(""); setCopyError(""); } }}>
      <label className="form-stack">API key token<textarea className="access-token" readOnly value={token} /></label>
      <ErrorNotice error={copyError} />
      <div className="access-actions"><Button onClick={() => void copyToken()}>{copied ? "Copied" : "Copy token"}</Button><Button variant="secondary" onClick={() => setToken("")}>I saved it — dismiss</Button></div>
    </Modal>
    <Modal title="Revoke API key?" description={`Revoke “${revoke?.name || ""}”? Applications using this key will immediately lose access. This cannot be undone.`} open={!!revoke} onOpenChange={open => { if (!open && !busy) setRevoke(null); }}>
      <ErrorNotice error={error} /><div className="access-actions"><Button disabled={busy} onClick={() => void confirmRevoke()}>Confirm revocation</Button><Button variant="secondary" disabled={busy} onClick={() => setRevoke(null)}>Cancel</Button></div>
    </Modal>
  </section>;
}

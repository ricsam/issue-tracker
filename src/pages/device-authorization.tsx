import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import type { DeviceRequestInfo } from "../../shared/api-access";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice } from "../components/ui/primitives";
import "./api-access.css";

export function normalizeUserCode(value: string): string {
  const compact = value.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-HJ-NP-Z2-9]{8}$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : "";
}
export function DeviceAuthorizationPage() {
  const { user } = useWorkspace();
  const location = useLocation();
  const initialCode = normalizeUserCode(new URLSearchParams(location.search).get("user_code") || "");
  const [code, setCode] = useState(initialCode);
  const [request, setRequest] = useState<DeviceRequestInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  useEffect(() => {
    let active = true;
    setCode(initialCode); setRequest(null); setResult(""); setError(""); setBusy(false);
    if (!initialCode) return;
    setBusy(true);
    void api<DeviceRequestInfo>(`/api/auth/device/request?user_code=${encodeURIComponent(initialCode)}`)
      .then(info => { if (active) setRequest(info); })
      .catch(e => { if (active) setError(message(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [initialCode]);
  async function lookup(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setRequest(null); setResult(""); setError("");
    const normalized = normalizeUserCode(code);
    if (!normalized) { setError("Enter the eight-letter/number code from your terminal, for example ABCD-EFGH."); return; }
    setCode(normalized); setBusy(true);
    try { setRequest(await api<DeviceRequestInfo>(`/api/auth/device/request?user_code=${encodeURIComponent(normalized)}`)); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  async function decide(approve: boolean) {
    if (!request || busy) return;
    setBusy(true); setError("");
    try {
      await api("/api/auth/device/approve", { method: "POST", body: JSON.stringify({ userCode: request.userCode, approve }) });
      setRequest(null); setResult(approve ? "CLI access approved. Return to your terminal to finish signing in." : "CLI access denied. Return to your terminal.");
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <section className="api-access-page">
    <header><h1>Authorize CLI access</h1><p>Signed in as <strong>{user.name}</strong> ({user.email})</p></header>
    <aside className="access-warning"><strong>Only approve a sign-in you initiated.</strong><p>Compare the code below with your own terminal. Never approve a code someone sent you or a request you do not recognize. Approving grants access to your account.</p></aside>
    <ErrorNotice error={error} />
    {result ? <p role="status">{result}</p> : <>
      <form className="form-stack access-panel" onSubmit={lookup}>
        <label>Terminal code<input autoComplete="off" spellCheck={false} name="userCode" value={code} onChange={e => { setCode(e.target.value); setRequest(null); }} placeholder="ABCD-EFGH" required disabled={busy} /></label>
        <Button disabled={busy}>{busy ? "Please wait…" : "Review request"}</Button>
      </form>
      {request && <section className="access-panel" aria-labelledby="request-title">
        <h2 id="request-title">Review CLI request</h2>
        <p>Terminal code: <strong className="access-device-code">{request.userCode}</strong></p>
        <dl className="access-metadata"><dt>Requesting name (unverified)</dt><dd>{request.name}</dd><dt>Permissions</dt><dd>{request.scopes.includes("write") ? "Read and write" : "Read only"}</dd><dt>Key duration</dt><dd>{request.tokenExpiresInDays} days</dd><dt>Request expires</dt><dd>{new Date(request.expiresAt).toLocaleString()}</dd></dl>
        <p className="muted">The requesting name is supplied by the CLI and is not verified. These permissions apply to resources your account can access. You can revoke access later in API access.</p>
        <div className="access-actions"><Button disabled={busy} onClick={() => void decide(true)}>Approve CLI access</Button><Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>Deny access</Button></div>
      </section>}
    </>}
  </section>;
}

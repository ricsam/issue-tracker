import { useEffect, useState, type FormEvent } from "react";
import type { PluginAdminSettings, PluginField } from "../../shared/plugins";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Loading } from "./ui/primitives";
import { useNotification } from "./ui/snackbar";
import "./plugins.css";

function initialValues(plugin: PluginAdminSettings): Record<string, unknown> {
  return Object.fromEntries(plugin.fields.map((field) => [field.name, field.type === "secret" ? "" : plugin.values[field.name] ?? (field.type === "project-table" ? [] : "")]));
}
function PluginForm({ plugin, onSaved }: { plugin: PluginAdminSettings; onSaved: (plugin: PluginAdminSettings) => void }) {
  const { projects } = useWorkspace();
  const notify = useNotification();
  const [enabled, setEnabled] = useState(plugin.enabled);
  const [values, setValues] = useState(() => initialValues(plugin));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ plugin: PluginAdminSettings }>(`/api/admin/plugins/${encodeURIComponent(plugin.id)}`, { method: "PUT", body: JSON.stringify({ enabled, values }) });
      setEnabled(result.plugin.enabled);
      setValues(initialValues(result.plugin));
      onSaved(result.plugin);
      notify(`${plugin.name} settings saved.`);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  function fieldControl(field: PluginField) {
    if (field.type === "project-table") {
      const rows = (Array.isArray(values[field.name]) ? values[field.name] : []) as Record<string, string>[];
      const editRow = (index: number, name: string, value: string) => update(field.name, rows.map((row, i) => i === index ? { ...row, [name]: value } : row));
      return <fieldset className="plugin-project-table" key={field.name}>
        <legend>{field.label}</legend>
        {rows.map((row, index) => <div className="plugin-project-row" key={index}>
          <label>Project
            <select aria-label={`Project ${index + 1}`} value={row.projectId || ""} required={enabled} onChange={(event) => editRow(index, "projectId", event.target.value)}>
              <option value="">Choose project</option>
              {row.projectId && !projects.some((project) => project.id === row.projectId) && <option value={row.projectId}>Unavailable project</option>}
              {projects.map((project) => <option key={project.id} value={project.id} disabled={rows.some((other, i) => i !== index && other.projectId === project.id)}>{project.name}</option>)}
            </select>
          </label>
          {(field.columns || []).filter((column) => column.name !== "projectId").map((column) => <label key={column.name}>{column.label}
            <input aria-label={`${column.label} ${index + 1}`} type={column.type} value={row[column.name] || ""} required={enabled} onChange={(event) => editRow(index, column.name, event.target.value)} />
          </label>)}
          <Button type="button" variant="ghost" aria-label={`Remove project mapping ${index + 1}`} onClick={() => update(field.name, rows.filter((_, i) => i !== index))}>Remove</Button>
        </div>)}
        <Button type="button" variant="secondary" onClick={() => update(field.name, [...rows, {}])}>Add project mapping</Button>
      </fieldset>;
    }
    return <label key={field.name}>{field.label}
      {field.type === "select" ? <select value={String(values[field.name] ?? "")} required={enabled && field.required} onChange={(event) => update(field.name, event.target.value)}>
        {(field.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input type={field.type === "secret" ? "password" : field.type} autoComplete={field.type === "secret" ? "new-password" : "off"}
        required={enabled && field.required && !(field.type === "secret" && plugin.hasSecrets[field.name])}
        placeholder={field.type === "secret" && plugin.hasSecrets[field.name] ? "Secret saved — leave blank to keep" : undefined}
        value={String(values[field.name] ?? "")} onChange={(event) => update(field.name, event.target.value)} />}
      {field.type === "secret" && <small className="muted">Leave blank to keep the saved secret. Secrets are never returned to your browser.</small>}
    </label>;
  }
  return <section className="settings-card" aria-label={`${plugin.name} plugin settings`}>
    <h2>{plugin.name}</h2><p className="muted">{plugin.description}</p>
    <p role="status">Status: {plugin.status.state}</p>
    <ErrorNotice error={plugin.status.error || ""} /><ErrorNotice error={error} />
    <form className="form-stack" onSubmit={save}><fieldset disabled={busy}>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable {plugin.name}</label>
      {plugin.fields.map(fieldControl)}
      <Button disabled={busy}>{busy ? "Saving…" : `Save ${plugin.name} settings`}</Button>
    </fieldset></form>
  </section>;
}

export function PluginSettings() {
  const [plugins, setPlugins] = useState<PluginAdminSettings[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<{ plugins: PluginAdminSettings[] }>("/api/admin/plugins");
        // Child forms own drafts; only live status/secret-presence metadata changes.
        if (active) { setPlugins(result.plugins); setError(""); }
      } catch (cause) { if (active) setError(message(cause)); }
      if (active) timer = setTimeout(refresh, 10000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [retry]);
  return <section className="plugin-settings" aria-label="Plugins">
    <h2>Plugins</h2><p className="muted">First-party integrations. Only administrators can change these settings.</p>
    <ErrorNotice error={error} />
    {error && <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>Retry plugins</Button>}
    {!plugins && !error && <Loading />}
    {plugins?.map((plugin) => <PluginForm key={plugin.id} plugin={plugin} onSaved={(saved) => setPlugins((current) => current?.map((item) => item.id === saved.id ? saved : item) || [saved])} />)}
  </section>;
}

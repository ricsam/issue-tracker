import { useEffect, useState } from "react";
import type { Issue, Comment } from "../../shared/types";
import type { ExternalLink, PluginPublicSettings } from "../../shared/plugins";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { browserPlugins } from "../plugins/registry";
import { httpUrl } from "../plugins/r5d";
import { Button, ErrorNotice } from "./ui/primitives";
import "./plugins.css";

export function ExternalLinks({ issue, compact = false }: { issue: Issue; compact?: boolean }) {
  const [links, setLinks] = useState<ExternalLink[]>(issue.externalLinks || []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setLinks(issue.externalLinks || []);
    async function refresh() {
      try {
        const result = await api<{ links: ExternalLink[] }>(`/api/issues/${issue.id}/external-links`);
        if (active) setLinks(result.links);
      } catch { if (active) setLinks([]); }
      if (active) timer = setTimeout(refresh, 10000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [issue.id, issue.externalLinks]);
  const safe = links.filter((link) => httpUrl(link.url));
  if (!safe.length) return null;
  return <div className="external-links" aria-label="External links">
    {safe.map((link) => <a key={`${link.pluginId}:${link.externalId}`} className={`external-link tone-${["neutral", "info", "success", "warning", "danger"].includes(link.tone) ? link.tone : "neutral"}`}
      href={httpUrl(link.url)!} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} title={link.title}>
      {compact ? (link.status || link.title) : <>{link.title}{link.status && <span> · {link.status}</span>}</>}
    </a>)}
  </div>;
}

type PublicConfig = { plugins: PluginPublicSettings[]; baseUrl: string };
export function PluginIssueActions({ issue, comments }: { issue: Issue; comments: Comment[] }) {
  const { users } = useWorkspace();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<PublicConfig>("/api/plugins");
        if (active) setConfig((current) => JSON.stringify(current) === JSON.stringify(result) ? current : result);
      } catch { if (active) setConfig(null); }
      if (active) timer = setTimeout(refresh, 10000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  // Includes saved data only. Changing the key invalidates an older prepared URL
  // immediately, before effects run, so no click can launch a stale snapshot.
  const key = JSON.stringify({ config, issue, comments, users });
  const [prepared, setPrepared] = useState<{ key: string; actions: { id: string; label: string; url?: string; error?: string }[] }>({ key: "", actions: [] });
  useEffect(() => {
    let active = true;
    if (!config) return;
    const context = { issue, comments, users, baseUrl: config.baseUrl };
    void Promise.all(config.plugins.flatMap((settings) => (browserPlugins.find((plugin) => plugin.id === settings.id)?.actions || []).map(async (action) => {
      const item = { id: `${settings.id}:${action.id}`, label: action.label };
      try { return { ...item, url: await action.prepare(settings, context) }; }
      catch (error) { return { ...item, error: message(error) }; }
    }))).then((actions) => { if (active) setPrepared({ key, actions }); });
    return () => { active = false; };
  }, [key]);
  if (!config) return null;
  return <div className="plugin-issue-actions">
    {config.plugins.flatMap((settings) => (browserPlugins.find((plugin) => plugin.id === settings.id)?.actions || []).map((action) => {
      const ready = prepared.key === key ? prepared.actions.find((item) => item.id === `${settings.id}:${action.id}`) : undefined;
      return <div key={`${settings.id}:${action.id}`}>
        <Button type="button" variant="secondary" disabled={!ready?.url} onClick={() => {
          if (ready?.url && httpUrl(ready.url)) window.open(ready.url, "_blank", "noopener,noreferrer");
        }}>{action.label}</Button>
        <ErrorNotice error={ready?.error || ""} />
      </div>;
    }))}
  </div>;
}

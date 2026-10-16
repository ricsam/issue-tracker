import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  ExternalLink,
  PluginAdminSettings,
  PluginEvent,
  PluginMetadata,
  PluginPublicSettings,
} from "../../shared/plugins";
import type { User } from "../../shared/types";
import { projectAccess } from "../project-access";
import { r5dPlugin } from "./r5d";

export class PluginError extends Error {}
export type PluginContext = {
  values: Record<string, unknown>;
  signal: AbortSignal;
  baseUrl: string;
  allowInsecureLocalhost: boolean;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  putLink(issueId: string, link: Omit<ExternalLink, "pluginId">): void;
  removeLinks(externalId?: string): void;
  transaction(fn: () => void): void;
  status(state: string, error?: string): void;
};
export type PluginDefinition = PluginMetadata & {
  defaults: Record<string, unknown>;
  publicFields?: string[];
  check?(context: PluginContext): void | Promise<void>;
  task?(context: PluginContext): Promise<void>;
  hook?(event: PluginEvent, context: PluginContext): void | Promise<void>;
};
type Stored = {
  enabled: boolean;
  values: Record<string, unknown>;
  secrets: Record<string, string>;
};
export function safeUrl(value: string, insecure = true) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !["https:", "http:"].includes(url.protocol) ||
    (!insecure && url.protocol !== "https:")
  )
    throw new PluginError("Invalid URL");
  return url;
}
export function serviceUrl(value: string, allowLocal: boolean) {
  const url = safeUrl(value);
  if (
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        allowLocal && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new PluginError(
      "HTTPS is required (local HTTP requires the localhost development option)",
    );
  return url;
}
export class PluginService {
  private plugins: PluginDefinition[];
  private runs = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private statuses = new Map<string, PluginAdminSettings["status"]>();
  private updates = new Map<string, Promise<unknown>>();
  private closed = false;
  private checks = new Set<AbortController>();
  constructor(
    private db: Database,
    private options: {
      key: Buffer;
      baseUrl: string;
      allowInsecureLocalhost: boolean;
      plugins?: PluginDefinition[];
    },
  ) {
    if (options.key.length !== 32)
      throw new Error("Invalid plugin encryption key");
    this.plugins = options.plugins ?? [r5dPlugin];
    for (const plugin of this.plugins)
      if (this.stored(plugin).enabled) this.start(plugin);
  }
  private stored(plugin: PluginDefinition): Stored {
    const row = this.db
      .query(
        "SELECT enabled,value,secrets FROM plugin_settings WHERE pluginId=?",
      )
      .get(plugin.id) as {
      enabled: number;
      value: string;
      secrets: string;
    } | null;
    return row
      ? {
          enabled: !!row.enabled,
          // Removed fields (such as r5d's old defaultShare) are no longer
          // settings. Ignore them on read and drop them on the next save.
          values: Object.fromEntries(
            Object.entries(JSON.parse(row.value) as Record<string, unknown>).filter(
              ([name]) => plugin.fields.some((field) => field.name === name && field.type !== "secret"),
            ),
          ),
          secrets: JSON.parse(row.secrets),
        }
      : { enabled: false, values: { ...plugin.defaults }, secrets: {} };
  }
  private encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.options.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  private decrypt(value: string) {
    const data = Buffer.from(value, "base64"),
      cipher = createDecipheriv(
        "aes-256-gcm",
        this.options.key,
        data.subarray(0, 12),
      );
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
  adminSettings(): PluginAdminSettings[] {
    return this.plugins.map(({ id, name, description, fields, ...rest }) => {
      const stored = this.stored({ id, name, description, fields, ...rest });
      return {
        id,
        name,
        description,
        fields,
        enabled: stored.enabled,
        values: stored.values,
        hasSecrets: Object.fromEntries(
          fields
            .filter((f) => f.type === "secret")
            .map((f) => [f.name, !!stored.secrets[f.name]]),
        ),
        status: this.statuses.get(id) ?? {
          state: stored.enabled ? "starting" : "disabled",
        },
      };
    });
  }
  publicSettings(user: User): PluginPublicSettings[] {
    return this.plugins.flatMap((plugin) => {
      const stored = this.stored(plugin);
      if (!stored.enabled) return [];
      const values: Record<string, unknown> = {};
      for (const field of plugin.fields)
        if (
          field.type !== "secret" &&
          plugin.publicFields?.includes(field.name)
        ) {
          values[field.name] =
            field.type === "project-table"
              ? (
                  (stored.values[field.name] as { projectId: string }[]) ?? []
                ).filter((row) =>
                  projectAccess(this.db).canRead(row.projectId, user),
                )
              : stored.values[field.name];
        }
      return [{ id: plugin.id, values }];
    });
  }
  links(issueId: string): ExternalLink[] {
    return (
      this.db
        .query(
          "SELECT l.pluginId,l.externalId,l.title,l.url,l.status,l.tone FROM plugin_links l JOIN plugin_settings s ON s.pluginId=l.pluginId WHERE s.enabled=1 AND l.issueId=? ORDER BY l.pluginId,l.externalId",
        )
        .all(issueId) as ExternalLink[]
    ).filter((link) => this.plugins.some((p) => p.id === link.pluginId));
  }
  update(id: string, input: unknown): Promise<PluginAdminSettings> {
    const previous = this.updates.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.apply(id, input));
    this.updates.set(id, next);
    return next;
  }
  private async apply(id: string, input: unknown) {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin || this.closed) throw new PluginError("Plugin unavailable");
    if (!input || typeof input !== "object")
      throw new PluginError("Invalid plugin settings");
    const data = input as { enabled: unknown; values: unknown };
    if (Object.keys(input).some((key) => !["enabled", "values"].includes(key)))
      throw new PluginError("Unknown plugin setting");
    if (
      typeof data.enabled !== "boolean" ||
      !data.values ||
      typeof data.values !== "object" ||
      Array.isArray(data.values)
    )
      throw new PluginError("Invalid plugin settings");
    const supplied = data.values as Record<string, unknown>,
      old = this.stored(plugin);
    if (
      Object.keys(supplied).some(
        (name) => !plugin.fields.some((f) => f.name === name),
      )
    )
      throw new PluginError("Unknown plugin setting");
    const values = { ...plugin.defaults, ...old.values },
      secrets = { ...old.secrets };
    for (const field of plugin.fields) {
      const value =
        supplied[field.name] ??
        (field.type === "secret" ? "" : values[field.name]);
      if (field.type === "project-table") {
        if (!Array.isArray(value) || value.length > 1000)
          throw new PluginError("Invalid project mappings");
        const seen = new Set<string>();
        values[field.name] = value.map((row) => {
          if (
            !row ||
            typeof row !== "object" ||
            typeof row.projectId !== "string" ||
            seen.has(row.projectId) ||
            !this.db
              .query("SELECT 1 FROM projects WHERE id=?")
              .get(row.projectId)
          )
            throw new PluginError("Invalid project mapping");
          if (
            Object.keys(row).some(
              (key) =>
                key !== "projectId" &&
                !field.columns?.some((column) => column.name === key),
            )
          )
            throw new PluginError("Unknown project mapping field");
          seen.add(row.projectId);
          const clean: Record<string, string> = { projectId: row.projectId };
          for (const column of field.columns ?? []) {
            if (
              typeof row[column.name] !== "string" ||
              !row[column.name].trim() ||
              row[column.name].length > 2048
            )
              throw new PluginError("Invalid project mapping");
            if (column.type === "url") safeUrl(row[column.name]);
            clean[column.name] = row[column.name].trim();
          }
          return clean;
        });
      } else {
        if (
          typeof value !== "string" ||
          value.length > (field.type === "secret" ? 16384 : 2048)
        )
          throw new PluginError("Invalid plugin field");
        if (field.type === "secret") {
          if (value) secrets[field.name] = this.encrypt(value);
        } else {
          values[field.name] = value.trim();
          if (value && field.type === "url")
            serviceUrl(value, this.options.allowInsecureLocalhost);
          if (
            field.type === "select" &&
            !field.options?.some((o) => o.value === value)
          )
            throw new PluginError("Invalid selection");
        }
        if (
          data.enabled &&
          field.required &&
          !(field.type === "secret" ? secrets[field.name] : values[field.name])
        )
          throw new PluginError("Required plugin field missing");
      }
    }
    if (
      plugin.id === "r5d" &&
      old.secrets.apiKey &&
      (values.baseUrl !== old.values.baseUrl ||
        values.team !== old.values.team) &&
      !supplied.apiKey
    )
      throw new PluginError(
        "Re-enter the team API key when changing the r5d URL or team",
      );
    const controller = new AbortController();
    const stored = { enabled: data.enabled, values, secrets };
    if (data.enabled && plugin.check) {
      this.checks.add(controller);
      try {
        await plugin.check(
          this.context(plugin, stored, controller.signal, true),
        );
      } catch (error) {
        throw error instanceof PluginError
          ? error
          : new PluginError("Plugin settings check failed");
      } finally {
        this.checks.delete(controller);
        controller.abort();
      }
    }
    if (this.closed) throw new PluginError("Plugin unavailable");
    await this.stop(id);
    if (this.closed) throw new PluginError("Plugin unavailable");
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO plugin_settings VALUES (?,?,?,?) ON CONFLICT(pluginId) DO UPDATE SET enabled=excluded.enabled,value=excluded.value,secrets=excluded.secrets",
        )
        .run(
          id,
          Number(data.enabled),
          JSON.stringify(values),
          JSON.stringify(secrets),
        );
      if (
        plugin.id === "r5d" &&
        (values.baseUrl !== old.values.baseUrl ||
          values.team !== old.values.team)
      ) {
        this.db.query("DELETE FROM plugin_links WHERE pluginId=?").run(id);
        this.db.query("DELETE FROM plugin_state WHERE pluginId=?").run(id);
      }
    })();
    this.statuses.set(id, { state: "disabled" });
    if (data.enabled) this.start(plugin);
    return this.adminSettings().find((p) => p.id === id)!;
  }
  private context(
    plugin: PluginDefinition,
    stored: Stored,
    signal: AbortSignal,
    readOnly = false,
  ): PluginContext {
    const active = () => {
      if (signal.aborted || this.closed) throw new Error("Plugin stopped");
    };
    const writable = () => {
      active();
      if (readOnly)
        throw new Error("Settings checks cannot change plugin state");
    };
    return {
      values: {
        ...stored.values,
        ...Object.fromEntries(
          Object.entries(stored.secrets).map(([k, v]) => [k, this.decrypt(v)]),
        ),
      },
      signal,
      baseUrl: this.options.baseUrl,
      allowInsecureLocalhost: this.options.allowInsecureLocalhost,
      get: (key) => {
        active();
        const row = this.db
          .query("SELECT value FROM plugin_state WHERE pluginId=? AND key=?")
          .get(plugin.id, key) as { value: string } | null;
        return row ? JSON.parse(row.value) : undefined;
      },
      set: (key, value) => {
        writable();
        this.db
          .query(
            "INSERT INTO plugin_state VALUES (?,?,?) ON CONFLICT(pluginId,key) DO UPDATE SET value=excluded.value",
          )
          .run(plugin.id, key, JSON.stringify(value));
      },
      putLink: (issueId, link) => {
        writable();
        safeUrl(link.url);
        if (
          !["neutral", "info", "success", "warning", "danger"].includes(
            link.tone,
          )
        )
          throw new PluginError("Invalid link tone");
        this.db
          .query(
            "INSERT INTO plugin_links SELECT ?,id,?,?,?,?,? FROM issues WHERE id=? ON CONFLICT(pluginId,issueId,externalId) DO UPDATE SET title=excluded.title,url=excluded.url,status=excluded.status,tone=excluded.tone",
          )
          .run(
            plugin.id,
            link.externalId,
            link.title,
            link.url,
            link.status,
            link.tone,
            issueId,
          );
      },
      removeLinks: (externalId) => {
        writable();
        if (externalId === undefined)
          this.db
            .query("DELETE FROM plugin_links WHERE pluginId=?")
            .run(plugin.id);
        else
          this.db
            .query("DELETE FROM plugin_links WHERE pluginId=? AND externalId=?")
            .run(plugin.id, externalId);
      },
      transaction: (fn) => {
        writable();
        this.db.transaction(fn)();
      },
      status: (state, error) => {
        writable();
        this.statuses.set(plugin.id, { state, ...(error ? { error } : {}) });
      },
    };
  }
  private failure(id: string) {
    this.statuses.set(id, {
      state: "error",
      error: "Plugin failed; check configuration and try saving again.",
    });
    console.error(`Plugin ${id}: operation failed`); // Never log exceptions, request bodies or credentials.
  }
  private start(plugin: PluginDefinition) {
    const controller = new AbortController();
    this.statuses.set(plugin.id, { state: "running" });
    const done = Promise.resolve()
      .then(() => {
        if (!controller.signal.aborted && !this.closed)
          return plugin.task?.(
            this.context(plugin, this.stored(plugin), controller.signal),
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) this.failure(plugin.id);
      });
    this.runs.set(plugin.id, { controller, done });
  }
  private async stop(id: string) {
    const run = this.runs.get(id);
    if (run) {
      run.controller.abort();
      this.runs.delete(id);
      // A noncooperative first-party task cannot block settings/close. Every
      // retained context is invalidated synchronously before a replacement starts.
      void run.done;
    }
  }
  /** Called only after the application's content transaction commits. */
  emit(event: PluginEvent): void {
    for (const plugin of this.plugins) {
      const run = this.runs.get(plugin.id);
      if (!run || !plugin.hook || this.closed) continue;
      void Promise.resolve()
        .then(() => {
          if (!run.controller.signal.aborted)
            return plugin.hook!(
              event,
              this.context(plugin, this.stored(plugin), run.controller.signal),
            );
        })
        .catch(() => {
          if (!run.controller.signal.aborted) this.failure(plugin.id);
        });
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.checks) controller.abort();
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id)));
  }
}

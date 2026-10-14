import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, parse as parsePath } from "node:path";

export class CliError extends Error {
  constructor(message: string, public code = 1) { super(message); }
}
export function hostUrl(raw?: string): string {
  if (!raw) throw new CliError("Set a server with threadline auth config --host https://issues.example.com, or set THREADLINE_HOST.", 2);
  let url: URL;
  try { url = new URL(raw); } catch { throw new CliError("Invalid host URL.", 2); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new CliError("Host must be an HTTPS origin without credentials, path, query or fragment; HTTP is allowed only on loopback.", 2);
  return url.origin;
}
export function issueId(raw: string, host: string): string {
  let value = raw;
  if (/^https?:/i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new CliError("Invalid issue URL.", 2); }
    if (url.origin !== host || url.username || url.password || url.search || url.hash)
      throw new CliError("Issue URL must belong to THREADLINE_HOST and have no credentials, query or fragment.", 2);
    const match = /^\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) throw new CliError("Expected an issue URL ending /issues/NUMBER.", 2);
    value = match[1]!;
  }
  value = value.replace(/^!/, "");
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError("Expected a positive issue number, !NUMBER or same-origin issue URL.", 2);
  return value;
}
export class Api {
  constructor(public host: string, private token?: string, private timeout = 15000) {}
  async request<T = any>(path: string, method = "GET", body?: unknown, publicEndpoint = false): Promise<T> {
    if (!path.startsWith("/api/") || new URL(path, this.host).origin !== this.host) throw new CliError("Unsafe API path.", 2);
    if (!publicEndpoint && !this.token) throw new CliError("Not authenticated. Run threadline auth login or set THREADLINE_TOKEN.", 4);
    let response: Response;
    try {
      response = await fetch(this.host + path, {
        method, redirect: "manual", signal: AbortSignal.timeout(this.timeout),
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(!publicEndpoint ? { Authorization: `Bearer ${this.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new CliError("Request failed or timed out. Mutations are never retried; check server state before retrying."); }
    if (response.status >= 300 && response.status < 400) throw new CliError("Server redirect refused; credentials were not forwarded.");
    let data: any;
    try { data = response.status === 204 ? {} : await response.json(); }
    catch { throw Object.assign(new CliError(`Server returned non-JSON (HTTP ${response.status}).`), { status: response.status }); }
    if (!response.ok) {
      const error = new CliError(`HTTP ${response.status}: ${typeof data?.error === "string" ? (this.token ? data.error.replaceAll(this.token, "[redacted]") : data.error) : "request failed"}`, response.status === 401 || response.status === 403 ? 4 : 1);
      Object.assign(error, { apiError: data?.error, status: response.status });
      throw error;
    }
    return data as T;
  }
}

type Hosts = Record<string, { token: string }>;
export class Store {
  readonly directory: string;
  readonly file: string;
  readonly configFile: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.directory = resolve(env.THREADLINE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "threadline"));
    this.file = join(this.directory, "hosts.json");
    this.configFile = join(this.directory, "config.json");
  }
  private async secureDirectory(create: boolean) {
    // Reject symlinks in every existing component, not just hosts.json.
    const root = parsePath(this.directory).root;
    let current = root;
    for (const part of this.directory.slice(root.length).split("/").filter(Boolean)) {
      current = join(current, part);
      let stat;
      try { stat = await lstat(current); } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        if (!create) return false;
        await mkdir(current, { mode: 0o700 });
        stat = await lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CliError("Credential directory must not contain symlinks or non-directories.");
    }
    const stat = await lstat(this.directory);
    if (stat.uid !== process.getuid?.()) throw new CliError("Credential directory is not owned by the current user.");
    await chmod(this.directory, 0o700);
    return true;
  }
  private async readJson(path: string, label: string): Promise<unknown> {
    if (!await this.secureDirectory(false)) return {};
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e: any) { if (e.code === "ENOENT") return {}; throw new CliError(`Cannot safely open ${label} file.`); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new CliError(`Unsafe ${label} file ownership or type.`);
      await file.chmod(0o600);
      return JSON.parse(await file.readFile("utf8"));
    } catch (e) { if (e instanceof CliError) throw e; throw new CliError(`Invalid ${label} file; refusing to overwrite it.`); }
    finally { await file.close(); }
  }
  async read(): Promise<Hosts> {
    const data = await this.readJson(this.file, "credential");
    try {
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.entries(data).some(([host, entry]: [string, any]) => hostUrl(host) !== host || typeof entry?.token !== "string")) throw new Error();
      return data as Hosts;
    } catch { throw new CliError("Invalid credential file; refusing to overwrite it."); }
  }
  async readConfig(): Promise<{ host?: string }> {
    const data = await this.readJson(this.configFile, "configuration");
    try {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      const entries = Object.entries(data);
      if (entries.some(([key, value]) => key !== "host" || typeof value !== "string" || hostUrl(value) !== value)) throw new Error();
      return data as { host?: string };
    } catch { throw new CliError("Invalid configuration file; refusing to overwrite it."); }
  }
  async saveConfig(host: string | undefined): Promise<void> {
    // Explicit user configuration only: never discover settings in the current directory.
    const config = host === undefined ? {} : { host: hostUrl(host) };
    await this.secureDirectory(true);
    await this.readConfig(); // Refuse malformed or unsafe existing files, even on clear.
    await this.writeJson(this.configFile, config);
  }
  async save(host: string, token?: string) {
    await this.secureDirectory(true);
    const hosts = await this.read();
    if (token) hosts[host] = { token }; else delete hosts[host];
    await this.writeJson(this.file, hosts);
  }
  private async writeJson(path: string, data: unknown): Promise<void> {
    const temporary = join(dirname(path), `.threadline-${crypto.randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
export function clean(value: unknown): string { return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }
export function table(headers: string[], rows: unknown[][]): string {
  const all = [headers, ...rows].map(row => row.map(clean));
  const widths = headers.map((_, i) => Math.max(...all.map(row => row[i]?.length || 0)));
  return all.map(row => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

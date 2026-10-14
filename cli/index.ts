#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import type { DeviceAuthorization, ApiKeyInfo } from "../shared/api-access";
import type { Issue, IssueDetail, Project, User } from "../shared/types";
import { Api, CliError, Store, clean, hostUrl, issueId, table } from "./core";

const HELP = `threadline — non-interactive issue tracking

Set THREADLINE_HOST to an explicit HTTPS origin. Authenticate with auth login
or THREADLINE_TOKEN. All commands support --json (otherwise human-readable).

  auth login [--no-browser | --with-token] [--name NAME]
  auth status
  auth logout
  project list
  project view SLUG
  issue list [--project SLUG] [--state open|closed|draft|all]
             [--label LABEL] [--search TEXT] [--limit N]
  issue view NUMBER|!NUMBER|URL
  issue create [--project SLUG] [--title TITLE] [--body TEXT | --body-file PATH|-]
               [--state open|draft]
  issue edit NUMBER|!NUMBER|URL [--title TITLE] [--body TEXT | --body-file PATH|-]
             [--project SLUG]
  issue comment NUMBER|!NUMBER|URL (--body TEXT | --body-file PATH|-)
  issue close NUMBER|!NUMBER|URL
  issue reopen NUMBER|!NUMBER|URL

Body is Markdown; --title is server-compatible heading input, not a separate
stored title. Edit --project moves the issue. List defaults: open, limit 30.
Repeat --label to require every label. --help shows this help.
--with-token reads a manual key from stdin (never pass credentials as arguments).
Exit codes: 0 success; 1 request/storage failure; 2 usage; 4 authentication/access.
`;
const specs: Record<string, { values?: string[]; booleans?: string[]; args: number }> = {
  "auth login": { values: ["name"], booleans: ["no-browser", "with-token"], args: 0 },
  "auth status": { args: 0 }, "auth logout": { args: 0 },
  "project list": { args: 0 }, "project view": { args: 1 },
  "issue list": { values: ["project", "state", "label", "search", "limit"], args: 0 },
  "issue view": { args: 1 },
  "issue create": { values: ["project", "title", "body", "body-file", "state"], args: 0 },
  "issue edit": { values: ["project", "title", "body", "body-file"], args: 1 },
  "issue comment": { values: ["body", "body-file"], args: 1 },
  "issue close": { args: 1 }, "issue reopen": { args: 1 },
};
export function parse(argv: string[]) {
  if (!argv.length || argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]!)) return { command: "help", args: [], flags: {} as Record<string, string[]> };
  if (argv.length === 2 && ["auth", "project", "issue"].includes(argv[0]!) && ["--help", "-h"].includes(argv[1]!)) return { command: "help", args: [], flags: {} as Record<string, string[]> };
  const command = argv.slice(0, 2).join(" ");
  const spec = specs[command];
  if (!spec) throw new CliError("Unknown command. Run threadline --help.", 2);
  const flags: Record<string, string[]> = {};
  const args: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const value = argv[i]!;
    if (!value.startsWith("-")) { args.push(value); continue; }
    if (value === "-h") { flags.help = ["true"]; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(value);
    if (!match) throw new CliError(`Unsupported option: ${clean(value)}`, 2);
    const key = match[1]!;
    const boolean = ["json", "help", ...(spec.booleans || [])].includes(key);
    if (!boolean && !spec.values?.includes(key)) throw new CliError(`Unsupported option: --${key}`, 2);
    if (flags[key] && key !== "label") throw new CliError(`Duplicate option: --${key}`, 2);
    let input = match[2];
    if (boolean) {
      if (input !== undefined) throw new CliError(`--${key} does not take a value.`, 2);
      input = "true";
    } else if (input === undefined) {
      input = argv[++i];
      if (input === undefined || input.startsWith("--")) throw new CliError(`--${key} requires a value.`, 2);
    }
    (flags[key] ||= []).push(input);
  }
  if (flags.help) return { command: "help", args: [], flags };
  if (args.length !== spec.args) throw new CliError(`${command} expects ${spec.args} positional argument(s).`, 2);
  if (flags.body && flags["body-file"]) throw new CliError("Use only one of --body and --body-file.", 2);
  if (flags["with-token"] && (flags["no-browser"] || flags.name)) throw new CliError("--with-token cannot be combined with --no-browser or --name.", 2);
  if (flags.project && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flags.project[0]!)) throw new CliError("--project requires a project slug.", 2);
  if (flags.state && !(command === "issue list" ? ["open", "closed", "draft", "all"] : ["open", "draft"]).includes(flags.state[0]!)) throw new CliError("Unsupported --state.", 2);
  if (flags.limit && (!/^[1-9]\d*$/.test(flags.limit[0]!) || !Number.isSafeInteger(Number(flags.limit[0])))) throw new CliError("--limit must be a positive safe integer.", 2);
  for (const key of ["name", "title", "label"]) if (flags[key]?.some(value => !value.trim())) throw new CliError(`--${key} cannot be empty.`, 2);
  if (flags.title && flags.title[0]!.length > 300) throw new CliError("--title must be at most 300 characters.", 2);
  if (flags.name && flags.name[0]!.length > 100) throw new CliError("--name must be at most 100 characters.", 2);
  if (command === "issue create" && !flags.title && !flags.body && !flags["body-file"]) throw new CliError("Creation requires --body, --body-file or --title.", 2);
  if (command === "issue edit" && !["body", "body-file", "title", "project"].some(key => flags[key])) throw new CliError("No edit fields supplied.", 2);
  if (command === "issue comment" && !flags.body && !flags["body-file"]) throw new CliError("Comment requires --body or --body-file.", 2);
  return { command, args, flags };
}
async function stdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError("Pipe input on stdin; interactive input is not supported.", 2);
  return text(process.stdin);
}
export async function openBrowser(url: string, timeoutMs = 3000): Promise<boolean> {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "linux" ? ["xdg-open", url] : null;
  if (!command) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>(resolve => {
      const child = spawn(command[0]!, command.slice(1), { stdio: "ignore", shell: false });
      child.once("error", () => resolve(false));
      child.once("exit", code => resolve(code === 0));
      timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, timeoutMs);
    });
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}
function verificationUrl(raw: string, host: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CliError("Server returned an invalid verification URL."); }
  if (url.origin !== host || url.username || url.password) throw new CliError("Server returned a cross-origin verification URL; refusing to open it.");
  return url.href;
}
type Identity = { user: User; key: ApiKeyInfo };
async function login(host: string, store: Store, flags: Record<string, string[]>) {
  // Verify storage before issuing a new token. Never log the token or device code.
  await store.read();
  let token: string;
  let identity: Identity;
  if (flags["with-token"]) {
    token = (await stdin()).trim();
    if (!token || /\s/.test(token)) throw new CliError("Expected one token on stdin.", 2);
    identity = await new Api(host, token).request<Identity>("/api/me");
  } else {
    const api = new Api(host);
    const device = await api.request<DeviceAuthorization>("/api/auth/device/code", "POST", { name: flags.name?.[0] || `threadline on ${hostname()}`.slice(0, 100), scopes: ["read", "write"] }, true);
    if (!device.deviceCode || !device.userCode || !Number.isFinite(device.expiresIn) || device.expiresIn <= 0 || !Number.isFinite(device.interval) || device.interval <= 0) throw new CliError("Invalid device authorization response.");
    const deadline = Date.now() + device.expiresIn * 1000;
    const url = verificationUrl(device.verificationUriComplete, host);
    verificationUrl(device.verificationUri, host);
    console.error(`Open ${clean(url)}\nVerification code: ${clean(device.userCode)}`);
    if (!flags["no-browser"] && !await openBrowser(url)) console.error("Could not open a browser; use the URL above.");
    let interval = device.interval * 1000;
    for (;;) {
      if (Date.now() + interval >= deadline) throw new CliError("Device authorization expired. Run auth login again.", 4);
      await sleep(interval);
      try {
        const result = await api.request<Identity & { accessToken: string; tokenType: string }>("/api/auth/device/token", "POST", { deviceCode: device.deviceCode }, true);
        if (!result.accessToken || result.tokenType !== "Bearer") throw new CliError("Invalid token response.");
        token = result.accessToken;
        identity = { user: result.user, key: result.key };
        break;
      } catch (e: any) {
        if (e.status === 400 && e.apiError === "authorization_pending") continue;
        if (e.status === 400 && e.apiError === "slow_down") { interval += 5000; continue; }
        if (e.status === 400 && e.apiError === "access_denied") throw new CliError("Device authorization denied.", 4);
        if (e.status === 400 && e.apiError === "expired_token") throw new CliError("Device authorization expired. Run auth login again.", 4);
        // Proxies may echo the posted device code; never surface arbitrary polling errors.
        throw new CliError("Device token request failed. Run auth login again; check API keys for any issued token.");
      }
    }
  }
  await store.save(host, token);
  return { host, ...identity, source: "saved" };
}
export async function run(argv = process.argv.slice(2)) {
  const { command, args, flags } = parse(argv);
  if (command === "help") { console.log(HELP); return; }
  const host = hostUrl(process.env.THREADLINE_HOST);
  const store = new Store();
  const out = (data: unknown, human: string) => console.log(flags.json ? JSON.stringify(data, null, 2) : human);
  if (command === "auth login") {
    const data = await login(host, store, flags);
    out(data, `Logged in to ${host} as ${clean(data.user.email)}.`);
    return;
  }
  const envToken = process.env.THREADLINE_TOKEN;
  const savedToken = envToken ? undefined : (await store.read())[host]?.token;
  const token = envToken || savedToken;
  if (token && /\s/.test(token)) throw new CliError("Token contains whitespace.", 2);
  const api = new Api(host, token);
  if (command === "auth status") {
    const data = await api.request<Identity>("/api/me");
    out({ host, source: envToken ? "environment" : "saved", ...data }, `${host}\nUser: ${clean(data.user.email)}\nSource: ${envToken ? "THREADLINE_TOKEN" : "saved token"}\nScopes: ${data.key.scopes.join(", ")}\nExpires: ${clean(data.key.expiresAt)}`);
  } else if (command === "auth logout") {
    // Read first so an unsafe local file cannot cause revocation followed by a storage surprise.
    const saved = await store.read();
    await api.request("/api/me/token", "DELETE");
    if (saved[host]?.token === token) await store.save(host);
    out({ host, revoked: true, savedTokenRemoved: saved[host]?.token === token }, `Revoked current token for ${host}.${envToken ? " Unset THREADLINE_TOKEN in your shell." : " Removed saved token."}`);
  } else if (command === "project list") {
    const data = await api.request<{ projects: Project[] }>("/api/projects");
    out(data, table(["SLUG", "NAME", "OPEN", "ARCHIVED"], data.projects.map(p => [p.slug, p.name, p.openCount, p.archivedAt ? "yes" : "no"])));
  } else if (command === "project view") {
    const data = await api.request<{ project: Project }>(`/api/projects/${encodeURIComponent(args[0]!)}`);
    out(data, table(["SLUG", "NAME", "VISIBILITY", "OPEN"], [[data.project.slug, data.project.name, data.project.visibility, data.project.openCount]]) + `\n\n${clean(data.project.description)}`);
  } else if (command === "issue list") {
    const path = flags.project ? `/api/projects/${encodeURIComponent(flags.project[0]!)}/issues` : "/api/issues";
    const data = await api.request<{ issues: Issue[] }>(path);
    const state = flags.state?.[0] || "open", search = flags.search?.[0]?.toLowerCase();
    const issues = data.issues.filter(issue => (state === "all" || issue.state === state) && (!search || `${issue.title}\n${issue.body}`.toLowerCase().includes(search)) && (!flags.label || flags.label.every(label => issue.labels.includes(label))))
      .sort((a, b) => b.number - a.number).slice(0, Number(flags.limit?.[0] || 30));
    out({ issues }, table(["NUMBER", "STATE", "TITLE", "LABELS"], issues.map(i => [`!${i.number}`, i.state, i.title, i.labels.join(", ")])));
  } else {
    const id = command === "issue create" ? undefined : issueId(args[0]!, host);
    if (command === "issue view") {
      const data = await api.request<IssueDetail>(`/api/issues/${id}`);
      out(data, `!${data.issue.number} ${clean(data.issue.title)} [${data.issue.state}]\n${host}/issues/${id}\n\n${safeBody(data.issue.body)}\n\n${data.comments.map(c => `Comment ${clean(c.id)}:\n${safeBody(c.body)}`).join("\n\n")}`);
      return;
    }
    const payload: Record<string, unknown> = {};
    if (flags.title) payload.title = flags.title[0];
    if (flags.body) payload.body = flags.body[0];
    if (flags["body-file"]) {
      const path = flags["body-file"][0]!;
      try { payload.body = path === "-" ? await stdin() : await readFile(path, "utf8"); }
      catch (e) { if (e instanceof CliError) throw e; throw new CliError("Cannot read --body-file.", 2); }
    }
    if (typeof payload.body === "string" && (!payload.body.trim() && !payload.title || payload.body.length > (command === "issue comment" ? 100000 : 101000))) throw new CliError("Body is empty or too long.", 2);
    if (flags.state) payload.state = flags.state[0];
    if (command === "issue edit" && flags.project) {
      const { project } = await api.request<{ project: Project }>(`/api/projects/${encodeURIComponent(flags.project[0]!)}`);
      payload.projectId = project.id;
    }
    let path = `/api/issues/${id}`, method = "PATCH";
    if (command === "issue create") {
      path = flags.project ? `/api/projects/${encodeURIComponent(flags.project[0]!)}/issues` : "/api/issues";
      method = "POST";
      // The compatibility title is optional, but the API always requires body.
      payload.body ??= "";
    } else if (command === "issue comment") { path += "/comments"; method = "POST"; }
    else if (command === "issue close") payload.state = "closed";
    else if (command === "issue reopen") payload.state = "open";
    const data = await api.request(path, method, payload);
    out(data, command === "issue comment" ? `Comment added to !${id}.` : `!${data.issue.number} ${clean(data.issue.title)} [${data.issue.state}]\n${host}/issues/${data.issue.number}`);
  }
}
function safeBody(body: string) { return body.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""); }
// Only the Bun source/compiled entry self-starts. npm-entry owns Node startup.
if (typeof Bun !== "undefined" && import.meta.main) {
  run().catch(error => {
    // Do not echo arbitrary fetch/OS errors: these can contain authorization data.
    console.error(`threadline: ${error instanceof CliError ? clean(error.message) : "Operation failed (storage or invalid server response)."}`);
    process.exitCode = error instanceof CliError ? error.code : 1;
  });
}

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "./app";

const owned: { dir: string; app: ReturnType<typeof createApp>; server?: ReturnType<typeof Bun.serve>; clients: Client[] }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await Promise.all(item.clients.map((client) => client.close()));
    item.server?.stop(true); item.app.close(); rmSync(item.dir, { recursive: true, force: true });
  }
});
const origin = "http://localhost:3000";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "threadline-mcp-"));
  const app = createApp({ dataDir: dir });
  const item: typeof owned[number] = { dir, app, clients: [] }; owned.push(item);
  const req = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" }, { Origin: origin });
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const web = (path: string, method = "GET", body?: unknown, as = cookie) => req(path, method, body, { Cookie: as, Origin: origin });
  const key = async (scopes = ["read", "write"], as = cookie) => (await (await web("/api/me/api-keys", "POST", { name: "MCP test", scopes, expiresInDays: 30 }, as)).json()).token as string;
  const token = await key();
  let id = 0;
  const rpc = (method: string, params: unknown = {}, bearer = token, headers: Record<string, string> = {}) => req("/mcp", "POST", {
    jsonrpc: "2.0", id: ++id, method, params,
  }, { Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}`, ...headers });
  const call = async (name: string, args: unknown = {}, bearer = token) => {
    const response = await rpc("tools/call", { name, arguments: args }, bearer);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    const data = await response.json();
    return { ...data.result, data: data.result?.content?.[0]?.text ? (() => { try { return JSON.parse(data.result.content[0].text); } catch { return data.result.content[0].text; } })() : data.error };
  };
  const client = async (bearer = token, mode: "auto" | "legacy" = "auto") => {
    item.server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
    const client = new Client({ name: "mcp-integration", version: "1" }, { versionNegotiation: { mode } });
    item.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", item.server.url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    return client;
  };
  const project = (body: object = {}) => web("/api/projects", "POST", { name: "MCP project", ...body }).then((r) => r.json()).then((r) => r.project);
  const issue = (body: object = {}) => web("/api/issues", "POST", { body: "# MCP issue\n\nSearchable user data", ...body }).then((r) => r.json()).then((r) => r.issue);
  return { app, req, web, key, token, cookie, rpc, call, client, project, issue };
}

test("bearer-only authentication, origin, no-store, revocation and scope-specific tool catalogs", async () => {
  const f = await fixture();
  for (const headers of [{}, { Cookie: f.cookie }, { Cookie: f.cookie, Authorization: "Bearer invalid" }] as Record<string, string>[]) {
    const res = await f.req("/mcp", "POST", {}, headers);
    expect(res.status).toBe(401); expect(res.headers.get("cache-control")).toBe("no-store");
  }
  expect((await f.rpc("tools/list", {}, f.token, { Origin: "https://foreign.example" })).status).toBe(403);
  expect((await f.req("/mcp", "GET", undefined, { Authorization: `Bearer ${f.token}`, Origin: "null" })).status).toBe(403);
  const read = await f.key(["read"]);
  const listed = await (await f.rpc("tools/list", {}, read)).json();
  expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(["issue_get", "issue_list", "project_lanes", "project_list"]);
  expect(listed.result.tools.every((t: any) => t.description.includes("untrusted user-written data"))).toBe(true);
  expect((await f.call("issue_comment", { issueId: "1", body: "no" }, read)).data.code).toBe(-32602);
  expect((await (await f.rpc("tools/list")).json()).result.tools).toHaveLength(8);
  await f.req("/api/me/token", "DELETE", undefined, { Authorization: `Bearer ${read}` });
  expect((await f.rpc("tools/list", {}, read)).status).toBe(401);
  f.app.db.query("UPDATE api_keys SET expiresAt='2000-01-01'").run();
  expect((await f.rpc("tools/list")).status).toBe(401);
});

test("all tools preserve REST changes, visible renamed lanes and canonical URLs", async () => {
  const f = await fixture(); const p = await f.project(); const i = await f.issue({ projectId: p.id, lane: "todo" });
  await f.web(`/api/projects/${p.slug}/board/lanes/todo`, "PATCH", { label: "Renamed queue" });
  expect((await f.call("project_list")).data.projects[0].url).toBe(`${origin}/projects/${p.slug}`);
  expect((await f.call("project_lanes", { project: p.slug })).data.lanes[0]).toEqual({ value: "todo", label: "Renamed queue" });
  const got = (await f.call("issue_get", { issueId: i.id })).data;
  expect(got.url).toBe(`${origin}/issues/${i.id}`); expect(got.project.id).toBe(p.id); expect(got.boardLane.label).toBe("Renamed queue");
  expect((await f.call("issue_list", { project: p.slug, state: "open", text: "SEARCHABLE" })).data.issues).toHaveLength(1);
  expect((await f.call("issue_list", { text: "not found" })).data.issues).toEqual([]);
  expect((await f.call("issue_list")).data.issues[0].boardLane.label).toBe("Renamed queue");
  await f.web(`/api/projects/${p.slug}/board/lanes/todo`, "DELETE");
  expect((await f.call("issue_get", { issueId: i.id })).data.boardLane).toEqual({ value: "todo", label: "Renamed queue", hidden: true });
  expect((await f.call("issue_list", { project: p.slug })).data.issues[0].boardLane.hidden).toBe(true);
  expect((await f.call("issue_comment", { issueId: i.id, body: "User-written comment" })).isError).not.toBe(true);
  expect((await f.call("issue_get", { issueId: i.id })).data.comments[0].body).toBe("User-written comment");
  expect((await f.call("issue_move", { issueId: i.id, lane: "doing" })).isError).toBe(true);
  const lane = (await f.call("project_lanes", { project: p.slug })).data.lanes[1].value;
  expect((await f.call("issue_move", { issueId: i.id, lane })).data.boardLane.value).toBe(lane);
  expect((await f.call("issue_close", { issueId: i.id })).data.issue.state).toBe("closed");
  expect((await f.call("issue_reopen", { issueId: i.id })).data.issue.state).toBe("open");
  expect((await f.call("issue_move", { issueId: i.id, lane: null })).data.boardLane).toBeNull();
  const history = await (await f.web(`/api/issues/${i.id}/history`)).json();
  expect(JSON.stringify(history)).toContain("commented");
});

test("private projects, other users' drafts and archive mutations follow REST", async () => {
  const f = await fixture(); const p = await f.project({ visibility: "private" });
  const i = await f.issue({ projectId: p.id }); const draft = await f.issue({ state: "draft" });
  await f.web("/api/admin/users", "POST", { name: "Member", email: "member@example.com", password: "long-password-123" });
  const login = await f.web("/api/auth/login", "POST", { email: "member@example.com", password: "long-password-123" }, "");
  const memberCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const member = await f.key(["read", "write"], memberCookie);
  for (const id of [i.id, draft.id]) expect((await f.call("issue_get", { issueId: id }, member)).data).toContain("404");
  expect((await f.call("project_list", {}, member)).data.projects).toEqual([]);
  expect((await f.call("issue_list", {}, member)).data.issues).toEqual([]);
  expect((await f.call("issue_get", { issueId: draft.id })).data.issue.state).toBe("draft");
  expect((await f.call("project_lanes", { project: p.slug }, member)).isError).toBe(true);
  expect((await f.web(`/api/projects/${p.slug}`, "PATCH", { archived: true })).status).toBe(200);
  expect((await f.call("issue_get", { issueId: i.id })).data.issue.id).toBe(i.id);
  for (const name of ["issue_comment", "issue_close", "issue_reopen", "issue_move"]) {
    const result = await f.call(name, { issueId: i.id, ...(name === "issue_comment" ? { body: "blocked" } : name === "issue_move" ? { lane: null } : {}) });
    expect(result.isError).toBe(true); expect(result.data).toContain("409");
  }
});

test("malformed inputs, body limit and stateless legacy initialization revisions", async () => {
  const f = await fixture();
  for (const protocolVersion of ["2025-06-18", "2025-03-26"]) {
    const res = await f.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "legacy", version: "1" } });
    expect(res.headers.get("mcp-session-id")).toBeNull(); expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).result.protocolVersion).toBe(protocolVersion);
    expect((await (await f.rpc("tools/list", {}, f.token, { "MCP-Protocol-Version": protocolVersion })).json()).result.tools).toHaveLength(8);
  }
  for (const args of [{ issueId: "../api/me" }, { issueId: 1 }, { issueId: "01" }, { issueId: "9007199254740992" }, { issueId: "1", foreign: true }]) expect((await f.call("issue_get", args)).isError).toBe(true);
  expect((await f.call("project_lanes", { project: "https://evil.example" })).isError).toBe(true);
  expect((await f.rpc("tools/call", { name: "issue_comment", arguments: { issueId: "1", body: "x".repeat(300000) } })).status).toBe(413);
  const malformed = await f.app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{" });
  expect(malformed.status).toBe(400);
});

test("real v2 HTTP client auto-negotiates modern discovery and supports legacy mode", async () => {
  const f = await fixture(); const i = await f.issue();
  for (const mode of ["auto", "legacy"] as const) {
    const client = await f.client(f.token, mode);
    expect(client.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
    if (mode === "auto") expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools).toHaveLength(8);
    const result = await client.callTool({ name: "issue_get", arguments: { issueId: i.id } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain(`${origin}/issues/${i.id}`);
    const comment = await client.callTool({ name: "issue_comment", arguments: { issueId: i.id, body: `From ${mode}` } });
    expect(comment.isError).not.toBe(true);
  }
  expect((await f.call("issue_get", { issueId: i.id })).data.comments).toHaveLength(2);
});

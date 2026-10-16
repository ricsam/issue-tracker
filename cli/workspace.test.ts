import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueTarget } from "./core";
import { parse } from "./index";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

test("canonical targets infer workspace, validate origins/numbers and reject conflicts", () => {
  const host = "https://example.com";
  expect(issueTarget("!7", host)).toEqual({ number: "7", workspace: "default" });
  expect(issueTarget(`${host}/w/team/issues/7/`, host)).toEqual({ number: "7", workspace: "team" });
  expect(issueTarget("7", host, "team").workspace).toBe("team");
  for (const url of [`${host}/issues/7`, `${host}/w/team/issues/0`, `${host}/w/team/issues/9007199254740992`, `${host}/w/team/issues/7?q=x`, `${host}/w/team/issues/7#x`, "https://other.example/w/team/issues/7", "https://u@example.com/w/team/issues/7", `${host}/w/UPPER/issues/7`]) expect(() => issueTarget(url, host)).toThrow();
  expect(() => issueTarget(`${host}/w/team/issues/7`, host, "other")).toThrow("conflicts");
  expect(parse(["workspace", "list"]).command).toBe("workspace list");
  expect(parse(["project", "list", "--workspace", "team"]).flags.workspace).toEqual(["team"]);
  for (const value of ["", "../x", "UPPER", "a/b"]) expect(() => parse(["issue", "list", "--workspace", value])).toThrow();
  expect(() => parse(["auth", "status", "--workspace", "team"])).toThrow();
});

test("all data requests scoped; equal numbers resolve distinct stable IDs; canonical output", async () => {
  const seen: { path: string; method: string; workspace: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const workspace = request.headers.get("X-Workspace-Slug");
    seen.push({ path, method: request.method, workspace });
    const issue = { id: workspace === "alpha" ? "101" : "202", number: 7, workspaceSlug: workspace, title: "Scoped", body: "text", state: "open", labels: [] };
    if (path === "/api/workspaces") return Response.json({ workspaces: [{ slug: "alpha", name: "Alpha", role: "admin" }, { slug: "public", name: "Public", role: null }] });
    if (path === "/api/projects") return Response.json({ projects: [] });
    if (path === "/api/projects/demo") return Response.json({ project: { id: "p1", slug: "demo", name: "Demo" } });
    if (request.method === "GET" && path.endsWith("/issues")) return Response.json({ issues: [issue] });
    return Response.json({ issue, comments: [] });
  } });
  servers.push(server);
  const config = await mkdtemp(join(await realpath(tmpdir()), "threadline-workspace-")); paths.push(config);
  async function cli(args: string[], workspace = "") {
    const child = Bun.spawn([process.execPath, "cli/index.ts", ...args], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, THREADLINE_HOST: server.url.origin, THREADLINE_TOKEN: "test-secret", THREADLINE_CONFIG_DIR: config, THREADLINE_WORKSPACE: workspace },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  for (const workspace of ["alpha", "beta"]) {
    const result = await cli(["issue", "close", "7", "--workspace", workspace]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`/w/${workspace}/issues/7`);
    expect(seen.slice(-2)).toEqual([
      { path: "/api/issues/by-number/7", method: "GET", workspace },
      { path: `/api/issues/${workspace === "alpha" ? "101" : "202"}`, method: "PATCH", workspace },
    ]);
  }
  for (const args of [["issue", "list"], ["project", "list"], ["project", "view", "demo"], ["issue", "create", "--body", "Hello"]]) {
    expect((await cli(args, "alpha")).code).toBe(0);
    expect(seen.at(-1)?.workspace).toBe("alpha");
  }
  for (const action of ["edit", "comment", "reopen"]) {
    const result = await cli(["issue", action, `${server.url.origin}/w/alpha/issues/7`, ...(action === "reopen" ? [] : ["--body", "Changed"])]);
    expect(result.code).toBe(0);
    expect(seen.at(-1)?.path).toBe(`/api/issues/101${action === "comment" ? "/comments" : ""}`);
    expect(seen.at(-1)?.workspace).toBe("alpha");
    expect(result.stdout).toContain("/w/alpha/issues/7");
  }
  const url = `${server.url.origin}/w/alpha/issues/7`;
  const before = seen.length;
  expect((await cli(["issue", "close", url], "beta")).code).toBe(2);
  expect((await cli(["issue", "close", url, "--workspace", "beta"])).code).toBe(2);
  expect(seen.length).toBe(before);
  expect((await cli(["issue", "view", url, "--workspace", "alpha"], "beta")).code).toBe(0);
  expect((await cli(["workspace", "list"])).stdout).toContain("not a member");
  expect(seen.at(-1)?.workspace).toBe("default");
  expect((await cli(["workspace", "list", "--json"])).stdout).toContain('"role": null');
});

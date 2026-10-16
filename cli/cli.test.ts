import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api, Store, hostUrl, issueId, table } from "./core";
import { parse } from "./index";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) server.stop(true); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temp() { const path = await mkdtemp(join(await realpath(tmpdir()), "threadline-test-")); paths.push(path); return path; }
function server(fetch: (request: Request) => Response | Promise<Response>) {
  const instance = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); servers.push(instance); return instance.url.origin;
}
async function cli(host: string, config: string, args: string[], input?: string, token = "test-secret") {
  const child = Bun.spawn([process.execPath, "cli/index.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, THREADLINE_HOST: host, THREADLINE_CONFIG_DIR: config, THREADLINE_TOKEN: token, THREADLINE_WORKSPACE: "" },
    stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
const issue = { id: "12", number: 12, title: "Test", body: "# Test\n\nhello", labels: ["bug"], state: "open", projectId: "p1" };
const identity = { user: { id: "u1", email: "a@example.com" }, key: { id: "k1", scopes: ["read", "write"], expiresAt: "2027-01-01" } };

describe("strict arguments", () => {
  test("help and documented forms", () => {
    expect(parse([]).command).toBe("help");
    expect(parse(["issue", "list", "--label=bug", "--label", "help wanted", "--json"]).flags.label).toEqual(["bug", "help wanted"]);
    expect(parse(["issue", "create", "--title", "hello"]).flags.title).toEqual(["hello"]);
  });
  test("reject unsupported gh flags and malformed input", () => {
    for (const args of [
      ["issue", "list", "--assignee", "me"], ["issue", "list", "--json", "title"],
      ["issue", "view", "12", "extra"], ["issue", "view"], ["issue", "create"],
      ["issue", "edit", "12"], ["issue", "comment", "12"], ["issue", "list", "--limit", "0"],
      ["issue", "list", "--limit", "1.2"], ["issue", "list", "--limit", "Infinity"],
      ["issue", "list", "--state", "merged"], ["issue", "create", "--title", "x", "--state", "closed"],
      ["issue", "create", "--body", "x", "--body-file", "-"], ["issue", "list", "--search"],
      ["issue", "list", "--state", "open", "--state", "all"], ["issue", "list", "--json=false"],
      ["auth", "login", "--with-token", "--no-browser"], ["auth", "login", "secret"],
      ["issue", "list", "--project", "../x"], ["issue", "create", "--title", " "],
    ]) expect(() => parse(args)).toThrow();
  });
});
describe("host and credential security", () => {
  test("explicit origin and same-origin targets", () => {
    expect(hostUrl("https://example.com/")).toBe("https://example.com");
    expect(hostUrl("http://[::1]:123")).toBe("http://[::1]:123");
    for (const value of [undefined, "example.com", "http://example.com", "https://a:b@example.com", "https://example.com/path", "https://example.com?x", "https://example.com#x"]) expect(() => hostUrl(value)).toThrow();
    for (const value of ["12", "!12", "https://example.com/w/default/issues/12"]) expect(issueId(value, "https://example.com")).toBe("12");
    for (const value of ["0", "-1", "01", "#12", "9007199254740992", "https://other.com/issues/12", "https://u@example.com/issues/12", "https://example.com/issues/12?x"]) expect(() => issueId(value, "https://example.com")).toThrow();
  });
  test("private host-bound storage and deletion preserves other hosts", async () => {
    const directory = join(await temp(), "config");
    const store = new Store({ THREADLINE_CONFIG_DIR: directory });
    await store.save("https://one.example", "one"); await store.save("https://two.example", "two");
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(store.file)).mode & 0o777).toBe(0o600);
    await chmod(store.file, 0o644); await store.read();
    expect((await lstat(store.file)).mode & 0o777).toBe(0o600);
    await store.save("https://one.example");
    expect(await store.read()).toEqual({ "https://two.example": { token: "two" } });
  });
  test("refuses file and directory symlinks and malformed stores", async () => {
    const directory = await temp(), target = join(directory, "target");
    await writeFile(target, "{}");
    const store = new Store({ THREADLINE_CONFIG_DIR: join(directory, "config") });
    await mkdir(store.directory); await symlink(target, store.file);
    await expect(store.save("https://example.com", "secret")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("{}");
    const link = join(directory, "link"); await symlink(store.directory, link);
    await expect(new Store({ THREADLINE_CONFIG_DIR: join(link, "child") }).read()).rejects.toThrow();
    await rm(store.file); await writeFile(store.file, "[]");
    await expect(store.read()).rejects.toThrow("Invalid credential file");
  });
  test("redirect refused, bearer never sent to redirect destination", async () => {
    let calls = 0;
    const target = server(() => { calls++; return Response.json({}); });
    const source = server(() => Response.redirect(target + "/api/me", 307));
    await expect(new Api(source, "secret").request("/api/me")).rejects.toThrow("redirect refused");
    expect(calls).toBe(0);
  });
  test("timeouts and mutation failures are not retried", async () => {
    let calls = 0;
    const host = server(async () => { calls++; await Bun.sleep(100); return Response.json({}); });
    await expect(new Api(host, "secret", 10).request("/api/issues", "POST", {})).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });
  test("human tables sanitize terminal controls", () => expect(table(["TITLE"], [["danger\x1b[31m\ntext"]])).not.toContain("\x1b"));
});
describe("real subprocess against HTTP fixture", () => {
  test("all data commands, filtering, stdin, project move and JSON", async () => {
    const seen: { method: string; path: string; body: any }[] = [];
    const host = server(async request => {
      expect(request.headers.get("Authorization")).toBe("Bearer test-secret");
      const path = new URL(request.url).pathname;
      const body = request.method === "GET" ? undefined : await request.json();
      seen.push({ method: request.method, path, body });
      if (path === "/api/projects") return Response.json({ projects: [{ id: "p1", slug: "demo", name: "Demo", openCount: 1 }] });
      if (path === "/api/projects/demo") return Response.json({ project: { id: "p1", slug: "demo", name: "Demo", openCount: 1 } });
      if (path.endsWith("/comments")) return Response.json({ comment: { id: "c1", body: body.body } });
      if (request.method === "GET" && path.endsWith("/issues")) return Response.json({ issues: [issue, { ...issue, id: "13", number: 13, state: "closed" }, { ...issue, id: "14", number: 14, labels: [] }] });
      return Response.json({ issue, comments: [] });
    });
    const config = await temp();
    for (const args of [["project", "list"], ["project", "view", "demo"], ["issue", "view", "!12"], ["issue", "view", host + "/w/default/issues/12"]]) {
      const result = await cli(host, config, [...args, "--json"]); expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
    const list = await cli(host, config, ["issue", "list", "--project", "demo", "--state", "all", "--label", "bug", "--search", "hello", "--limit", "1", "--json"]);
    expect(JSON.parse(list.stdout).issues.map((i: IssueLike) => i.number)).toEqual([13]);
    const created = await cli(host, config, ["issue", "create", "--project", "demo", "--title", "Heading", "--body-file", "-", "--json"], "Markdown\nbody");
    expect(created.code).toBe(0); expect(seen.at(-1)).toEqual({ method: "POST", path: "/api/projects/demo/issues", body: { title: "Heading", body: "Markdown\nbody" } });
    const file = join(config, "body.md"); await writeFile(file, "# Updated");
    expect((await cli(host, config, ["issue", "edit", "12", "--body-file", file, "--project", "demo"])).code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ body: "# Updated", projectId: "p1" });
    expect((await cli(host, config, ["issue", "comment", "12", "--body", "Done"])).code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ body: "Done" });
    for (const [action, state] of [["close", "closed"], ["reopen", "open"]]) {
      expect((await cli(host, config, ["issue", action!, "12"])).code).toBe(0); expect(seen.at(-1)?.body).toEqual({ state });
    }
  });
  test("with-token validates, stores privately, status and logout revoke", async () => {
    const methods: string[] = [];
    const host = server(request => { methods.push(request.method); expect(request.headers.get("authorization")).toBe("Bearer manual-secret"); return Response.json(identity); });
    const config = await temp();
    const login = await cli(host, config, ["auth", "login", "--with-token", "--json"], "manual-secret\n", "");
    expect(login.code).toBe(0); expect(login.stdout).not.toContain("manual-secret");
    const status = await cli(host, config, ["auth", "status", "--json"], undefined, "");
    expect(JSON.parse(status.stdout).source).toBe("saved");
    expect((await cli(host, config, ["auth", "logout", "--json"], undefined, "")).code).toBe(0);
    expect(methods).toEqual(["GET", "GET", "DELETE"]);
    expect(await new Store({ THREADLINE_CONFIG_DIR: config }).read()).toEqual({});
  });
  test("failed validation does not persist; failed logout keeps saved credentials", async () => {
    const host = server(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const config = await temp();
    const result = await cli(host, config, ["auth", "login", "--with-token"], "bad-token", "");
    expect(result.code).toBe(4); expect(result.stdout).toBe("");
    const store = new Store({ THREADLINE_CONFIG_DIR: config });
    expect(await store.read()).toEqual({}); await store.save(host, "saved");
    expect((await cli(host, config, ["auth", "logout"], undefined, "")).code).toBe(4);
    expect((await store.read())[host]?.token).toBe("saved");
  });
  test("env logout revokes env token but preserves a different saved token", async () => {
    const host = server(() => Response.json({ ok: true })); const config = await temp();
    const store = new Store({ THREADLINE_CONFIG_DIR: config }); await store.save(host, "saved");
    expect((await cli(host, config, ["auth", "logout"])).code).toBe(0);
    expect((await store.read())[host]?.token).toBe("saved");
  });
  test("device flow prints fallback to stderr, polls without bearer and saves", async () => {
    let polls = 0;
    const host = server(async request => {
      expect(request.headers.get("authorization")).toBeNull();
      const body = await request.json() as any;
      if (new URL(request.url).pathname.endsWith("/code")) {
        expect(body.scopes).toEqual(["read", "write"]);
        return Response.json({ deviceCode: "private-code", userCode: "ABCD-EFGH", verificationUri: host + "/device", verificationUriComplete: host + "/device?code=ABCD-EFGH", expiresIn: 5, interval: 0.01 });
      }
      expect(body).toEqual({ deviceCode: "private-code" });
      if (++polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ ...identity, accessToken: "device-secret", tokenType: "Bearer" });
    });
    const config = await temp(); const result = await cli(host, config, ["auth", "login", "--no-browser", "--json"]);
    expect(result.code).toBe(0); expect(result.stderr).toContain("ABCD-EFGH"); expect(result.stderr).not.toContain("private-code"); expect(result.stdout).not.toContain("device-secret");
    expect((await new Store({ THREADLINE_CONFIG_DIR: config }).read())[host]?.token).toBe("device-secret");
  });
  test("cross-host target and unsupported flags fail before requests", async () => {
    let calls = 0; const host = server(() => { calls++; return Response.json({}); }); const config = await temp();
    for (const args of [["issue", "view", "https://elsewhere.example/issues/12"], ["issue", "list", "--assignee", "me"]]) {
      const result = await cli(host, config, args); expect(result.code).toBe(2); expect(result.stdout).toBe("");
    }
    expect(calls).toBe(0);
  });
});
type IssueLike = { number: number };

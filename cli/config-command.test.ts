import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./core";
import { parse } from "./index";

const paths: string[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) server.stop(true); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(await realpath(tmpdir()), "threadline-config-command-")); paths.push(path); return path; }
function server(fetch: (request: Request) => Response | Promise<Response>) { const instance = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); servers.push(instance); return instance.url.origin; }
async function cli(config: string, args: string[], env: Record<string, string> = {}, input?: string, cwd = join(import.meta.dir, "..")) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
    cwd, env: { ...process.env, THREADLINE_HOST: "", THREADLINE_TOKEN: "", THREADLINE_CONFIG_DIR: config, ...env },
    stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
const identity = { user: { email: "config@example.com" }, key: { scopes: ["read"], expiresAt: "2027-01-01" } };

test("auth config parses show/set/clear and rejects ambiguous or unsafe input", () => {
  expect(parse(["auth", "config"]).command).toBe("auth config");
  expect(parse(["auth", "config", "--host", "https://example.com"]).flags.host).toEqual(["https://example.com"]);
  expect(parse(["auth", "config", "--clear"]).flags.clear).toEqual(["true"]);
  for (const args of [["--host", "https://example.com", "--clear"], ["--host", "http://insecure.example"], ["--host", "https://user:secret@example.com"], ["--host", "https://example.com/path"], ["--host"], ["--token", "secret"], ["host", "https://example.com"]]) expect(() => parse(["auth", "config", ...args])).toThrow();
});

test("saved host persists across commands; show/clear never expose credentials or make requests", async () => {
  let requests = 0;
  const host = server(request => { requests++; expect(request.headers.get("authorization")).toBe("Bearer saved-token"); return Response.json(identity); });
  const config = await directory();
  const store = new Store({ THREADLINE_CONFIG_DIR: config });
  const empty = await cli(config, ["auth", "config", "--json"]);
  expect(empty.code).toBe(0); expect(JSON.parse(empty.stdout)).toMatchObject({ host: null, effectiveHost: null, source: null });
  const set = await cli(config, ["auth", "config", "--host", host + "/", "--json"]);
  expect(set.code).toBe(0); expect(JSON.parse(set.stdout)).toMatchObject({ host, effectiveHost: host, source: "config", configFile: store.configFile });
  expect(requests).toBe(0);
  const login = await cli(config, ["auth", "login", "--with-token", "--json"], {}, "saved-token\n");
  expect(login.code).toBe(0);
  const credentials = await readFile(store.file, "utf8");
  expect((await cli(config, ["auth", "status", "--json"])).code).toBe(0);
  const shown = await cli(config, ["auth", "config"]);
  expect(shown.stdout).toContain(host); expect(shown.stdout).not.toContain("saved-token");
  expect(requests).toBe(2);
  expect((await cli(config, ["auth", "config", "--clear"])).code).toBe(0);
  expect(await readFile(store.file, "utf8")).toBe(credentials);
  const missing = await cli(config, ["auth", "status"]);
  expect(missing.code).toBe(2); expect(missing.stderr).toContain("auth config --host"); expect(requests).toBe(2);
});

test("env host takes precedence without changing default or sending another host's saved token", async () => {
  let firstCalls = 0, secondCalls = 0;
  const first = server(request => { firstCalls++; expect(request.headers.get("authorization")).toBe("Bearer first-secret"); return Response.json(identity); });
  const second = server(request => { secondCalls++; expect(request.headers.get("authorization")).toBe("Bearer second-secret"); return Response.json(identity); });
  const config = await directory(), store = new Store({ THREADLINE_CONFIG_DIR: config });
  await store.saveConfig(first); await store.save(first, "first-secret");
  const noSecondToken = await cli(config, ["auth", "status"], { THREADLINE_HOST: second });
  expect(noSecondToken.code).toBe(4); expect(secondCalls).toBe(0); expect(firstCalls).toBe(0);
  const shown = await cli(config, ["auth", "config", "--json"], { THREADLINE_HOST: second });
  expect(JSON.parse(shown.stdout)).toMatchObject({ host: first, effectiveHost: second, source: "environment" });
  expect(shown.stdout).not.toContain("first-secret");
  expect((await cli(config, ["auth", "status"], { THREADLINE_HOST: second, THREADLINE_TOKEN: "second-secret" })).code).toBe(0);
  expect(await store.readConfig()).toEqual({ host: first });
  expect((await cli(config, ["auth", "status"])).code).toBe(0);
  expect(firstCalls).toBe(1); expect(secondCalls).toBe(1);
  const before = await readFile(store.configFile, "utf8");
  expect((await cli(config, ["auth", "config", "--clear"], { THREADLINE_HOST: "bad" })).code).toBe(2);
  expect(await readFile(store.configFile, "utf8")).toBe(before);
});

test("ignores current-directory settings, invalid stored settings fail closed but explicit env works", async () => {
  const config = await directory(), cwd = await directory();
  await writeFile(join(cwd, "config.json"), '{"host":"https://untrusted.example"}');
  const result = await cli(config, ["auth", "config", "--json"], {}, undefined, cwd);
  expect(JSON.parse(result.stdout).host).toBeNull();
  const host = server(() => Response.json(identity));
  await writeFile(join(config, "config.json"), "invalid");
  expect((await cli(config, ["auth", "status"])).code).toBe(1);
  expect((await cli(config, ["auth", "status"], { THREADLINE_HOST: host, THREADLINE_TOKEN: "explicit" })).code).toBe(0);
});

test("legacy device origin rejection gives upgrade guidance without retrying or weakening request headers", async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    const host = server(request => {
      calls++;
      expect(request.method).toBe("POST"); expect(new URL(request.url).pathname).toBe("/api/auth/device/code");
      expect(request.headers.get("origin")).toBeNull(); expect(request.headers.get("authorization")).toBeNull();
      return status === 404 ? new Response("404 Not Found", { status }) : Response.json({ error: status === 403 ? "Invalid origin" : "Authentication required" }, { status });
    });
    const config = await directory();
    const result = await cli(config, ["auth", "login", "--no-browser"], { THREADLINE_HOST: host });
    expect(result.code).toBe(4); expect(result.stderr).toContain("Upgrade the server"); expect(result.stderr).toContain("BASE_URL"); expect(result.stdout).toBe(""); expect(calls).toBe(1);
    expect(await new Store({ THREADLINE_CONFIG_DIR: config }).read()).toEqual({});
  }
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Build and run the actual npm entry, not TypeScript via a Node loader or Bun runtime.
test("Node bundle supports help, stdin credentials/bodies, API lifecycle and public device polling", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "threadline-node-test-"));
  const config = join(directory, "config");
  const seen: { path: string; method: string; body: any; auth: string | null }[] = [];
  const identity = { user: { email: "node@example.com" }, key: { scopes: ["read", "write"], expiresAt: "2027-01-01" } };
  let issue = { id: "12", number: 12, title: "Node issue", body: "# Node issue", labels: ["bug"], state: "open" };
  let polls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" || request.method === "PATCH" ? await request.json() : undefined;
    const auth = request.headers.get("authorization");
    seen.push({ path, method: request.method, body, auth });
    if (path === "/api/auth/device/code") {
      expect(auth).toBeNull();
      return Response.json({ deviceCode: "private-node-code", userCode: "ABCD-EFGH", verificationUri: server.url.origin + "/cli/authorize", verificationUriComplete: server.url.origin + "/cli/authorize?user_code=ABCD-EFGH", expiresIn: 10, interval: 0.01 });
    }
    if (path === "/api/auth/device/token") {
      expect(auth).toBeNull(); expect(body).toEqual({ deviceCode: "private-node-code" });
      if (++polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ ...identity, accessToken: "node-device-token", tokenType: "Bearer" });
    }
    expect(auth).toBe("Bearer node-manual-token");
    if (path === "/api/me") return Response.json(identity);
    if (path === "/api/me/token") return Response.json({ ok: true });
    if (path === "/api/projects") return Response.json({ projects: [{ slug: "demo", name: "Demo", openCount: 1 }] });
    if (path.endsWith("/comments")) return Response.json({ comment: { body: (body as any).body } });
    if (request.method === "POST" || request.method === "PATCH") { issue = { ...issue, ...body as object }; return Response.json({ issue }); }
    if (path === "/api/issues") return Response.json({ issues: [issue] });
    return Response.json({ issue, comments: [] });
  } });
  const node = Bun.which("node");
  if (!node) throw new Error("Node >=22.14 is required for npm runtime tests");
  async function cli(args: string[], input = "", extraEnv: Record<string, string> = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(node!, [join(directory, "threadline.mjs"), ...args], {
        env: { ...process.env, THREADLINE_HOST: server.url.origin, THREADLINE_TOKEN: "", THREADLINE_CONFIG_DIR: config, ...extraEnv }, stdio: "pipe",
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", data => stdout += data);
      child.stderr.setEncoding("utf8").on("data", data => stderr += data);
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("error", error => { clearTimeout(watchdog); reject(error); });
      child.once("close", code => { clearTimeout(watchdog); resolve({ code, stdout, stderr }); });
      child.stdin.end(input);
    });
  }
  try {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "npm-entry.ts")], target: "node", format: "esm", outdir: directory, naming: "threadline.mjs" });
    expect(build.success).toBe(true);
    expect(await readFile(join(directory, "threadline.mjs"), "utf8")).toStartWith("#!/usr/bin/env node");
    for (const group of ["auth", "project", "issue"]) {
      const help = await cli([group, "--help"]); expect(help.code).toBe(0); expect(help.stdout).toContain("threadline —"); expect(help.stderr).toBe("");
    }
    expect(seen.length).toBe(0);
    const bad = await cli(["issue", "list", "--assignee", "me"]); expect(bad.code).toBe(2); expect(bad.stdout).toBe("");
    const login = await cli(["auth", "login", "--with-token", "--json"], "node-manual-token\n");
    expect(login.code).toBe(0); expect(JSON.parse(login.stdout).user.email).toBe("node@example.com"); expect(login.stdout).not.toContain("node-manual-token");
    expect((await stat(join(config, "hosts.json"))).mode & 0o777).toBe(0o600);
    expect((await cli(["auth", "status"])).code).toBe(0);
    expect((await cli(["project", "list"])).stdout).toContain("Demo");
    const body = "# Node issue\n\nUnicode café 🐈 #bug\n";
    expect((await cli(["issue", "create", "--body-file", "-", "--json"], body)).code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ body });
    expect((await cli(["issue", "list", "--label", "bug", "--json"])).code).toBe(0);
    expect((await cli(["issue", "view", "12", "--json"])).code).toBe(0);
    expect((await cli(["issue", "comment", "12", "--body-file", "-"], "Node comment")).code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ body: "Node comment" });
    expect((await cli(["issue", "edit", "12", "--body", "Updated"])).code).toBe(0);
    expect((await cli(["issue", "close", "12"])).code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ state: "closed" });
    expect((await cli(["issue", "reopen", "12"])).code).toBe(0);
    expect((await cli(["auth", "logout"])).code).toBe(0);
    expect(JSON.parse(await readFile(join(config, "hosts.json"), "utf8"))).toEqual({});
    // Node child launches a shell-free fake opener written with only Node APIs.
    const opener = join(directory, process.platform === "darwin" ? "open" : "xdg-open");
    const marker = join(directory, "opener-args.json");
    await writeFile(opener, `#!${node}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 1000);\n`);
    await chmod(opener, 0o700);
    const device = await cli(["auth", "login", "--json"], "", { PATH: directory, THREADLINE_TOKEN: "not-for-public-endpoints" });
    expect(device.code).toBe(0); expect(device.stderr).toContain("Could not open a browser");
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([server.url.origin + "/cli/authorize?user_code=ABCD-EFGH"]);
    expect(polls).toBe(2); expect(device.stdout).not.toContain("node-device-token");
    expect(JSON.parse(await readFile(join(config, "hosts.json"), "utf8"))[server.url.origin].token).toBe("node-device-token");
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);

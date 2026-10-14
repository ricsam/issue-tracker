import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app";
import { Store } from "./core";

test("real device flow approves in browser session and CLI exchanges without bearer", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "threadline-device-test-"));
  let app: ReturnType<typeof createApp> | undefined;
  let cookie = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const response = await app!.fetch(request);
    if (new URL(request.url).pathname === "/api/auth/device/code") {
      expect(request.headers.get("authorization")).toBeNull();
      const { userCode } = await response.clone().json() as { userCode: string };
      const approved = await app!.request("/api/auth/device/approve", {
        method: "POST", headers: { Origin: server.url.origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ userCode, approve: true }),
      });
      expect(approved.status).toBe(200);
    }
    if (new URL(request.url).pathname === "/api/auth/device/token") expect(request.headers.get("authorization")).toBeNull();
    return response;
  } });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    app = createApp({ dataDir: join(directory, "data"), baseUrl: server.url.origin });
    const setup = await app.request("/api/auth/setup", { method: "POST", headers: { Origin: server.url.origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Device", email: "device@example.com", password: "long-password-123" }) });
    expect(setup.status).toBe(200); cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const config = join(directory, "config");
    child = Bun.spawn([process.execPath, "cli/index.ts", "auth", "login", "--no-browser", "--json"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, THREADLINE_HOST: server.url.origin, THREADLINE_TOKEN: "must-not-be-sent", THREADLINE_CONFIG_DIR: config },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toContain("Verification code:");
    expect(JSON.parse(stdout).key.source).toBe("cli"); expect(JSON.parse(stdout).user.email).toBe("device@example.com");
    const token = (await new Store({ THREADLINE_CONFIG_DIR: config }).read())[server.url.origin]!.token;
    expect(stdout).not.toContain(token); expect(stderr).not.toContain(token);
    expect((await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally { if (child && child.exitCode === null) { child.kill(); await child.exited; } server.stop(true); app?.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);

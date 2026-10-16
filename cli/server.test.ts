import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app";

test("CLI against real server: manual login, project/issue lifecycle, read scope and revocation", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "threadline-server-test-"));
  const app = createApp({ dataDir: join(directory, "data") });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const host = server.url.origin;
  async function cli(args: string[], input?: string, token = "") {
    const child = Bun.spawn([process.execPath, "cli/index.ts", ...args, "--json"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, THREADLINE_HOST: host, THREADLINE_TOKEN: token, THREADLINE_CONFIG_DIR: join(directory, "config") },
      stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, data: stdout ? JSON.parse(stdout) : null };
  }
  async function browser(path: string, body: unknown, cookie = "") {
    return app.request(path, { method: "POST", headers: { Origin: "http://localhost:3000", Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  try {
    const setup = await browser("/api/auth/setup", { name: "CLI Admin", email: "cli@example.com", password: "long-password-123" });
    expect(setup.status).toBe(200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const keyResponse = await browser("/api/me/api-keys", { name: "CLI integration", scopes: ["read", "write"], expiresInDays: 1 }, cookie);
    expect(keyResponse.status).toBe(200);
    const key = await keyResponse.json() as { token: string };
    const loggedIn = await cli(["auth", "login", "--with-token"], key.token);
    expect(loggedIn.code).toBe(0); expect(loggedIn.data.user.email).toBe("cli@example.com");
    const projectResponse = await browser("/api/projects", { name: "CLI Project" }, cookie);
    expect(projectResponse.status).toBe(200);
    const { project } = await projectResponse.json() as any;
    expect((await cli(["project", "list"])).data.projects[0].slug).toBe(project.slug);
    expect((await cli(["project", "view", project.slug])).data.project.id).toBe(project.id);
    const created = await cli(["issue", "create", "--project", project.slug, "--title", "Title-only compatibility"]);
    expect(created.code).toBe(0); expect(created.data.issue.title).toBe("Title-only compatibility");
    const id = String(created.data.issue.number);
    const edit = await cli(["issue", "edit", id, "--body-file", "-"], "# Updated\n\nDetails #bug");
    expect(edit.code).toBe(0); expect(edit.data.issue.labels).toContain("bug");
    expect((await cli(["issue", "comment", id, "--body", "Verified"])).code).toBe(0);
    expect((await cli(["issue", "view", host + "/w/default/issues/" + id])).data.comments[0].body).toBe("Verified");
    expect((await cli(["issue", "close", id])).data.issue.state).toBe("closed");
    expect((await cli(["issue", "list", "--state", "closed", "--label", "bug"])).data.issues.length).toBe(1);
    expect((await cli(["issue", "reopen", id])).data.issue.state).toBe("open");
    const readKey = await (await browser("/api/me/api-keys", { name: "Read integration", scopes: ["read"], expiresInDays: 1 }, cookie)).json() as { token: string };
    expect((await cli(["issue", "list"], undefined, readKey.token)).code).toBe(0);
    const denied = await cli(["issue", "close", id], undefined, readKey.token);
    expect(denied.code).toBe(4); expect(denied.stdout).toBe("");
    expect((await cli(["auth", "logout"])).code).toBe(0);
    expect((await cli(["auth", "status"], undefined, key.token)).code).toBe(4);
    expect((await cli(["auth", "status"])).code).toBe(4);
  } finally { server.stop(true); app.close(); await rm(directory, { recursive: true, force: true }); }
});

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";

const image = process.argv[2];
if (!image)
  throw new Error("Usage: bun scripts/verify-container.ts <built-image>");
const run = crypto.randomUUID();
const container = `issue-tracker-smoke-${run}`;
const volume = `${container}-data`;
const dir = resolve(`.local/container-${run}`);
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${dir}/manifest.json`,
  JSON.stringify({ run, image, container, volume, paths: [dir] }),
);
async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(process.stdout).text();
  const error = await new Response(process.stderr).text();
  if (await process.exited)
    throw new Error(`Docker ${args[0]} failed: ${error}`);
  return text.trim();
}
const origin = "https://issues.example.test";
let cookie = "";
let base = "";
let createdVolume = false;
let createdContainer = false;
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response;
}
async function ready() {
  base = `http://${await docker("port", container, "3000/tcp")}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch(base + "/readyz")).ok) return;
    } catch {
      /* startup */
    }
    await Bun.sleep(500);
  }
  throw new Error("Container did not become ready");
}
try {
  await docker("volume", "create", volume);
  createdVolume = true;
  await docker(
    "run",
    "-d",
    "--name",
    container,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    "-p",
    "127.0.0.1::3000",
    "-e",
    `BASE_URL=${origin}`,
    "-e",
    `SETTINGS_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    image,
  );
  createdContainer = true;
  await ready();
  assert.equal(await docker("exec", container, "id", "-u"), "1000");
  const html = await request("/");
  assert.match(await html.text(), /Threadline/);
  assert.match(
    html.headers.get("Content-Security-Policy") || "",
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(base + "/api/projects")).status, 401);
  const setup = await request("/api/auth/setup", "POST", {
    name: "Smoke Admin",
    email: "smoke@example.test",
    password: randomBytes(24).toString("base64"),
  });
  const setCookie = setup.headers.get("set-cookie") || "";
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /HttpOnly/);
  cookie = setCookie.split(";")[0];
  const { project } = await (
    await request("/api/projects", "POST", { name: "Persistent project" })
  ).json();
  const { issue } = await (
    await request(`/api/projects/${project.slug}/issues`, "POST", {
      title: "Survives restart",
      body: "**Persistent** Markdown",
    })
  ).json();
  await docker("restart", container);
  await ready();
  const detail = await (await request(`/api/issues/${issue.id}`)).json();
  assert.equal(detail.issue.title, "Survives restart");
  assert.equal(detail.issue.body, "**Persistent** Markdown");
  console.log(
    "Container smoke passed: non-root, read-only rootfs, HTTPS cookies, protected data, persistent SQLite and session after restart.",
  );
} finally {
  // Cleanup only resources this exact run created, and only after the container stops.
  if (createdContainer) await docker("rm", "-f", container);
  if (createdVolume) await docker("volume", "rm", volume);
  rmSync(dir, { recursive: true, force: true });
}

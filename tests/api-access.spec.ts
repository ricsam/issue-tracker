import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const account = { email: "alex@example.test", password: "local-browser-test-password" };
async function login(page: Page, origin: string) {
  expect((await page.request.post("/api/auth/login", { headers: { Origin: origin }, data: account })).ok()).toBeTruthy();
}
test.beforeAll(async ({ request, baseURL }) => {
  if ((await (await request.get("/api/auth/status")).json()).setupRequired)
    expect((await request.post("/api/auth/setup", { headers: { Origin: baseURL! }, data: { ...account, name: "Alex Morgan" } })).ok()).toBeTruthy();
});

test("personal key creation reveals once, persists metadata, and revokes after confirmation", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const member = { email: `key-owner-${randomUUID()}@example.test`, password: account.password };
  expect((await page.request.post("/api/admin/users", { headers: { Origin: baseURL! }, data: { ...member, name: "API key owner" } })).ok()).toBeTruthy();
  expect((await page.request.post("/api/auth/login", { headers: { Origin: baseURL! }, data: member })).ok()).toBeTruthy();
  await page.goto("/w/default/projects");
  await expect(page.getByRole("link", { name: "Administration", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "API access", exact: true }).click();
  const name = `Browser key ${randomUUID()}`;
  await page.getByLabel("Key name", { exact: true }).fill(name);
  await page.getByRole("combobox", { name: "Permissions", exact: true }).selectOption("write");
  await page.getByLabel("Expires in (days)").fill("7");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Copy your API key now" });
  await expect(dialog).toBeVisible();
  const token = await dialog.getByLabel("API key token").inputValue();
  expect(token).toMatch(/^tlk_/);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
  expect(page.url()).not.toContain(token);
  await dialog.getByRole("button", { name: "I saved it — dismiss" }).click();
  await expect(page.getByLabel("API key token")).toHaveCount(0);
  await page.reload();
  const key = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(key).toContainText("Read and write");
  await expect(key).toContainText("Never");
  await key.getByRole("button", { name: `Revoke ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(key).toContainText("Active");
  await key.getByRole("button", { name: `Revoke ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Confirm revocation" }).click();
  await expect(key).toContainText("Revoked");
  await expect(key.getByRole("button")).toHaveCount(0);
  await expect(page.getByText(token, { exact: true })).toHaveCount(0);
});

test("CLI request survives local login and offers only a canonical OIDC return; lookup never approves", async ({ page, baseURL }) => {
  const response = await page.request.post("/api/auth/device/code", { data: { name: "Unverified laptop", scopes: ["read", "write"] } });
  expect(response.ok()).toBeTruthy();
  const device = await response.json();
  await page.route("**/api/auth/status", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), oidc: { enabled: true, name: "SSO" } } });
  });
  let approvals = 0;
  page.on("request", req => { if (req.url().endsWith("/api/auth/device/approve")) approvals++; });
  await page.goto(`/cli/authorize?user_code=${device.userCode.toLowerCase()}&returnTo=https://evil.test`);
  await expect(page.getByRole("link", { name: "Sign in with SSO" })).toHaveAttribute("href", `/api/auth/oidc/login?returnTo=${encodeURIComponent(`/cli/authorize?user_code=${device.userCode}`)}`);
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review CLI request" })).toBeVisible();
  await expect(page.getByText("Requesting name (unverified)")).toBeVisible();
  await expect(page.getByText("Unverified laptop", { exact: true })).toBeVisible();
  await expect(page.getByText("90 days", { exact: true })).toBeVisible();
  await expect(page.getByText("Only approve a sign-in you initiated.")).toBeVisible();
  await expect(page.getByText(/Signed in as/)).toContainText(account.email);
  expect(approvals).toBe(0);
  // A second lookup still succeeds, demonstrating the request remains pending.
  expect((await page.request.get(`/api/auth/device/request?user_code=${device.userCode}`)).ok()).toBeTruthy();
  await page.getByRole("button", { name: "Approve CLI access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "CLI access approved" })).toContainText("Return to your terminal");
  expect(approvals).toBe(1);
  const tokenResponse = await page.request.post("/api/auth/device/token", { data: { deviceCode: device.deviceCode } });
  expect(tokenResponse.ok()).toBeTruthy();
  const token = (await tokenResponse.json()).accessToken;
  expect(token).toMatch(/^tlk_/);
  await expect(page.getByText(token, { exact: true })).toHaveCount(0);
});

test("real CLI browser login saves a working token and logout revokes it", async ({ page, baseURL }) => {
  // This exact per-test directory is the complete resource manifest for cleanup.
  const directory = await mkdtemp(join(await realpath(tmpdir()), "threadline-browser-cli-"));
  const env = { ...process.env, THREADLINE_HOST: baseURL!, THREADLINE_TOKEN: "", THREADLINE_CONFIG_DIR: directory };
  const child = spawn("bun", ["cli/index.ts", "auth", "login", "--no-browser", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false;
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", code => { closed = true; resolve(code); }); });
  const command = async (...args: string[]) => {
    const process = spawn("bun", ["cli/index.ts", ...args, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let result = "";
    process.stdout.on("data", chunk => { result += chunk.toString(); });
    process.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { process.on("error", reject); process.on("close", resolve); });
    expect(code).toBe(0);
    return JSON.parse(result);
  };
  try {
    await expect.poll(() => /Verification code: [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/.test(stderr)).toBe(true);
    const code = /Verification code: ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/.exec(stderr)![1]!;
    await login(page, baseURL!);
    await page.goto(`/cli/authorize?user_code=${code}`);
    await expect(page.getByRole("heading", { name: "Review CLI request" })).toBeVisible();
    await page.getByRole("button", { name: "Approve CLI access" }).click();
    await expect(page.getByRole("status").filter({ hasText: "CLI access approved" })).toBeVisible();
    expect(await exited).toBe(0);
    expect(JSON.parse(stdout).user.email).toBe(account.email);
    expect((await command("auth", "status")).key.source).toBe("cli");
    expect((await command("issue", "list")).issues).toBeInstanceOf(Array);
    expect((await command("auth", "logout")).revoked).toBe(true);
    const keyId = JSON.parse(stdout).key.id;
    const keys = (await (await page.request.get("/api/me/api-keys")).json()).keys;
    expect(keys.find((key: { id: string }) => key.id === keyId).revokedAt).not.toBeNull();
  } finally {
    if (!closed) { child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual code entry normalizes whitespace and case, allows denial, and reports missing codes", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const device = await (await page.request.post("/api/auth/device/code", { data: { name: "Read-only CLI", scopes: ["read"] } })).json();
  await page.goto("/cli/authorize");
  await page.getByLabel("Terminal code", { exact: true }).fill(` ${device.userCode.toLowerCase().replace("-", " ")} `);
  await page.getByRole("button", { name: "Review request", exact: true }).click();
  await expect(page.getByLabel("Terminal code", { exact: true })).toHaveValue(device.userCode);
  await expect(page.getByText("Read only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Deny access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "CLI access denied" })).toContainText("CLI access denied");
  expect((await (await page.request.post("/api/auth/device/token", { data: { deviceCode: device.deviceCode } })).json()).error).toBe("access_denied");
  await page.goto(`/cli/authorize?user_code=${device.userCode}`);
  await expect(page.getByRole("alert")).toContainText(/not found|expired/);
  await expect(page.getByRole("button", { name: "Approve CLI access" })).toHaveCount(0);
});

import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "./index";

test("command groups expose help without accepting unknown flags", () => {
  for (const group of ["auth", "issue", "project"]) {
    for (const flag of ["--help", "-h"]) expect(parse([group, flag]).command).toBe("help");
    expect(() => parse([group, "--help", "--unknown"])).toThrow();
  }
});

test("browser opener is shell-free and bounded even when opener hangs", async () => {
  if (!["linux", "darwin"].includes(process.platform)) return;
  const directory = await mkdtemp(join(await realpath(tmpdir()), "threadline-opener-test-"));
  const marker = join(directory, "arguments.json");
  const url = "https://example.com/cli/authorize?user_code=ABCD-EFGH&x=$(touch%20bad)";
  try {
    const opener = join(directory, process.platform === "darwin" ? "open" : "xdg-open");
    await writeFile(opener, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\nsetInterval(() => {}, 1000);\n`);
    await chmod(opener, 0o700);
    const script = `import { openBrowser } from ${JSON.stringify(join(import.meta.dir, "index.ts"))}; console.log(await openBrowser(${JSON.stringify(url)}, 300));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe" });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      expect(await new Response(child.stdout).text()).toBe("false\n");
      expect(await child.exited).toBe(0);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([url]);
    } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI errors redact bearer and suppress arbitrary device polling errors", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "threadline-errors-test-"));
  const secret = "secret-current-bearer", deviceCode = "secret-device-code";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/code")) return Response.json({ deviceCode, userCode: "ABCD-EFGH", verificationUri: server.url.origin + "/cli/authorize", verificationUriComplete: server.url.origin + "/cli/authorize?user_code=ABCD-EFGH", expiresIn: 5, interval: 0.01 });
    return Response.json({ error: path.endsWith("/token") ? `Proxy received ${deviceCode}` : `Invalid ${secret} and again ${secret}` }, { status: 500 });
  } });
  try {
    for (const args of [["auth", "status"], ["auth", "login", "--no-browser"]]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
        env: { ...process.env, THREADLINE_HOST: server.url.origin, THREADLINE_TOKEN: secret, THREADLINE_CONFIG_DIR: directory }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(1); expect(stdout).toBe("");
      expect(stderr).not.toContain(secret); expect(stderr).not.toContain(deviceCode);
      expect(stderr).toContain(args[1] === "status" ? "[redacted]" : "Device token request failed");
    }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

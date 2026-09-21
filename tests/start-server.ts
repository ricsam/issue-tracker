import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

// A unique, recorded directory per run. Never remove a prefix-matched/shared temp folder.
const parent = resolve(".local/e2e");
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(join(parent, "run-"));
const port = process.env.E2E_PORT || "4179";
writeFileSync(
  join(dir, "manifest.json"),
  JSON.stringify({
    run: dir,
    pid: process.pid,
    createdPaths: [dir],
    createdAt: new Date().toISOString(),
  }),
);
const child = Bun.spawn(["bun", "server/index.ts"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: port,
    HOST: "127.0.0.1",
    BASE_URL: `http://127.0.0.1:${port}`,
    DATA_DIR: join(dir, "data"),
    SETTINGS_ENCRYPTION_KEY: "",
  },
  stdout: "inherit",
  stderr: "inherit",
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  await child.exited;
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const code = await child.exited;
if (!stopping) {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

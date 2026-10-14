import { chmod, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Build only the dependency-free CLI. The root package remains a private server/web app.
const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "cli/dist");
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, "cli/npm-entry.ts")],
  outdir,
  naming: "threadline.js",
  target: "node",
  format: "esm",
  minify: false,
});
if (!result.success) throw new AggregateError(result.logs, "CLI package build failed");
const output = resolve(outdir, "threadline.js");
const code = await Bun.file(output).text();
if (!code.startsWith("#!/usr/bin/env node\n")) throw new Error("CLI entrypoint must retain its Node shebang");
if (/\bBun\./.test(code) || /from\s+["']bun[:"']/.test(code)) throw new Error("npm executable must not require the Bun runtime");
await chmod(output, 0o755);
await copyFile(resolve(root, "LICENSE"), resolve(root, "cli/LICENSE"));
console.log("Built cli/dist/threadline.js for Node; npm package root is cli/.");

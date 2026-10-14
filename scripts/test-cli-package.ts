import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(await realpath(tmpdir()), "threadline-npm-pack-"));
// This exact directory is this run's resource manifest; never clean by prefix.
async function command(argv: string[], cwd = root) {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, THREADLINE_HOST: "", THREADLINE_TOKEN: "", THREADLINE_CONFIG_DIR: join(directory, "config") }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${argv[0]} ${argv[1]} failed (${code}): ${stderr}`);
  return stdout;
}
try {
  const packed = JSON.parse(await command(["npm", "pack", "./cli", "--json", "--ignore-scripts", "--pack-destination", directory]));
  const files = packed[0].files.map((entry: { path: string }) => entry.path).sort();
  const expected = ["LICENSE", "README.md", "dist/threadline.js", "package.json"].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`Unexpected npm tarball contents: ${files.join(", ")}`);
  const packageJson = JSON.parse(await readFile(join(root, "cli/package.json"), "utf8"));
  if (packed[0].name !== "@ricsam/threadline" || packed[0].version !== packageJson.version) throw new Error("Unexpected package name/version");
  const prefix = join(directory, "install");
  await command(["npm", "install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed[0].filename)]);
  const help = await command([join(prefix, "bin/threadline"), "--help"], directory);
  if (!help.includes("issue list") || !help.includes("auth login")) throw new Error("Installed npm executable did not print CLI help");
  const group = await command([join(prefix, "bin/threadline"), "issue", "--help"], directory);
  if (!group.includes("issue edit")) throw new Error("Installed npm executable did not print group help");
  console.log(`Packed and installed @ricsam/threadline@${packageJson.version}: exact four-file allowlist, executable Node bin, and help passed.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

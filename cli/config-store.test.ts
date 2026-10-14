import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./core";

const owned: string[] = [];
afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "threadline-config-test-"));
  owned.push(root);
  return { root, store: new Store({ THREADLINE_CONFIG_DIR: join(root, "config") }) };
}
test("explicit config location only, no current-directory discovery", () => {
  expect(new Store({}).configFile).toBe(join(homedir(), ".config", "threadline", "config.json"));
  expect(new Store({ XDG_CONFIG_HOME: "/chosen-config" }).configFile).toBe("/chosen-config/threadline/config.json");
  expect(new Store({ THREADLINE_CONFIG_DIR: "/explicit-config", XDG_CONFIG_HOME: "/ignored" }).configFile).toBe("/explicit-config/config.json");
});
test("save, reopen, canonicalize and clear config with private permissions", async () => {
  const { store } = await fixture();
  expect(await store.readConfig()).toEqual({});
  await store.saveConfig("https://EXAMPLE.com:443/");
  expect(await store.readConfig()).toEqual({ host: "https://example.com" });
  expect(new Store({ THREADLINE_CONFIG_DIR: store.directory }).configFile).toBe(store.configFile);
  expect(await new Store({ THREADLINE_CONFIG_DIR: store.directory }).readConfig()).toEqual({ host: "https://example.com" });
  expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(store.configFile)).mode & 0o777).toBe(0o600);
  await chmod(store.directory, 0o755); await chmod(store.configFile, 0o644);
  await store.readConfig();
  expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(store.configFile)).mode & 0o777).toBe(0o600);
  await store.saveConfig("http://127.0.0.1:3000");
  expect(await store.readConfig()).toEqual({ host: "http://127.0.0.1:3000" });
  await store.saveConfig(undefined);
  expect(await store.readConfig()).toEqual({});
  expect(await readdir(store.directory)).toEqual(["config.json"]);
});
test("configuration and credential updates preserve the other file byte-for-byte", async () => {
  const { store } = await fixture();
  await store.save("https://example.com", "secret");
  const credentials = await readFile(store.file, "utf8");
  await store.saveConfig("https://example.com");
  expect(await readFile(store.file, "utf8")).toBe(credentials);
  const config = await readFile(store.configFile, "utf8");
  await store.save("https://second.example", "second");
  expect(await readFile(store.configFile, "utf8")).toBe(config);
  await store.save("https://example.com");
  expect(await readFile(store.configFile, "utf8")).toBe(config);
  const remaining = await readFile(store.file, "utf8");
  await store.saveConfig(undefined);
  expect(await readFile(store.file, "utf8")).toBe(remaining);
});
test("reject invalid host input without changing existing configuration", async () => {
  const { store } = await fixture();
  await store.saveConfig("https://example.com");
  const original = await readFile(store.configFile, "utf8");
  for (const value of ["", "example.com", "http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?x", "https://example.com#x"]) {
    await expect(store.saveConfig(value)).rejects.toThrow();
    expect(await readFile(store.configFile, "utf8")).toBe(original);
  }
});
test("malformed settings, unknown keys and noncanonical stored hosts fail closed", async () => {
  const { store } = await fixture();
  await mkdir(store.directory);
  for (const invalid of ["broken", "null", "[]", '"host"', '{"host":null}', '{"host":42}', '{"token":"secret"}', '{"host":"https://example.com","extra":true}', '{"host":"http://unsafe.example"}', '{"host":"https://example.com/"}']) {
    await writeFile(store.configFile, invalid);
    await expect(store.readConfig()).rejects.toThrow("Invalid configuration file");
    await expect(store.saveConfig("https://new.example")).rejects.toThrow();
    await expect(store.saveConfig(undefined)).rejects.toThrow();
    expect(await readFile(store.configFile, "utf8")).toBe(invalid);
  }
});
test("unsafe credential file does not prevent independent config and vice versa", async () => {
  const { store } = await fixture();
  await mkdir(store.directory);
  await writeFile(store.file, "broken");
  await store.saveConfig("https://example.com");
  expect(await readFile(store.file, "utf8")).toBe("broken");
  await writeFile(store.file, "{}"); await writeFile(store.configFile, "broken");
  await store.save("https://example.com", "token");
  expect(await readFile(store.configFile, "utf8")).toBe("broken");
});
test("reject symlink files, symlink directory components and hardlinked files", async () => {
  const { root, store } = await fixture();
  await mkdir(store.directory);
  const target = join(root, "target.json"); await writeFile(target, "{}");
  await symlink(target, store.configFile);
  await expect(store.readConfig()).rejects.toThrow();
  await expect(store.saveConfig("https://example.com")).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("{}");
  await rm(store.configFile); await link(target, store.configFile);
  await expect(store.readConfig()).rejects.toThrow("ownership or type");
  await expect(store.saveConfig(undefined)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("{}");
  const directoryLink = join(root, "link"); await symlink(store.directory, directoryLink);
  const linked = new Store({ THREADLINE_CONFIG_DIR: join(directoryLink, "nested") });
  await expect(linked.readConfig()).rejects.toThrow("symlinks");
  await expect(linked.saveConfig("https://example.com")).rejects.toThrow("symlinks");
});
test("reject non-file config and ownership mismatch without changing permissions", async () => {
  const { store } = await fixture();
  await mkdir(store.directory); await mkdir(store.configFile);
  await expect(store.readConfig()).rejects.toThrow("ownership or type");
  await rm(store.configFile, { recursive: true });
  await store.saveConfig("https://example.com");
  // Model a foreign-owned directory without requiring root or mutating real ownership.
  const uid = process.getuid!();
  const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try { await expect(store.readConfig()).rejects.toThrow("not owned"); await expect(store.saveConfig(undefined)).rejects.toThrow("not owned"); }
  finally { getuid.mockRestore(); }
  // First ownership check is the directory; second is the open file's fstat.
  const fileOwner = spyOn(process, "getuid").mockReturnValueOnce(uid).mockReturnValue(uid + 1);
  try { await expect(store.readConfig()).rejects.toThrow("ownership or type"); }
  finally { fileOwner.mockRestore(); }
  expect(await store.readConfig()).toEqual({ host: "https://example.com" });
});

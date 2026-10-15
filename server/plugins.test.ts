import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db";
import { PluginService, type PluginDefinition } from "./plugins";
import type { User } from "../shared/types";

const options = {
  key: Buffer.alloc(32, 7),
  baseUrl: "https://issues.test",
  allowInsecureLocalhost: true,
};
export function fixture() {
  const db = openDatabase(":memory:");
  db.exec(`INSERT INTO users(id,name,email,role,createdAt) VALUES ('u','User','u@test','admin','now');
    INSERT INTO projects(id,slug,name,description,createdAt,visibility,ownerId) VALUES ('p','p','P','','now','private','u');
    INSERT INTO issues(id,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (1,1,'p','Issue','Body','todo','normal','[]','u','now','now');`);
  return db;
}
const plugin: PluginDefinition = {
  id: "test",
  name: "Test",
  description: "",
  fields: [
    { name: "secret", label: "Secret", type: "secret", required: true },
    { name: "url", label: "URL", type: "url" },
    {
      name: "projects",
      label: "Projects",
      type: "project-table",
      columns: [{ name: "remote", label: "Remote", type: "text" }],
    },
  ],
  defaults: { url: "https://test.example", projects: [] },
  publicFields: ["secret", "url", "projects"],
};

test("encrypted secrets, preservation, validation and access-filtered public settings", async () => {
  const db = fixture(),
    service = new PluginService(db, { ...options, plugins: [plugin] });
  try {
    await service.update("test", {
      enabled: true,
      values: {
        secret: "do-not-expose",
        projects: [{ projectId: "p", remote: "git@example/repo" }],
      },
    });
    const raw = JSON.stringify(db.query("SELECT * FROM plugin_settings").all());
    expect(raw).not.toContain("do-not-expose");
    expect(service.adminSettings()[0]!.hasSecrets.secret).toBe(true);
    expect(JSON.stringify(service.adminSettings())).not.toContain(
      "do-not-expose",
    );
    await service.update("test", { enabled: true, values: { secret: "" } });
    expect(service.adminSettings()[0]!.hasSecrets.secret).toBe(true);
    const stranger = { id: "other", role: "member" } as User;
    expect(service.publicSettings(stranger)[0]!.values.projects).toEqual([]);
    expect(service.publicSettings(stranger)[0]!.values).not.toHaveProperty(
      "secret",
    );
    expect(
      (
        service.publicSettings({ id: "u", role: "admin" } as User)[0]!.values
          .projects as unknown[]
      ).length,
    ).toBe(1);
    await expect(
      service.update("test", {
        enabled: true,
        values: { url: "http://outside.test" },
      }),
    ).rejects.toThrow();
    await expect(
      service.update("test", {
        enabled: true,
        values: { projects: [{ projectId: "missing", remote: "x" }] },
      }),
    ).rejects.toThrow();
  } finally {
    await service.close();
    db.close();
  }
});

test("tasks restart/abort, scoped safe links, hooks isolate errors, close guards late writes", async () => {
  const db = fixture();
  let starts = 0,
    stops = 0,
    hook = 0;
  let late: (() => void) | undefined;
  const definition: PluginDefinition = {
    ...plugin,
    async task(ctx) {
      starts++;
      ctx.putLink("1", {
        externalId: "x",
        title: "External",
        url: "https://example.test",
        status: "running",
        tone: "info",
      });
      expect(() =>
        ctx.putLink("1", {
          externalId: "bad",
          title: "Bad",
          url: "javascript:alert(1)",
          status: null,
          tone: "neutral",
        }),
      ).toThrow();
      late = () => ctx.set("late", true);
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener(
          "abort",
          () => {
            stops++;
            resolve();
          },
          { once: true },
        ),
      );
    },
    hook() {
      hook++;
      throw new Error("do-not-expose");
    },
  };
  const service = new PluginService(db, { ...options, plugins: [definition] });
  await service.update("test", { enabled: true, values: { secret: "value" } });
  await Bun.sleep(5);
  expect(starts).toBe(1);
  expect(service.links("1")).toHaveLength(1);
  service.emit({ type: "issue.updated", issueId: "1", actorId: "u" });
  await Bun.sleep(5);
  expect(hook).toBe(1);
  expect(service.adminSettings()[0]!.status.state).toBe("error");
  await service.update("test", { enabled: true, values: {} });
  await Bun.sleep(5);
  expect(starts).toBe(2);
  expect(stops).toBe(1);
  await service.update("test", { enabled: false, values: {} });
  expect(stops).toBe(2);
  expect(service.links("1")).toEqual([]);
  await service.close();
  expect(late).toThrow();
  db.close();
});

test("validation contexts cannot mutate storage and close invalidates pending checks", async () => {
  const db = fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = new PluginService(db, {
    ...options,
    plugins: [
      {
        ...plugin,
        async check(ctx) {
          expect(() => ctx.set("bad", true)).toThrow();
          expect(() => ctx.removeLinks()).toThrow();
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          expect(ctx.signal.aborted).toBe(true);
        },
      },
    ],
  });
  await expect(
    service.update("test", { enabled: true, values: {}, unknown: true }),
  ).rejects.toThrow();
  const updating = service.update("test", {
    enabled: true,
    values: { secret: "value" },
  });
  const result = updating.catch((error) => error);
  await ready;
  await service.close();
  db.close();
  release();
  expect((await result).message).toContain("unavailable");
});

test("migration 19 adds only plugin tables and preserves migration 18 content", () => {
  // A file permits reopen through the real migration entry point.
  const directory = mkdtempSync(join(tmpdir(), "threadline-plugin-test-"));
  const path = join(directory, "migration.sqlite");
  const db = openDatabase(path, 18);
  db.exec(
    "INSERT INTO users(id,name,email,role,createdAt) VALUES ('u','Original','original@test','admin','then')",
  );
  const before = db.query("SELECT * FROM users").all();
  db.close();
  const upgraded = openDatabase(path);
  expect(upgraded.query("SELECT * FROM users").all()).toEqual(before);
  expect(
    upgraded.query("SELECT version FROM migrations WHERE version=19").get(),
  ).toBeTruthy();
  expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
  upgraded.close();
  const reopened = openDatabase(path);
  expect(reopened.query("SELECT * FROM users").all()).toEqual(before);
  reopened.close();
  rmSync(directory, { recursive: true }); // Exact directory created by this test, after both handles close.
});

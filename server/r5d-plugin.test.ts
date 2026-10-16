import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import type { Issue, User } from "../shared/types";
import { r5dLaunchUrl } from "../src/plugins/r5d";
import { openDatabase } from "./db";
import { PluginService } from "./plugins";

const key = `r5d_team_${"a".repeat(20)}_${"b".repeat(64)}`;
async function until(fn: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out");
}
const session = (id = "s", status = "running", version = 1) => ({
  id,
  name: "Agent",
  parentSessionId: null,
  status,
  statusVersion: version,
  workItems: [{ source: "threadline", url: "https://issues.test/w/default/issues/1" }],
  links: { session: `https://r5d.test/t/acme/s/${id}` },
});
function setup(handler: (path: URL) => Response | Promise<Response>) {
  const db = openDatabase(":memory:");
  db.exec(`INSERT INTO users(id,name,email,role,createdAt) VALUES ('u','User','u@test','admin','now');
    INSERT INTO issues(id,number,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (1,1,'Issue','Body','todo','normal','[]','u','now','now');`);
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      expect(req.headers.get("Authorization")).toBe(`Bearer ${key}`);
      const url = new URL(req.url);
      requests.push(url.pathname + url.search);
      return handler(url);
    },
  });
  const service = new PluginService(db, {
    key: Buffer.alloc(32, 8),
    baseUrl: "https://issues.test",
    allowInsecureLocalhost: true,
  });
  const enable = () =>
    service.update("r5d", {
      enabled: true,
      values: { baseUrl: server.url.origin, team: "acme", apiKey: key },
    });
  return {
    db,
    server,
    service,
    requests,
    enable,
    async close() {
      await service.close();
      server.stop(true);
      db.close();
    },
  };
}
const json = (data: unknown) => Response.json(data);

for (const legacyScope of [undefined, "none", "session", "branch", "project"]) {
  test(`r5d sharing is per launch, not the saved ${legacyScope ?? "unset"} default`, async () => {
    const fixture = setup((url) => {
      if (url.pathname.endsWith("/acme")) return json({});
      if (url.pathname.endsWith("/sessions")) return json({ sessions: [session()], cursor: "1" });
      return json({ events: [], cursor: "1" });
    });
    const { db, service } = fixture;
    const user = { id: "u", role: "admin" } as User;
    try {
      expect(service.adminSettings()[0]!.values).not.toHaveProperty("defaultShare");
      await fixture.enable();
      await until(() => service.links("1").length === 1);
      db.exec(`INSERT INTO projects(id,slug,name,description,createdAt,visibility,ownerId) VALUES ('p','p','P','','now','private','u')`);
      const projects = [{ projectId: "p", remote: "git@github.com:acme/repo.git", defaultBranch: "main" }];
      await service.update("r5d", { enabled: true, values: { projects } });
      const before = db.query("SELECT value,secrets FROM plugin_settings WHERE pluginId='r5d'").get() as { value: string; secrets: string };
      // Simulate a settings row saved by the previous version, without resaving
      // or replacing its encrypted team key, mappings or running feed state.
      if (legacyScope !== undefined) db.query("UPDATE plugin_settings SET value=? WHERE pluginId='r5d'")
        .run(JSON.stringify({ ...JSON.parse(before.value), defaultShare: legacyScope }));
      const state = db.query("SELECT * FROM plugin_state").all();
      const links = service.links("1");
      const admin = service.adminSettings()[0]!;
      const publicSettings = service.publicSettings(user)[0]!;
      expect(admin.fields.map((field) => field.name)).not.toContain("defaultShare");
      expect(admin.values).not.toHaveProperty("defaultShare");
      expect(publicSettings.values).not.toHaveProperty("defaultShare");
      expect(publicSettings.values.projects).toEqual(projects);
      expect(admin.hasSecrets.apiKey).toBe(true);
      expect(JSON.stringify([admin, publicSettings])).not.toContain(key);
      const issue = db.query("SELECT *, 'default' AS workspaceSlug FROM issues WHERE id=1").get() as Issue;
      for (const projectId of [null, "p"]) {
        // Also ignore stale settings delivered by an older server/browser cache.
        const url = await r5dLaunchUrl({ ...publicSettings, values: { ...publicSettings.values, defaultShare: legacyScope } }, {
          issue: { ...issue, projectId }, comments: [], users: [], baseUrl: "https://issues.test",
        });
        const payload = JSON.parse(inflateSync(Buffer.from(new URL(url).hash.slice(1), "base64url")).toString());
        expect(payload.share).toEqual({ team: "acme", scope: "branch" });
        if (projectId) {
          expect(payload.remote).toBe(projects[0]!.remote);
          expect(payload.branch).toEqual({ mode: "new", name: "issue/default/1-issue", from: "main" });
        } else {
          expect(payload).not.toHaveProperty("remote");
          expect(payload).not.toHaveProperty("branch");
        }
      }
      // The generated admin form may save its full values without the old
      // field, and blank secrets still preserve the existing credential.
      await service.update("r5d", { enabled: true, values: { ...admin.values, apiKey: "" } });
      expect(db.query("SELECT value,secrets FROM plugin_settings WHERE pluginId='r5d'").get()).toEqual(before);
      expect(service.links("1")).toEqual(links);
      expect(db.query("SELECT * FROM plugin_state").all()).toEqual(state);
      await expect(service.update("r5d", { enabled: true, values: { defaultShare: "project" } })).rejects.toThrow("Unknown plugin setting");
    } finally {
      await fixture.close();
    }
  });
}

test("r5d resolves equal issue numbers by workspace and rejects legacy work-item URLs", async () => {
  const fixture = setup((url) => {
    if (url.pathname.endsWith("/acme")) return json({});
    if (url.pathname.endsWith("/sessions")) return json({ sessions: [
      session("default"),
      { ...session("second"), workItems: [{ source: "threadline", url: "https://issues.test/w/second/issues/1" }] },
      { ...session("legacy"), workItems: [{ source: "threadline", url: "https://issues.test/issues/1" }] },
      { ...session("missing"), workItems: [{ source: "threadline", url: "https://issues.test/w/missing/issues/1" }] },
    ], cursor: "1" });
    return json({ events: [], cursor: "1" });
  });
  try {
    fixture.db.exec(`INSERT INTO workspaces (id,slug,name,visibility,createdAt) VALUES ('second','second','Second','hidden','now');
      INSERT INTO issues(id,number,workspaceId,title,body,status,priority,labels,authorId,createdAt,updatedAt)
      VALUES (2,1,'second','Second issue','Body','todo','normal','[]','u','now','now');`);
    await fixture.enable();
    await until(() => fixture.service.links("2").length === 1);
    expect(fixture.service.links("1").map((l) => l.externalId)).toEqual(["session:default"]);
    expect(fixture.service.links("2").map((l) => l.externalId)).toEqual(["session:second"]);
  } finally { await fixture.close(); }
});

test("r5d snapshot, exact work-item matching, newer versions, dedup, reviews, revoke and truncation", async () => {
  let listCount = 0;
  const queue: unknown[] = [];
  const fixture = setup((url) => {
    if (url.pathname.endsWith("/acme")) return json({});
    if (url.pathname.endsWith("/sessions")) {
      listCount++;
      return json({
        sessions:
          listCount === 1
            ? [
                session(),
                { ...session("child"), parentSessionId: "s" },
                {
                  ...session("foreign"),
                  workItems: [
                    {
                      source: "threadline",
                      url: "https://other.test/w/default/issues/1",
                    },
                  ],
                },
                {
                  ...session("suffix"),
                  workItems: [
                    {
                      source: "threadline",
                      url: "https://issues.test/w/default/issues/1/extra",
                    },
                  ],
                },
              ]
            : [],
        cursor: String(listCount * 10),
      });
    }
    return json(
      queue.shift() ?? {
        events: [],
        cursor: url.searchParams.get("after") ?? "10",
        hasMore: false,
      },
    );
  });
  const { service } = fixture;
  try {
    await fixture.enable();
    await until(() => service.links("1").length === 1);
    expect(fixture.requests[1]).toEndWith("/sessions");
    expect(fixture.requests[2]).toContain("after=10&wait=30");
    expect(service.links("1")[0]!.status).toBe("Running");
    queue.push({
      events: [
        {
          id: "a",
          type: "session.status",
          data: {
            sessionId: "s",
            status: "completed",
            version: 5,
            session: session(),
          },
        },
        {
          id: "a",
          type: "session.status",
          data: {
            sessionId: "s",
            status: "failed",
            version: 9,
            session: session(),
          },
        },
        {
          id: "b",
          type: "session.status",
          data: {
            sessionId: "s",
            status: "failed",
            version: 5,
            session: session(),
          },
        },
        {
          id: "c",
          type: "branch.review_request",
          data: {
            sessionIds: ["s"],
            reviewRequest: {
              url: "https://github.com/acme/repo/pull/1",
              title: "Fix",
              status: "open",
            },
          },
        },
      ],
      cursor: "11",
    });
    await until(() => service.links("1").length === 2);
    expect(
      service.links("1").find((link) => link.externalId === "session:s")!
        .status,
    ).toBe("Completed");
    queue.push({
      events: [{ id: "d", type: "share.revoked", data: { sessionIds: ["s"] } }],
      cursor: "12",
    });
    await until(() => service.links("1").length === 0);
    queue.push({
      events: [
        { id: "e", type: "session.shared", data: { session: session("new") } },
      ],
      cursor: "13",
    });
    await until(() => service.links("1").length === 1);
    queue.push({ truncated: true, events: [], cursor: "14" });
    await until(() => listCount === 2 && service.links("1").length === 0);
    await service.update("r5d", { enabled: false, values: {} });
    const requestsBefore = listCount;
    await service.update("r5d", { enabled: true, values: {} });
    await Bun.sleep(50);
    expect(listCount).toBe(requestsBefore); // Durable cursor resumes without losing links/reviews.
    expect(JSON.stringify(service.adminSettings())).not.toContain(key);
    expect(
      JSON.stringify(fixture.db.query("SELECT * FROM plugin_settings").all()),
    ).not.toContain(key);
    await expect(
      service.update("r5d", {
        enabled: true,
        values: { team: "different", apiKey: "" },
      }),
    ).rejects.toThrow("Re-enter");
  } finally {
    await fixture.close();
  }
});

for (const code of [401, 404])
  test(`r5d fatal ${code} stops feed and explains safely`, async () => {
    let events = 0;
    const fixture = setup((url) => {
      if (url.pathname.endsWith("/acme")) return json({});
      if (url.pathname.endsWith("/sessions"))
        return json({ sessions: [], cursor: "1" });
      events++;
      return new Response(key, { status: code });
    });
    try {
      await fixture.enable();
      await until(
        () => fixture.service.adminSettings()[0]!.status.state === "error",
      );
      expect(fixture.service.adminSettings()[0]!.status.error).toContain(
        code === 401 ? "rejected" : "not found",
      );
      await Bun.sleep(50);
      expect(events).toBe(1);
      expect(JSON.stringify(fixture.service.adminSettings())).not.toContain(
        key,
      );
    } finally {
      await fixture.close();
    }
  });

test("r5d transient errors back off, recover, and skip malformed snapshots", async () => {
  let lists = 0;
  const fixture = setup((url) => {
    if (url.pathname.endsWith("/acme")) return json({});
    if (url.pathname.endsWith("/sessions")) {
      lists++;
      if (lists === 1) return new Response("temporary", { status: 503 });
      return json({
        sessions: [
          null,
          {},
          { ...session("bad"), links: { session: "javascript:alert(1)" } },
          session(),
        ],
        cursor: "1",
      });
    }
    return json({ events: [], cursor: "1" });
  });
  try {
    await fixture.enable();
    await until(
      () => fixture.service.adminSettings()[0]!.status.state === "retrying",
    );
    await Bun.sleep(100);
    expect(lists).toBe(1);
    await until(() => fixture.service.links("1").length === 1);
    expect(lists).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("r5d redirects rejected during credential check; disabled save does not send key", async () => {
  const fixture = setup(
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://elsewhere.test" },
      }),
  );
  try {
    await expect(fixture.enable()).rejects.toThrow("Unable to check");
    expect(fixture.service.adminSettings()[0]!.enabled).toBe(false);
    await fixture.service.update("r5d", {
      enabled: false,
      values: { baseUrl: fixture.server.url.origin, team: "acme", apiKey: key },
    });
    expect(fixture.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

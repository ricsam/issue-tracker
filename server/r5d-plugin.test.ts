import { expect, test } from "bun:test";
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
  workItems: [{ source: "threadline", url: "https://issues.test/issues/1" }],
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
                      url: "https://other.test/issues/1",
                    },
                  ],
                },
                {
                  ...session("suffix"),
                  workItems: [
                    {
                      source: "threadline",
                      url: "https://issues.test/issues/1/extra",
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

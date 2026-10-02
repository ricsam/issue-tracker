import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import {
  deriveIssueTitle,
  ISSUE_BODY_MAX_LENGTH,
  prependLegacyTitle,
} from "../shared/issue-content";

test("Markdown title derivation ignores code, renders inline headings and handles plain/image-only content", () => {
  for (const [body, title] of [
    ["Plain first line\nsecond", "Plain first line"],
    ["intro\n## **Bold** [link](https://example.com) `code`", "Bold link code"],
    ["Setext _title_\n====", "Setext title"],
    ["```md\n# Fake\n```\n# Real", "Real"],
    ["~~~\n# Fake\n~~~\nactual text", "actual text"],
    ["    # indented code", "Untitled issue"],
    ["![image](url)", "Untitled issue"],
    ["![image][ref]\n\n[ref]: https://example.com/image.png", "Untitled issue"],
    ["- [ ] Fix the issue", "Fix the issue"],
    ["# Fix user_id and `**literal**`", "Fix user_id and **literal**"],
    ["# [Launch](https://example.com/path_(v1))", "Launch"],
    ["# [Launch][ref]", "Launch"],
    ["```\ncode\n```", "Untitled issue"],
  ])
    expect(deriveIssueTitle(body!)).toBe(title!);
  expect(deriveIssueTitle("a".repeat(400))).toHaveLength(300);
  expect(prependLegacyTitle("Hello", "# Hello\n\noriginal\r\n")).toBe(
    "# Hello\n\noriginal\r\n",
  );
});

test("body-only and legacy writes, validation limits, metadata preservation and real legacy migrations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-content-test-"));
  let app = createApp({ dataDir: dir });
  let cookie = "";
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        Origin: "http://localhost:3000",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const setup = await req("/api/auth/setup", "POST", {
      name: "Admin",
      email: "content@example.com",
      password: "long-password-123",
    });
    cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const project = (
      await (await req("/api/projects", "POST", { name: "Content" })).json()
    ).project;
    const path = `/api/projects/${project.slug}/issues`;
    const created = await req(path, "POST", {
      body: "## **Hello**\n\nDescription",
    });
    expect(created.status).toBe(200);
    let issue = (await created.json()).issue;
    expect(issue.title).toBe("Hello");
    const patch = async (body: unknown) =>
      req(`/api/issues/${issue.id}`, "PATCH", body);
    for (const body of ["", " \n\t", "a".repeat(ISSUE_BODY_MAX_LENGTH + 1)]) {
      expect((await req(path, "POST", { body })).status).toBe(400);
      expect((await patch({ body })).status).toBe(400);
    }
    expect(
      (await req(path, "POST", { body: "x".repeat(ISSUE_BODY_MAX_LENGTH) }))
        .status,
    ).toBe(200);
    let response = await patch({ title: "New [literal]" });
    issue = (await response.json()).issue;
    expect(issue.body).toBe("# New \\[literal\\]\n\nDescription");
    expect(issue.title).toBe("New [literal]");
    response = await patch({ status: "done" });
    expect((await response.json()).issue.body).toBe(issue.body);
    response = await patch({ body: "Plain replacement" });
    issue = (await response.json()).issue;
    expect(issue.title).toBe("Plain replacement");
    response = await patch({ title: "Combined", body: "New remainder" });
    issue = (await response.json()).issue;
    expect(issue.body).toBe("# Combined\n\nNew remainder");
    const legacy = (
      await (await req(path, "POST", { title: "Old", body: "" })).json()
    ).issue;
    expect(legacy.body).toBe("# Old\n\n");
    expect(
      (
        await req(path, "POST", {
          title: "*".repeat(300),
          body: "b".repeat(100000),
        })
      ).status,
    ).toBe(200);
    // Exercise populated v2 and v1 schemas, preserving timestamps and original bytes.
    for (const version of [2, 1]) {
      const original = "\r\nLegacy bytes  \n\n";
      app.db
        .query("UPDATE issues SET title=?,body=? WHERE id=?")
        .run("Old *title*", original, issue.id);
      app.db
        .query("UPDATE issues SET title=?,body=? WHERE id=?")
        .run("Old", "# Old\r\n\r\nkeep", legacy.id);
      const before = app.db
        .query("SELECT * FROM issues WHERE id=?")
        .get(issue.id) as any;
      app.db.exec("DELETE FROM migrations WHERE version=3;");
      if (version === 1)
        app.db.exec(
          "DROP TABLE project_boards; DELETE FROM migrations WHERE version=2;",
        );
      app.close();
      app = createApp({ dataDir: dir });
      const migrated = app.db
        .query("SELECT * FROM issues WHERE id=?")
        .get(issue.id) as any;
      expect(migrated.body).toBe("# Old \\*title\\*\n\n" + original);
      expect(migrated).toEqual({
        ...before,
        body: migrated.body,
        title: deriveIssueTitle(migrated.body),
      });
      expect(
        (
          app.db
            .query("SELECT body FROM issues WHERE id=?")
            .get(legacy.id) as any
        ).body,
      ).toBe("# Old\r\n\r\nkeep");
      app.close();
      app = createApp({ dataDir: dir });
      expect(
        app.db.query("SELECT * FROM issues WHERE id=?").get(issue.id),
      ).toEqual(migrated);
    }
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

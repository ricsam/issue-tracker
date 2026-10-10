import type { Database } from "bun:sqlite";
import type { User } from "../shared/types";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { accessParams, visibleIssueSql } from "./project-access";

const parser = unified().use(remarkParse).use(remarkGfm);
// URLs visible even in source/code/history can be copied, so retain their access
// relationship too. Also parse Markdown links/images/references: Markdown escapes,
// entities, percent-encoded IDs and URL dot segments must not bypass the index.
export function attachmentIds(body: string): string[] {
  const ids = new Set<string>();
  const collect = (value: string) => {
    const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    for (const match of decoded.matchAll(/\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//gi))
      ids.add(match[1]!.toLowerCase());
  };
  collect(body);
  type Node = { type: string; url?: string; children?: Node[] };
  const walk = (node: Node) => {
    if (node.url) {
      collect(node.url);
      try { collect(new URL(node.url, "http://attachments.invalid/").pathname); } catch { /* Not a URL. */ }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(parser.parse(body));
  return [...ids];
}

/** Append-only because saved content remains available in issue history. */
export function retainAttachmentReferences(db: Database, issueId: string | number, bodies: string[]) {
  for (const id of new Set(bodies.flatMap(attachmentIds)))
    db.query("INSERT OR IGNORE INTO issue_attachments (issueId,attachmentId) SELECT ?,id FROM attachments WHERE id=?")
      .run(issueId, id);
}

export function canReadAttachment(db: Database, attachmentId: string, user: User): boolean {
  return !!db.query(`SELECT 1 FROM attachments a WHERE a.id=? AND (
    ?='admin' OR EXISTS (
      SELECT 1 FROM issue_attachments ia JOIN issues i ON i.id=ia.issueId
      WHERE ia.attachmentId=a.id AND ${visibleIssueSql}
    ) OR (a.uploaderId=? AND NOT EXISTS (
      SELECT 1 FROM issue_attachments ia WHERE ia.attachmentId=a.id
    ))
  )`).get(attachmentId, user.role, ...accessParams(user), user.id);
}

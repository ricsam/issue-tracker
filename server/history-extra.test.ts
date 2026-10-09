import { test, expect } from "bun:test";
import { openDatabase } from "./db";
import { issueSnapshot, recordIssueChange, withIssueHistory, readHistory } from "./history";

test("history snapshots custom lane labels and same-name project identity, with atomic rollback", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`INSERT INTO users (id,name,email,role,createdAt) VALUES ('user','User','u@example.com','admin','now');
      INSERT INTO projects (id,slug,name,description,createdAt) VALUES ('a','a','Same name','','now'),('b','b','Same name','','now');
      INSERT INTO project_boards VALUES ('a','["custom_lane"]','[{"value":"custom_lane","label":"Review & ship"}]');
      INSERT INTO issues (number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (1,'a','One','# One','backlog','none','[]','user','now','now');
      INSERT INTO board_issues VALUES ('a','1','custom_lane',1);`);
    expect(issueSnapshot(db, "1")?.boardLane).toBe("Review & ship");
    db.transaction(() => recordIssueChange(db, "1", "user", null)).immediate();
    withIssueHistory(db, "user", ["1"], () => {
      db.exec("DELETE FROM board_issues; UPDATE issues SET projectId='b' WHERE id=1");
    });
    expect(readHistory(db, "1", null, 50).history[0]!.changes).toEqual([
      { field: "project", before: "Same name", after: "Same name" },
      { field: "boardLane", before: "Review & ship", after: null },
    ]);
    const before = readHistory(db, "1", null, 50);
    expect(() => withIssueHistory(db, "user", ["1"], () => {
      db.exec("UPDATE issues SET body='Not committed' WHERE id=1");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(readHistory(db, "1", null, 50)).toEqual(before);
    expect(issueSnapshot(db, "1")?.body).toBe("# One");
    withIssueHistory(db, "user", ["1"], () => db.exec("UPDATE issues SET updatedAt='later' WHERE id=1"));
    expect(readHistory(db, "1", null, 50)).toEqual(before);
  } finally { db.close(); }
});

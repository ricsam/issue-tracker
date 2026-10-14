import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { z } from "zod";

// Run offline with the server stopped. Password comes from stdin, never argv/logs.
export async function recoverAdmin(
  databasePath: string,
  email: string,
  password: string,
) {
  email = z.email().parse(email).toLowerCase();
  z.string().min(12).max(1024).parse(password);
  const db = new Database(databasePath, {
    readonly: false,
    create: false,
    strict: true,
  });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const user = db
      .query("SELECT id FROM users WHERE email=? AND role='admin'")
      .get(email) as { id: string } | null;
    if (!user) throw new Error("Existing administrator not found");
    const hashed = await Bun.password.hash(password, { algorithm: "argon2id" });
    db.transaction(() => {
      db.query("UPDATE users SET password=? WHERE id=? AND role='admin'").run(
        hashed,
        user.id,
      );
      db.query("DELETE FROM sessions WHERE userId=?").run(user.id);
      // Recovery must also evict delegated access; tolerate pre-v18 databases.
      if (db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='api_keys'").get()) {
        db.query("UPDATE api_keys SET revokedAt=COALESCE(revokedAt,?) WHERE userId=?").run(new Date().toISOString(), user.id);
        db.query("DELETE FROM device_authorizations WHERE userId=?").run(user.id);
      }
    }).immediate();
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  try {
    const email = process.argv[2];
    if (!email || process.stdin.isTTY) throw new Error();
    const password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
    await recoverAdmin(
      resolve(process.env.DATA_DIR ?? "data", "app.sqlite"),
      email,
      password,
    );
    console.log("Administrator password reset; existing sessions and API credentials invalidated.");
  } catch {
    console.error(
      "Recovery failed. Stop the server, supply an existing admin email as the sole argument and a 12–1024 character password on stdin.",
    );
    process.exitCode = 1;
  }
}

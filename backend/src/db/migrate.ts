import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

await pool.query(
  "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
);

for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]);
  if (done.rowCount) { console.log("skip", f); continue; }
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(readFileSync(path.join(dir, f), "utf8"));
    await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [f]);
    await c.query("COMMIT");
    console.log("applied", f);
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("FAILED", f, e);
    process.exitCode = 1;
    break;
  } finally {
    c.release();
  }
}
await pool.end();
/**
 * Applies supabase/migrations/*.sql to DATABASE_URL in order, recording each in
 * app_private.applied_migrations (for environments without the Supabase CLI).
 * With the CLI, prefer `supabase db push` / `supabase db reset` instead.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate            # migrations only
 *   DATABASE_URL=postgres://... npm run db:migrate -- --seed  # plus demo seed (demo data!)
 */
import fs from "node:fs";
import path from "node:path";
import { createPostgresDb } from "../src/lib/db/postgres";
import { migrationFiles } from "../src/lib/db/pglite";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createPostgresDb(url, { max: 1, ssl: process.env.DATABASE_SSL === "true" });
  await db.exec(`create schema if not exists app_private;
    create table if not exists app_private.applied_migrations (name text primary key, applied_at timestamptz not null default now());`);
  const { rows } = await db.query<{ name: string }>(`select name from app_private.applied_migrations`);
  const done = new Set(rows.map((r) => r.name));
  for (const file of migrationFiles()) {
    const name = path.basename(file);
    if (done.has(name)) continue;
    await db.tx(async (tx) => {
      // No parameters, so node-postgres uses the simple protocol and multi-statement files run as-is.
      await tx.query(fs.readFileSync(file, "utf8"));
      await tx.query(`insert into app_private.applied_migrations (name) values ($1)`, [name]);
    });
    console.log(`applied ${name}`);
  }
  if (process.argv.includes("--seed")) {
    await db.exec(fs.readFileSync(path.resolve("supabase/seed.sql"), "utf8"));
    console.log("seeded DEMO data (synthetic staff, sample policy, placeholder rates)");
  }
  await db.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

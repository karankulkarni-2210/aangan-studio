/**
 * Drafts config/policy.demo.json as a new policy version and publishes it (audited, as the first
 * active administrator). Calls already in progress keep the version they started with.
 *   npm run policy:publish
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createPostgresDb } from "../src/lib/db/postgres";
import type { StaffActor } from "../src/lib/http/route";
import { createDraft, publishPolicy } from "../src/lib/services/policies";

async function main() {
  if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = JSON.parse(fs.readFileSync("config/policy.demo.json", "utf8"));
  const db = createPostgresDb(url, { max: 1, ssl: process.env.DATABASE_SSL === "true" });
  const { rows } = await db.query<StaffActor>(`select id, auth_user_id, role, display_name, email from public.staff where role = 'admin' and active order by created_at limit 1`);
  if (!rows[0]) throw new Error("no active administrator to publish as");
  const requestId = `policy-publish-${randomUUID()}`;
  const draft = await db.tx((tx) => createDraft(tx, rows[0], config, requestId));
  if (!draft.validation.ok) {
    console.error("Draft is invalid; not published:", JSON.stringify(draft.validation.issues, null, 2));
    process.exit(1);
  }
  const published = await db.tx((tx) => publishPolicy(tx, rows[0], draft.policy.id, requestId));
  console.log(`Published policy v${published.version} (${published.label}).`);
  await db.close?.();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

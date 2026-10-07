import { randomBytes } from "node:crypto";
import { env } from "@/lib/config/env";
import { createPostgresDb } from "@/lib/db/postgres";
import type { Db } from "@/lib/db/types";

// Process-wide dependencies with explicit overrides for tests, the demo script and the in-process
// simulator. Route handlers obtain everything through these accessors.

let dbOverride: Db | null = null;
let dbInstance: Promise<Db> | null = null;

/**
 * DATABASE_URL=postgres://...  -> Supabase Postgres (pooled).
 * DATABASE_URL=pglite:<dir>    -> embedded Postgres for local demo only (auto-migrated and seeded);
 *                                 refused in live mode.
 */
export async function getDb(): Promise<Db> {
  if (dbOverride) return dbOverride;
  if (!dbInstance) {
    const url = env.databaseUrl();
    if (!url) throw new MissingDatabaseError();
    if (url.startsWith("pglite:")) {
      if (env.appMode() !== "demo") throw new MissingDatabaseError();
      dbInstance = (async () => {
        const { createPgliteDb } = await import("@/lib/db/pglite");
        const { demoSeedSql } = await import("@/lib/seed/demo");
        const db = await createPgliteDb({ dataDir: url.slice("pglite:".length) || undefined });
        const { rows } = await db.query(`select count(*)::int as n from public.staff`);
        if (rows[0].n === 0) await db.exec(demoSeedSql());
        return db;
      })();
    } else {
      dbInstance = Promise.resolve(createPostgresDb(url, { max: env.databasePoolMax(), ssl: env.databaseSsl() }));
    }
    dbInstance.catch(() => {
      dbInstance = null;
    });
  }
  return dbInstance;
}

export class MissingDatabaseError extends Error {
  constructor() {
    super("DATABASE_URL is not configured");
  }
}

export function setDb(db: Db | null): void {
  dbOverride = db;
}

// Clock -------------------------------------------------------------------------------------

let clockOverride: (() => Date) | null = null;
export const now = (): Date => (clockOverride ? clockOverride() : new Date());
export function setClock(fn: (() => Date) | null): void {
  clockOverride = fn;
}

// Demo-only ephemeral secrets -----------------------------------------------------------------

/**
 * In demo mode, the in-process simulator signs its own webhooks and tool calls. When the operator
 * has not configured secrets, generate random per-process values instead of falling back to any
 * fixed credential. Never runs in live mode.
 */
export function ensureEphemeralDemoSecrets(): void {
  if (env.appMode() !== "demo") return;
  for (const name of ["SIMULATED_VOICE_WEBHOOK_SECRET", "VOICE_TOOL_SECRET"]) {
    if (!process.env[name]) process.env[name] = randomBytes(32).toString("hex");
  }
}

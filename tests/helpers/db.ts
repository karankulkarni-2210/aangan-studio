import { createPgliteDb } from "@/lib/db/pglite";
import type { Db } from "@/lib/db/types";
import { setExtractor } from "@/lib/ai/extractor";
import { setProviderOverrides } from "@/lib/providers/registry";
import { setClock, setDb } from "@/lib/runtime";
import { demoSeedSql } from "@/lib/seed/demo";
import { configureTestEnv } from "./env";

export async function createTestDb(opts: { seed?: boolean } = {}): Promise<Db> {
  configureTestEnv();
  const db = await createPgliteDb();
  if (opts.seed !== false) await db.exec(demoSeedSql());
  setDb(db);
  setProviderOverrides(null);
  setExtractor(null);
  setClock(null);
  return db;
}

export async function seedOnly(db: Db): Promise<void> {
  await db.exec(demoSeedSql());
}

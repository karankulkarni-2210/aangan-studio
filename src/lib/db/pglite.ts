import { PGlite, types } from "@electric-sql/pglite";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { makeTx, type Db, type QueryResult, type Row } from "./types";

// Embedded Postgres (WASM) for tests and the offline demo. It runs the same SQL migrations as
// Supabase, preceded by a small shim that creates the Supabase auth schema and client roles.

const ROOT = path.resolve(process.cwd());

export const SUPABASE_SHIM_SQL = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
`;

export function migrationFiles(dir = path.join(ROOT, "supabase", "migrations")): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(dir, f));
}

// Match the node-postgres configuration: numeric (1700) and int8 (20) come back as JS numbers.
function normalise<T>(r: { rows: T[]; fields: Array<{ name: string; dataTypeID: number }> }): T[] {
  const numeric = r.fields.filter((f) => f.dataTypeID === 1700 || f.dataTypeID === 20).map((f) => f.name);
  if (numeric.length === 0) return r.rows;
  for (const row of r.rows as Array<Record<string, unknown>>) {
    for (const k of numeric) if (typeof row[k] === "string" || typeof row[k] === "bigint") row[k] = Number(row[k]);
  }
  return r.rows;
}

function wrap(pg: PGlite): Db {
  // PGlite serialises queries on one connection. Queries issued outside a transaction while a
  // transaction is open would interleave, so non-transactional queries wait for the lock.
  let chain: Promise<unknown> = Promise.resolve();
  const inTx = new AsyncLocalStorage<boolean>();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    if (inTx.getStore()) {
      // Would deadlock on the single connection; on real Postgres it would silently escape the transaction.
      return Promise.reject(new Error("db used inside a transaction: use the tx handle instead"));
    }
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const query = <T extends Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> =>
    exclusive(async () => {
      const r = await pg.query<T>(sql, params);
      return { rows: normalise(r), rowCount: r.affectedRows || r.rows.length };
    });
  return {
    kind: "pglite",
    query,
    exec: (sql) => exclusive(async () => {
      await pg.exec(sql);
    }),
    tx: (fn) =>
      exclusive(() =>
        pg.transaction((t) => inTx.run(true, async () => {
          const tx = makeTx({
            query: async <T extends Row>(sql: string, params: unknown[] = []) => {
              const r = await t.query<T>(sql, params);
              return { rows: normalise(r), rowCount: r.affectedRows || r.rows.length };
            },
          });
          return fn(tx);
        })),
      ),
    close: () => pg.close(),
  };
}

export async function createPgliteDb(opts: { dataDir?: string; migrate?: boolean } = {}): Promise<Db> {
  const pg = new PGlite(opts.dataDir, {
    parsers: {
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
    },
  });
  await pg.waitReady;
  if (opts.migrate !== false) {
    const applied = await pg
      .query<{ exists: boolean }>(`select to_regclass('public.leads') is not null as exists`)
      .then((r) => r.rows[0]?.exists);
    if (!applied) {
      await pg.exec(SUPABASE_SHIM_SQL);
      for (const file of migrationFiles()) await pg.exec(fs.readFileSync(file, "utf8"));
    }
  }
  return wrap(pg);
}

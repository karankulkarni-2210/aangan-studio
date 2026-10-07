import pg from "pg";
import { makeTx, type Db, type QueryResult, type Row } from "./types";

// Integer and numeric columns are returned as JS numbers. Paise values are bigint in SQL but stay
// far below 2^53 (about ₹90 trillion), so Number is exact for this domain.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

/**
 * node-postgres pool. Compatible with the Supabase transaction pooler (port 6543):
 * no named/prepared statements and no session-level SET (only SET LOCAL inside transactions).
 */
export function createPostgresDb(connectionString: string, opts: { max?: number; ssl?: boolean } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 3,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  const query = async <T extends Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    const r = await pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  };
  return {
    kind: "postgres",
    query,
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const tx = makeTx({
          query: async <T extends Row>(sql: string, params: unknown[] = []) => {
            const r = await client.query(sql, params);
            return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
          },
        });
        const result = await fn(tx);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

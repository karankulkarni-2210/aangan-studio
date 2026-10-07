export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Tx extends Queryable {
  /**
   * Runs `fn` as the Supabase `authenticated` role with the given auth user as `auth.uid()`,
   * so row-level security policies filter every query. Restores the service role afterwards.
   */
  asStaff<T>(authUserId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface Db extends Queryable {
  readonly kind: "postgres" | "pglite";
  /** Runs a multi-statement SQL script (no parameters). For migrations and seeds only. */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function makeTx(q: Queryable): Tx {
  return {
    query: (sql, params) => q.query(sql, params),
    async asStaff(authUserId, fn) {
      await q.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: authUserId, role: "authenticated", aud: "authenticated" }),
      ]);
      await q.query(`set local role authenticated`);
      const result = await fn(q);
      // On error the transaction aborts and the role reverts with it.
      await q.query(`reset role`);
      return result;
    },
  };
}

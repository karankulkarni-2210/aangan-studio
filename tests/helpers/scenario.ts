import type { Db } from "@/lib/db/types";
import { runScenario } from "@/lib/simulation/runner";
import { getScenario } from "@/lib/simulation/scenarios";

export async function simulate(db: Db, id: string, opts: { runJobs?: boolean } = {}) {
  const s = getScenario(id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return runScenario(db, s, { runJobs: opts.runJobs ?? true });
}

export async function leadRow(db: Db, leadId: string) {
  const { rows } = await db.query(`select * from public.leads where id = $1`, [leadId]);
  return rows[0];
}

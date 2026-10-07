import { env, INTEGRATION_ENV, integrationMode, liveSecurityGaps, missingEnv } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { INTEGRATION_PROVIDERS } from "@/lib/domain/enums";
import { getActivePolicy } from "./policies";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
}

/** Dependency and configuration readiness. Reports booleans and variable NAMES, never values. */
export async function readiness(db: Db) {
  const checks: Check[] = [];
  const live = env.appMode() === "live";
  try {
    const { rows } = await db.query(`select to_regclass('public.leads') is not null as leads, to_regclass('public.outbox_jobs') is not null as outbox`);
    checks.push({ name: "database", ok: true, detail: "reachable", blocking: true });
    checks.push({ name: "migrations", ok: rows[0].leads && rows[0].outbox, detail: rows[0].leads ? "schema present" : "schema missing: apply supabase/migrations", blocking: true });
    const policy = await db.tx((tx) => getActivePolicy(tx));
    checks.push({ name: "active_policy", ok: Boolean(policy), detail: policy ? `v${policy.version}${policy.is_demo ? " (demo sample rules)" : ""}` : "no valid active policy: calls fall back to message-taking and needs_review", blocking: true });
    if (live && policy?.is_demo) checks.push({ name: "live_policy_not_demo", ok: false, detail: "live mode is running demo sample rules; publish a real policy", blocking: false });
    const { rows: roster } = await db.query(`select count(*)::int as n from public.staff where role = 'designer' and active and approved_for_handoff`);
    checks.push({ name: "designer_roster", ok: roster[0].n > 0, detail: `${roster[0].n} approved designer(s); without any, qualified leads go to the front-desk queue`, blocking: false });
    const { rows: dispatcher } = await db.query(`select max(finished_at) as last from public.dispatcher_runs`);
    checks.push({ name: "dispatcher", ok: Boolean(dispatcher[0].last), detail: dispatcher[0].last ? `last run ${new Date(dispatcher[0].last).toISOString()}` : "never run: configure the schedule", blocking: false });
  } catch {
    checks.push({ name: "database", ok: false, detail: "unreachable or not configured", blocking: true });
  }
  if (live) {
    const gaps = liveSecurityGaps();
    checks.push({ name: "live_security_configuration", ok: gaps.length === 0, detail: gaps.length ? `missing: ${gaps.join(", ")}` : "complete", blocking: true });
  } else {
    checks.push({ name: "demo_mode", ok: true, detail: "demo mode: missing credentials select explicit mock adapters; simulated calls are labelled", blocking: false });
  }
  const ready = checks.every((c) => c.ok || !c.blocking);
  return {
    ready,
    app_mode: env.appMode(),
    checks,
    integrations: INTEGRATION_PROVIDERS.map((p) => ({ provider: p, mode: integrationMode(p), missing_env: missingEnv(INTEGRATION_ENV[p]) })),
  };
}

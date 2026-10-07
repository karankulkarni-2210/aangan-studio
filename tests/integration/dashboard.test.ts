import { beforeEach, describe, expect, it } from "vitest";
import * as costRoute from "@/app/api/v1/cost-entries/route";
import * as dashboardRoute from "@/app/api/v1/dashboard/route";
import * as outcomesRoute from "@/app/api/v1/leads/[id]/outcomes/route";
import * as statusRoute from "@/app/webhooks/voice/[provider]/status/route";
import { Dashboard } from "@/lib/api/schemas";
import type { Db } from "@/lib/db/types";
import { runDispatcher } from "@/lib/jobs/handlers";
import { percentile } from "@/lib/services/dashboard";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { leadRow, simulate } from "../helpers/scenario";
import { signedWebhook } from "../helpers/voice";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const dash = async (query = "", as: "admin" | "front_desk" = "admin") => {
  const res = await call(dashboardRoute.GET, "GET", `/api/v1/dashboard${query}`, { as });
  expect(res.status).toBe(200);
  const parsed = Dashboard.safeParse(res.body);
  if (!parsed.success) console.error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 1));
  expect(parsed.success).toBe(true);
  return res.body;
};

describe("dashboard", () => {
  it("zero denominators produce null rates, never 0% or NaN", async () => {
    const d = await dash();
    expect(d.metrics.five_minute_response).toMatchObject({ numerator: 0, denominator: 0, rate: null });
    expect(d.metrics.response_time_seconds).toEqual({ p50: null, p95: null, sample_size: 0 });
    expect(d.metrics.cohort_conversion.won_rate).toBeNull();
    expect(d.costs.cost_per_qualified_lead_paise).toBeNull();
    expect(d.costs.cost_per_confirmed_consultation_paise).toBeNull();
    expect(d.costs.total_operating_paise).toBeGreaterThan(0); // fixed (synthetic) charges still accrue
  });

  it("measures five-minute compliance with visible exclusions and failures", async () => {
    await simulate(db, "suitable_home");
    await simulate(db, "missing_budget");
    const now = Math.floor(Date.now() / 1000);
    const missed = { id: "evt_missed", type: "call.failed", created: now, data: { call_id: "missed-1", status: "no_answer", arrived_at: new Date((now - 60) * 1000).toISOString(), ended_at: new Date((now - 30) * 1000).toISOString() } };
    await signedWebhook(statusRoute.POST, "/webhooks/voice/simulated/status", missed);
    const spam = { id: "evt_spam", type: "call.failed", created: now, data: { call_id: "spam-1", status: "busy", sla_exclusion: "spam", arrived_at: new Date((now - 50) * 1000).toISOString() } };
    await signedWebhook(statusRoute.POST, "/webhooks/voice/simulated/status", spam);
    await runDispatcher(db, { trigger: "test" });
    const d = await dash();
    const f = d.metrics.five_minute_response;
    expect(f).toMatchObject({ numerator: 2, denominator: 3, rate: 0.6667, exclusions: { spam: 1 } });
    expect(f.not_responded.missed_or_failed).toBe(1);
    expect(d.metrics.calls).toMatchObject({ total: 4, eligible: 3, missed_or_failed: 2 });
    expect(d.metrics.leads.unique).toBe(4); // calls and unique leads counted separately
    expect(d.data_labels).toMatchObject({ contains_simulated_data: true, demo_policy: true, label: "Demo data and sample business rules" });
    const { rows } = await db.query(`select kind from public.human_tasks where call_id = (select id from public.calls where provider_call_id = 'missed-1')`);
    expect(rows.map((t) => t.kind)).toContain("callback");
  });

  it("separates live and simulated data on request", async () => {
    await simulate(db, "suitable_home");
    const live = await dash("?data=live");
    expect(live.metrics.calls.total).toBe(0);
    const sim = await dash("?data=simulated");
    expect(sim.metrics.calls.total).toBe(1);
  });

  it("costs: bundled speech is not double counted; invoices replace estimates; dev tools excluded", async () => {
    await simulate(db, "suitable_home");
    const d = await dash();
    const vaaniVoice = d.costs.lines.find((l: { provider: string; category: string }) => l.provider === "vaani" && l.category === "voice_telephony");
    const vaaniSpeech = d.costs.lines.find((l: { provider: string; category: string }) => l.provider === "vaani" && l.category === "speech");
    expect(vaaniVoice.amount_paise).toBeGreaterThan(0);
    expect(vaaniVoice.amount_paise % 240).toBe(0); // per started minute at the published voicebot rate
    expect(vaaniSpeech).toMatchObject({ amount_paise: 0, bundled_quantity: vaaniVoice.components[0].quantity });
    const gemini = d.costs.lines.find((l: { provider: string }) => l.provider === "gemini");
    expect(gemini).toMatchObject({ includes_simulated_usage: true, synthetic_rates: true });
    expect(d.costs.excluded_development_paise).toBeGreaterThan(0);
    expect(d.costs.lines.find((l: { provider: string }) => l.provider === "claude").operating_cost).toBe(false);
    expect(d.costs.cost_per_qualified_lead_paise).toBe(d.costs.total_operating_paise);

    const from = d.period.from;
    const inv = await call(costRoute.POST, "POST", "/api/v1/cost-entries", {
      as: "admin",
      body: { provider: "vercel", category: "hosting", amount_micros: 30_000_000, currency: "USD", fx_rate_to_inr: 87.5, fx_source: "Invoice INV-1 (test)", period_start: from, period_end: d.period.to, invoice_ref: "INV-1" },
    });
    expect(inv.status).toBe(201);
    const d2 = await dash(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(d.period.to)}`);
    const vercel = d2.costs.lines.find((l: { provider: string }) => l.provider === "vercel");
    expect(vercel).toMatchObject({ basis: "invoiced", invoiced_paise: 262500, amount_paise: 262500 });
    expect(vercel.variance_paise).toBe(262500 - vercel.estimated_paise);
    expect(d2.costs.currency_assumptions).toEqual(expect.arrayContaining([expect.objectContaining({ currency: "USD", fx_rate_to_inr: 88 })]));
  });

  it("a partial invoice replaces the estimate only for the sub-period it covers", async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86400000);
    const mid = new Date(from.getTime() + 15 * 86400000);
    const inv = await call(costRoute.POST, "POST", "/api/v1/cost-entries", {
      as: "admin",
      body: { provider: "supabase", category: "database_storage", amount_micros: 10_000_000, currency: "USD", fx_rate_to_inr: 88, fx_source: "Invoice INV-2 (test)", period_start: from.toISOString(), period_end: mid.toISOString(), invoice_ref: "INV-2" },
    });
    expect(inv.status).toBe(201);
    const d = await dash(`?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
    const line = d.costs.lines.find((l: { provider: string }) => l.provider === "supabase");
    // Synthetic plan: $25/month x 88 ≈ ₹2,168.38 over 30 days; half is invoiced (₹880), half stays estimated.
    expect(line.basis).toBe("mixed");
    expect(line.invoice_covered_fraction).toBeCloseTo(0.5, 2);
    expect(line.invoiced_paise).toBe(88000);
    expect(line.amount_paise).toBeGreaterThan(88000 + 100000);
    expect(line.amount_paise).toBeLessThan(88000 + 120000);
    expect(line.variance_paise).toBeLessThan(0);
  });

  it("front desk sees operations but not costs", async () => {
    const d = await dash("", "front_desk");
    expect(d.costs).toBeNull();
    expect(d.costs_restricted).toBe(true);
  });

  it("percentiles use nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("outcomes and cohorts", () => {
  it("appends outcomes with validation, idempotency and role visibility", async () => {
    const r = await simulate(db, "suitable_home");
    const id = r.lead_id!;
    const path = `/api/v1/leads/${id}/outcomes`;
    const params = { id };
    const at = new Date().toISOString();
    expect((await call(outcomesRoute.POST, "POST", path, { as: "designer", params, body: { outcome: "contacted", occurred_at: at, contract_value_paise: 100 } })).status).toBe(400);
    expect((await call(outcomesRoute.POST, "POST", path, { as: "designer", params, body: { outcome: "contacted", occurred_at: new Date(Date.now() + 86400000).toISOString() } })).status).toBe(400);
    expect((await call(outcomesRoute.POST, "POST", path, { as: "designer_b", params, body: { outcome: "contacted", occurred_at: at } })).status).toBe(404);
    const a = await call(outcomesRoute.POST, "POST", path, { as: "designer", params, headers: { "idempotency-key": "won-1" }, body: { outcome: "won", occurred_at: at, contract_value_paise: 1_100_000_00, reason: "Signed (synthetic)" } });
    const b = await call(outcomesRoute.POST, "POST", path, { as: "designer", params, headers: { "idempotency-key": "won-1" }, body: { outcome: "won", occurred_at: at, contract_value_paise: 1_100_000_00 } });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.outcome.id).toBe(a.body.outcome.id);
    expect((await leadRow(db, id)).outcome_status).toBe("won");
    const d = await dash();
    expect(d.metrics.confirmed_contract_value.paise).toBe(110_000_000);
    expect(d.metrics.confirmed_contract_value.note).toMatch(/not collected revenue/);
    expect(d.metrics.cohort_conversion).toMatchObject({ leads: 1, won: 1, unknown: 0, won_rate: 1, observation_complete: false });
  });

  it("late outcomes outside the observation window stay unknown for that cohort", async () => {
    const r = await simulate(db, "missing_budget");
    const id = r.lead_id!;
    await db.query(`update public.leads set intake_at = now() - interval '45 days' where id = $1`, [id]);
    await db.query(`insert into public.outcome_events (lead_id, outcome, occurred_at, source) values ($1, 'lost', now() - interval '2 days', 'manual')`, [id]);
    const from = new Date(Date.now() - 50 * 86400000).toISOString();
    const to = new Date(Date.now() - 40 * 86400000).toISOString();
    const d30 = await dash(`?from=${from}&to=${to}&observation_days=30`);
    expect(d30.metrics.cohort_conversion).toMatchObject({ leads: 1, lost: 0, unknown: 1, observation_complete: true });
    const d60 = await dash(`?from=${from}&to=${to}&observation_days=60`);
    expect(d60.metrics.cohort_conversion).toMatchObject({ leads: 1, lost: 1, unknown: 0 });
  });
});

import { z } from "zod";
import type { Db } from "@/lib/db/types";
import { badRequest } from "@/lib/http/errors";
import type { StaffActor } from "@/lib/http/route";
import { now } from "@/lib/runtime";
import { getActivePolicy } from "./policies";

// Founder dashboard. Every rate ships with its numerator and denominator and is NULL when the
// denominator is zero. Simulated data is counted separately and labelled. Nothing here is derived
// from free-text summaries.

export const dashboardQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  data: z.enum(["all", "live", "simulated"]).default("all"),
  observation_days: z.coerce.number().int().min(1).max(365).default(30),
});

export const METRIC_DEFINITIONS = {
  five_minute_response:
    "Eligible incoming enquiry calls whose first meaningful spoken response (agent utterance of at least the configured minimum length) began within 300 seconds of call arrival, divided by all eligible incoming enquiry calls in the period. Eligible = inbound calls not marked spam, test or internal. Early hang-ups, missed/failed calls and answered-but-silent calls stay in the denominator and count as not responded.",
  response_time_seconds: "Seconds from call arrival to first meaningful spoken response, over eligible calls that received one (p50/p95, nearest-rank).",
  calls_vs_leads: "Call counts are per call. Lead counts are unique leads by intake time; one lead may have several calls and one phone number may have several leads.",
  after_hours: "Calls arriving outside the staffed hours configured in the policy pinned at arrival (IST).",
  discovery: "Complete = every required discovery field is usable (or declined where declining is allowed), with read-back confirmation where required.",
  handoff_delivery_latency: "Seconds from handoff creation to provider acceptance (or simulated acceptance).",
  acknowledgement_latency: "Seconds from handoff delivery to a staff member pressing Accept. Delivery is not acknowledgement.",
  pending_acknowledgements: "Handoffs delivered but not yet accepted, as of now (not limited to the period). Overdue = past the configured deadline.",
  consultations: "Bookings with a provider-confirmed booking id. Pending reconciliation, failed and declined are shown separately. A booking is a funnel event, not revenue.",
  cohort_conversion:
    "Unique leads with intake in the cohort window; outcome = latest outcome recorded within the observation window after intake. Unknown = no outcome in the window. If the window has not elapsed for every lead, observation_complete is false.",
  confirmed_contract_value: "Sum of contract values recorded with won outcomes in the period. Not collected revenue and not attributable incremental profit.",
  operating_cost:
    "Per-call usage at rate-card prices plus fixed monthly charges prorated by day, per provider. Where an invoice covers the period it replaces the estimate (invoiced basis). Bundled meters are listed but not added twice. Development tools are excluded from operating cost.",
  cost_per_qualified_lead: "Operating cost in the period divided by leads qualified with intake in the period; null when there are none.",
} as const;

const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10000) / 10000);

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const MONTH_DAYS = 30.4375;
const EARLY_HANGUP_SECONDS = 15;

/** Every eligible call without a timely response is counted in exactly one bucket. */
function notResponded(eligible: Array<Record<string, unknown>>, missed: string[], overTarget: number) {
  const out = { missed_or_failed: 0, early_hangup: 0, answered_silent: 0, no_response_other: 0, over_target: overTarget };
  for (const c of eligible) {
    if (c.first_response_at) continue;
    const dur = c.ended_at && c.arrived_at ? (new Date(c.ended_at as string).getTime() - new Date(c.arrived_at as string).getTime()) / 1000 : null;
    if (missed.includes(c.status as string)) out.missed_or_failed++;
    else if (dur !== null && dur < EARLY_HANGUP_SECONDS) out.early_hangup++;
    else if (c.answered_at) out.answered_silent++;
    else out.no_response_other++;
  }
  return out;
}

export async function computeDashboard(db: Db, staff: StaffActor, query: z.infer<typeof dashboardQuerySchema>) {
  const to = query.to ? new Date(query.to) : now();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400000);
  if (from >= to) throw badRequest("invalid_range", "from must be before to");
  if (to.getTime() - from.getTime() > 400 * 86400000) throw badRequest("invalid_range", "range is limited to 400 days");
  const simFilter = query.data === "all" ? "true" : query.data === "live" ? "not is_simulated" : "is_simulated";
  const policy = await db.tx((tx) => getActivePolicy(tx));
  const target = 300;

  // ---- Calls ----
  const { rows: calls } = await db.query(
    `select id, status, is_simulated, arrived_at, answered_at, first_response_at, ended_at, after_hours, sla_exclusion_reason,
            extract(epoch from (first_response_at - arrived_at)) as response_s
       from public.calls where arrived_at >= $1 and arrived_at < $2 and ${simFilter}`,
    [from, to],
  );
  const eligible = calls.filter((c) => !c.sla_exclusion_reason);
  const responded = eligible.filter((c) => c.response_s !== null && Number(c.response_s) >= 0);
  const within = responded.filter((c) => Number(c.response_s) <= target);
  const responseTimes = responded.map((c) => Number(c.response_s));
  const missedStatuses = ["no_answer", "busy", "failed", "canceled"];
  const exclusions: Record<string, number> = {};
  for (const c of calls) if (c.sla_exclusion_reason) exclusions[c.sla_exclusion_reason] = (exclusions[c.sla_exclusion_reason] ?? 0) + 1;

  // ---- Leads ----
  const { rows: leads } = await db.query(
    `select id, is_simulated, qualification_status, discovery_status, intake_at from public.leads where intake_at >= $1 and intake_at < $2 and ${simFilter}`,
    [from, to],
  );
  const q = (s: string) => leads.filter((l) => l.qualification_status === s).length;

  const { rows: taskRows } = await db.query(
    `select t.kind, t.status from public.human_tasks t join public.leads l on l.id = t.lead_id
      where t.created_at >= $1 and t.created_at < $2 and ${simFilter.replace("is_simulated", "l.is_simulated")}`,
    [from, to],
  );
  const escalations: Record<string, { raised: number; open: number }> = {};
  for (const t of taskRows) {
    escalations[t.kind] ??= { raised: 0, open: 0 };
    escalations[t.kind].raised++;
    if (t.status === "open") escalations[t.kind].open++;
  }

  // ---- Handoffs ----
  const lsim = simFilter.replace("is_simulated", "l.is_simulated");
  const { rows: handoffs } = await db.query(
    `select h.purpose, h.delivery_status, h.created_at, h.sent_at, h.acknowledged_at, h.ack_required,
            extract(epoch from (h.sent_at - h.created_at)) as delivery_s, extract(epoch from (h.acknowledged_at - h.sent_at)) as ack_s
       from public.handoffs h join public.leads l on l.id = h.lead_id
      where h.created_at >= $1 and h.created_at < $2 and ${lsim}`,
    [from, to],
  );
  const { rows: pendingAck } = await db.query(
    `select count(*)::int as pending, count(*) filter (where h.ack_deadline_at < $1)::int as overdue
       from public.handoffs h join public.leads l on l.id = h.lead_id
      where h.ack_required and h.acknowledged_at is null and h.delivery_status in ('sent', 'simulated') and ${lsim}`,
    [now()],
  );

  // ---- Bookings ----
  const { rows: bookings } = await db.query(
    `select b.status, count(*)::int as n from public.bookings b join public.leads l on l.id = b.lead_id
      where b.created_at >= $1 and b.created_at < $2 and ${lsim} group by b.status`,
    [from, to],
  );
  const bk = (s: string) => bookings.find((b) => b.status === s)?.n ?? 0;

  // ---- Cohort outcomes ----
  const { rows: cohort } = await db.query(
    `select l.id, l.intake_at,
            (select o.outcome from public.outcome_events o
              where o.lead_id = l.id and o.occurred_at <= l.intake_at + make_interval(days => $3)
              order by o.occurred_at desc, o.created_at desc limit 1) as outcome
       from public.leads l where l.intake_at >= $1 and l.intake_at < $2 and ${lsim}`,
    [from, to, query.observation_days],
  );
  const oc = (s: string | null) => cohort.filter((c) => c.outcome === s).length;
  const observationEnds = new Date(to.getTime() + query.observation_days * 86400000);
  const { rows: value } = await db.query(
    `select coalesce(sum(o.contract_value_paise), 0)::bigint as paise, count(*)::int as n
       from public.outcome_events o join public.leads l on l.id = o.lead_id
      where o.outcome = 'won' and o.contract_value_paise is not null and o.occurred_at >= $1 and o.occurred_at < $2 and ${lsim}`,
    [from, to],
  );

  // ---- Costs ----
  let costs: unknown = null;
  if (staff.role === "admin") costs = await computeCosts(db, from, to, simFilter, q("qualified"), bk("confirmed"));

  // ---- Freshness ----
  const { rows: fresh } = await db.query(
    `select (select max(last_event_at) from public.calls) as latest_call_event_at,
            (select max(updated_at) from public.leads) as latest_lead_update_at,
            (select max(finished_at) from public.dispatcher_runs) as last_dispatcher_run_at,
            (select count(*)::int from public.outbox_jobs where status = 'queued') as queued_jobs,
            (select count(*)::int from public.outbox_jobs where status = 'dead') as dead_jobs`,
  );
  const simCalls = calls.filter((c) => c.is_simulated).length;

  // ---- Daily series (IST calendar days) ----
  const IST_MS = 5.5 * 3600000;
  const dayKey = (d: Date | string) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);
  const daily = new Map<string, { date: string; calls: number; eligible: number; responded_within_target: number; leads: number; qualified: number }>();
  const lastDay = dayKey(new Date(to.getTime() - 1));
  for (let d = new Date(`${dayKey(from)}T00:00:00Z`); ; d = new Date(d.getTime() + 86400000)) {
    const key = d.toISOString().slice(0, 10);
    daily.set(key, { date: key, calls: 0, eligible: 0, responded_within_target: 0, leads: 0, qualified: 0 });
    if (key >= lastDay) break;
  }
  for (const c of calls) {
    const row = daily.get(dayKey(c.arrived_at));
    if (!row) continue;
    row.calls++;
    if (!c.sla_exclusion_reason) {
      row.eligible++;
      if (c.response_s !== null && Number(c.response_s) >= 0 && Number(c.response_s) <= target) row.responded_within_target++;
    }
  }
  for (const l of leads) {
    const row = daily.get(dayKey(l.intake_at));
    if (!row) continue;
    row.leads++;
    if (l.qualification_status === "qualified") row.qualified++;
  }

  return {
    period: { from: from.toISOString(), to: to.toISOString(), timezone: "Asia/Kolkata", data: query.data },
    generated_at: now().toISOString(),
    daily: [...daily.values()],
    freshness: {
      latest_call_event_at: fresh[0].latest_call_event_at ? new Date(fresh[0].latest_call_event_at).toISOString() : null,
      latest_lead_update_at: fresh[0].latest_lead_update_at ? new Date(fresh[0].latest_lead_update_at).toISOString() : null,
      last_dispatcher_run_at: fresh[0].last_dispatcher_run_at ? new Date(fresh[0].last_dispatcher_run_at).toISOString() : null,
      queued_jobs: fresh[0].queued_jobs,
      dead_jobs: fresh[0].dead_jobs,
    },
    data_labels: {
      contains_simulated_data: simCalls > 0 || leads.some((l) => l.is_simulated),
      simulated_calls: simCalls,
      live_calls: calls.length - simCalls,
      demo_policy: policy?.is_demo ?? null,
      label: policy?.is_demo ? "Demo data and sample business rules" : null,
      note: "Simulated calls demonstrate the workflow; they are not evidence of real phone performance.",
    },
    metrics: {
      five_minute_response: {
        numerator: within.length,
        denominator: eligible.length,
        rate: ratio(within.length, eligible.length),
        target_seconds: target,
        exclusions,
        not_responded: notResponded(eligible, missedStatuses, responded.length - within.length),
      },
      response_time_seconds: { p50: percentile(responseTimes, 50), p95: percentile(responseTimes, 95), sample_size: responseTimes.length },
      calls: {
        total: calls.length,
        eligible: eligible.length,
        after_hours: calls.filter((c) => c.after_hours === true).length,
        after_hours_unknown: calls.filter((c) => c.after_hours === null).length,
        missed_or_failed: calls.filter((c) => missedStatuses.includes(c.status)).length,
      },
      leads: {
        unique: leads.length,
        discovery_complete: leads.filter((l) => l.discovery_status === "complete").length,
        discovery_incomplete: leads.filter((l) => l.discovery_status === "incomplete").length,
        discovery_in_progress: leads.filter((l) => l.discovery_status === "in_progress" || l.discovery_status === "not_started").length,
      },
      qualification: { qualified: q("qualified"), not_fit: q("not_fit"), needs_review: q("needs_review"), pending: q("pending"), total: leads.length },
      human_tasks: escalations,
      handoffs: {
        created: handoffs.length,
        delivered: handoffs.filter((h) => h.delivery_status === "sent" || h.delivery_status === "simulated").length,
        delivered_simulated: handoffs.filter((h) => h.delivery_status === "simulated").length,
        failed: handoffs.filter((h) => h.delivery_status === "failed").length,
        pending_delivery: handoffs.filter((h) => h.delivery_status === "queued" || h.delivery_status === "sending").length,
        delivery_latency_seconds: {
          p50: percentile(handoffs.filter((h) => h.delivery_s !== null).map((h) => Number(h.delivery_s)), 50),
          p95: percentile(handoffs.filter((h) => h.delivery_s !== null).map((h) => Number(h.delivery_s)), 95),
        },
        acknowledgement_latency_seconds: {
          p50: percentile(handoffs.filter((h) => h.ack_s !== null).map((h) => Number(h.ack_s)), 50),
          p95: percentile(handoffs.filter((h) => h.ack_s !== null).map((h) => Number(h.ack_s)), 95),
          sample_size: handoffs.filter((h) => h.ack_s !== null).length,
        },
        pending_acknowledgements: pendingAck[0].pending,
        overdue_acknowledgements: pendingAck[0].overdue,
      },
      consultations: { confirmed: bk("confirmed"), pending_reconciliation: bk("pending_reconciliation"), failed: bk("failed"), declined: bk("declined"), conflicts: bk("conflict") },
      cohort_conversion: {
        intake_from: from.toISOString(),
        intake_to: to.toISOString(),
        observation_window_days: query.observation_days,
        observation_complete: observationEnds <= now(),
        leads: cohort.length,
        won: oc("won"),
        lost: oc("lost"),
        contacted: oc("contacted"),
        consultation_booked: oc("consultation_booked"),
        unknown: oc(null),
        won_rate: ratio(oc("won"), cohort.length),
      },
      confirmed_contract_value: {
        paise: Number(value[0].paise),
        won_outcomes_with_value: value[0].n,
        note: "Confirmed contract value is not collected revenue or attributable profit. No ROI is inferred from the brief's observed 4x conversion relationship.",
      },
    },
    costs,
    costs_restricted: staff.role !== "admin",
    definitions: METRIC_DEFINITIONS,
  };
}

type Interval = [number, number];

function mergeIntervals(xs: Interval[]): Interval[] {
  const sorted = xs.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function overlapMs(a: number, b: number, cover: Interval[]): number {
  return cover.reduce((n, [c, d]) => n + Math.max(0, Math.min(b, d) - Math.max(a, c)), 0);
}

/**
 * Per provider/category: invoices replace the estimate ONLY for the part of the period they cover;
 * the rest stays estimated (basis "mixed" when partially covered). Bundled meters are listed at
 * zero; development tools are excluded from the operating total.
 */
async function computeCosts(db: Db, from: Date, to: Date, simFilter: string, qualified: number, bookingsConfirmed: number) {
  const f0 = from.getTime();
  const t0 = to.getTime();
  const periodMs = t0 - f0;
  const { rows: usage } = await db.query(
    `select provider, category, meter, is_simulated, is_synthetic_rate, bundled_in, operating_cost, currency, fx_rate_to_inr, fx_source,
            quantity, amount_micros, occurred_at
       from public.usage_events
      where entry_kind = 'usage' and occurred_at >= $1 and occurred_at < $2 and ${simFilter}`,
    [from, to],
  );
  const { rows: fixed } = await db.query(
    `select provider, category, meter, unit_price_micros, currency, fx_rate_to_inr, fx_source, is_synthetic, operating_cost, effective_from, effective_to
       from public.rate_cards where billing = 'fixed_monthly' and effective_from < $2::date + 1 and (effective_to is null or effective_to >= $1::date)`,
    [from, to],
  );
  const { rows: invoices } = await db.query(
    `select provider, category, currency, fx_rate_to_inr, fx_source, operating_cost, amount_micros, period_start, period_end, invoice_ref
       from public.usage_events where entry_kind = 'invoice' and period_start < $2 and period_end > $1`,
    [from, to],
  );

  type Line = {
    provider: string;
    category: string;
    cover: Interval[];
    estimated_uncovered: number; // INR micros
    estimated_covered: number; // INR micros
    invoiced: number | null; // INR micros
    bundled_quantity: number;
    unpriced_events: number;
    synthetic_rates: boolean;
    simulated_usage: boolean;
    operating_cost: boolean;
    components: Array<Record<string, unknown>>;
  };
  const lines = new Map<string, Line>();
  const line = (provider: string, category: string, operating: boolean) => {
    const k = `${provider}|${category}`;
    if (!lines.has(k)) {
      lines.set(k, { provider, category, cover: [], estimated_uncovered: 0, estimated_covered: 0, invoiced: null, bundled_quantity: 0, unpriced_events: 0, synthetic_rates: false, simulated_usage: false, operating_cost: operating, components: [] });
    }
    return lines.get(k)!;
  };
  const fx = new Map<string, { currency: string; fx_rate_to_inr: number; fx_source: string }>();
  const noteFx = (currency: string | null, rate: unknown, source: string | null) => {
    if (currency && rate !== null && rate !== undefined) fx.set(`${currency}|${rate}`, { currency, fx_rate_to_inr: Number(rate), fx_source: source ?? "" });
  };

  // 1. Invoices first, so each line knows which sub-periods are invoiced.
  for (const inv of invoices) {
    const ps = new Date(inv.period_start).getTime();
    const pe = new Date(inv.period_end).getTime();
    const a = Math.max(ps, f0);
    const b = Math.min(pe, t0);
    const fraction = Math.max(0, b - a) / (pe - ps);
    const l = line(inv.provider, inv.category, inv.operating_cost);
    l.cover.push([a, b]);
    l.invoiced = (l.invoiced ?? 0) + Number(inv.amount_micros) * Number(inv.fx_rate_to_inr) * fraction;
    noteFx(inv.currency, inv.fx_rate_to_inr, inv.fx_source);
    l.components.push({ kind: "invoice", invoice_ref: inv.invoice_ref, overlap_fraction: Math.round(fraction * 10000) / 10000, currency: inv.currency });
  }
  for (const l of lines.values()) l.cover = mergeIntervals(l.cover);

  // 2. Per-event usage, split by whether its timestamp falls in an invoiced sub-period.
  const usageAgg = new Map<string, Record<string, unknown> & { events: number; quantity: number; amount_micros: number | null }>();
  for (const u of usage) {
    const l = line(u.provider, u.category, u.operating_cost);
    noteFx(u.currency, u.fx_rate_to_inr, u.fx_source);
    l.synthetic_rates ||= u.is_synthetic_rate;
    l.simulated_usage ||= u.is_simulated;
    if (u.amount_micros === null) l.unpriced_events++;
    const key = `${l.provider}|${l.category}|${u.meter}|${u.bundled_in ?? ""}|${u.is_simulated}`;
    const agg = usageAgg.get(key) ?? { kind: u.bundled_in ? "bundled" : "usage", line: `${l.provider}|${l.category}`, meter: u.meter, events: 0, quantity: 0, currency: u.currency, amount_micros: 0, included_in: u.bundled_in, simulated: u.is_simulated };
    agg.events++;
    agg.quantity += Number(u.quantity ?? 0);
    if (u.amount_micros !== null && agg.amount_micros !== null) agg.amount_micros += Number(u.amount_micros);
    usageAgg.set(key, agg);
    if (u.bundled_in) {
      l.bundled_quantity += Number(u.quantity ?? 0);
      continue;
    }
    const inr = Number(u.amount_micros ?? 0) * Number(u.fx_rate_to_inr ?? 0);
    const t = new Date(u.occurred_at).getTime();
    if (l.cover.some(([a, b]) => t >= a && t < b)) l.estimated_covered += inr;
    else l.estimated_uncovered += inr;
  }
  for (const agg of usageAgg.values()) {
    const { line: lk, ...component } = agg;
    lines.get(lk as string)!.components.push(component);
  }

  // 3. Fixed monthly charges, prorated by time and split by invoice coverage.
  for (const f of fixed) {
    const a = Math.max(f0, new Date(f.effective_from).getTime());
    const b = Math.min(t0, f.effective_to ? new Date(f.effective_to).getTime() + 86400000 : t0);
    if (b <= a) continue;
    const l = line(f.provider, f.category, f.operating_cost);
    const perMs = (Number(f.unit_price_micros) * Number(f.fx_rate_to_inr)) / (MONTH_DAYS * 86400000);
    const covered = overlapMs(a, b, l.cover);
    l.estimated_covered += perMs * covered;
    l.estimated_uncovered += perMs * (b - a - covered);
    l.synthetic_rates ||= f.is_synthetic;
    noteFx(f.currency, f.fx_rate_to_inr, f.fx_source);
    l.components.push({ kind: "fixed_prorated", meter: f.meter, days: Math.round(((b - a) / 86400000) * 100) / 100, monthly_price_micros: Number(f.unit_price_micros), currency: f.currency, synthetic: f.is_synthetic });
  }

  const toPaise = (inrMicros: number) => Math.round(inrMicros / 10000);
  const out = [...lines.values()].map((l) => {
    const coveredMs = overlapMs(f0, t0, l.cover);
    const estimated = toPaise(l.estimated_covered + l.estimated_uncovered);
    const invoiced = l.invoiced === null ? null : toPaise(l.invoiced);
    const basis = invoiced === null ? "estimated" : coveredMs >= periodMs ? "invoiced" : "mixed";
    return {
      provider: l.provider,
      category: l.category,
      basis,
      amount_paise: invoiced === null ? estimated : invoiced + toPaise(l.estimated_uncovered),
      estimated_paise: estimated,
      invoiced_paise: invoiced,
      invoice_covered_fraction: Math.round((coveredMs / periodMs) * 10000) / 10000,
      variance_paise: invoiced === null ? null : invoiced - toPaise(l.estimated_covered),
      operating_cost: l.operating_cost,
      synthetic_rates: l.synthetic_rates,
      includes_simulated_usage: l.simulated_usage,
      unpriced_events: l.unpriced_events,
      bundled_quantity: l.bundled_quantity,
      components: l.components,
      _estimated_uncovered: toPaise(l.estimated_uncovered),
    };
  });
  const operating = out.filter((l) => l.operating_cost);
  const total = operating.reduce((n, l) => n + l.amount_paise, 0);
  const byCategory: Record<string, number> = {};
  for (const l of operating) byCategory[l.category] = (byCategory[l.category] ?? 0) + l.amount_paise;
  const estimatedPart = operating.reduce((n, l) => n + (l.invoiced_paise === null ? l.amount_paise : l._estimated_uncovered), 0);
  return {
    currency: "INR",
    unit: "paise",
    period_days: Math.round((periodMs / 86400000) * 100) / 100,
    total_operating_paise: total,
    estimated_operating_paise: estimatedPart,
    invoiced_operating_paise: total - estimatedPart,
    excluded_development_paise: out.filter((l) => !l.operating_cost).reduce((n, l) => n + l.amount_paise, 0),
    by_category: byCategory,
    lines: out.map(({ _estimated_uncovered, ...rest }) => (void _estimated_uncovered, rest)),
    cost_per_qualified_lead_paise: qualified === 0 ? null : Math.round(total / qualified),
    cost_per_confirmed_consultation_paise: bookingsConfirmed === 0 ? null : Math.round(total / bookingsConfirmed),
    qualified_leads: qualified,
    confirmed_consultations: bookingsConfirmed,
    currency_assumptions: [...fx.values()],
    contains_synthetic_rates: out.some((l) => l.synthetic_rates),
    planning_formula: "fixed costs + connected phone minutes x voice bundle rate + separately billed AI/speech + notifications + storage",
  };
}

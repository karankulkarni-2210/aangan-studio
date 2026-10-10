"use client";

import Link from "next/link";
import { qs, type Dashboard, type Integrations, type LeadList } from "@/ui/api";
import { Bars } from "@/ui/charts";
import { CardSkeleton, Chip, EmptyState, ErrorState, SimulatedTag, StatusChip, useResource } from "@/ui/components";
import { COST_CATEGORY, ESCALATION, fmtCost, fmtInt, fmtLakh, fmtPct, fmtSeconds, fmtTime, fmtWhen, humanize, PROVIDER, QUAL, serviceLabel } from "@/ui/format";
import { MobilePeriod, PeriodNote, periodRange, useWorkspace } from "@/ui/shell";
import { useSession } from "@/ui/session";

export default function ActivityPage() {
  const { api, me } = useSession();
  const { period, scope } = useWorkspace();
  const range = periodRange(period);
  const data = me?.sandbox ? "simulated" : scope;
  const allowed = me?.role === "admin" || me?.role === "front_desk";
  const dash = useResource(allowed ? () => api<Dashboard>(`/api/v1/dashboard${qs({ ...range, data })}`).then((r) => r.data) : null, [period, data, allowed]);
  const integrations = useResource(allowed ? () => api<Integrations>("/api/v1/integrations").then((r) => r.data) : null, [allowed]);
  const recent = useResource(
    () => api<LeadList>(`/api/v1/leads${qs({ from: range.from, page_size: 10, simulated: data === "all" ? "all" : data === "live" ? "false" : "true" })}`).then((r) => r.data),
    [period, data],
  );

  if (!allowed) {
    return (
      <>
        <Head />
        <div className="card"><EmptyState title="Available to the founder and front desk">Studio-wide activity and costs are not shown to designers. Your own leads are on the Overview and Enquiries pages.</EmptyState></div>
      </>
    );
  }
  const d = dash.data;
  const m = d?.metrics;

  return (
    <>
      <Head />
      <div className="row wrap between" style={{ marginBottom: 16 }}>
        {d ? <PeriodNote from={d.period.from} to={d.period.to} extra={<>{fmtInt(m!.calls.total)} calls · {d.period.data === "all" ? "live and simulated" : d.period.data} · updated {fmtTime(d.generated_at)}</>} /> : <span />}
        <div className="show-mobile"><MobilePeriod /></div>
      </div>
      {dash.error ? <ErrorState error={dash.error} onRetry={dash.reload} /> : null}

      <div className="grid three-col" style={{ marginBottom: 16 }}>
        {!d ? [0, 1, 2].map((i) => <CardSkeleton key={i} />) : (
          <>
            <section className="card stack" aria-labelledby="calls-h">
              <h2 id="calls-h" className="card-title">Calls and leads</h2>
              <dl className="kv small">
                <dt>Calls</dt><dd className="num">{fmtInt(m!.calls.total)}</dd>
                <dt>Eligible for target</dt><dd className="num">{fmtInt(m!.calls.eligible)}</dd>
                <dt>Answered within 5 min</dt><dd className="num">{fmtPct(m!.five_minute_response.rate)} <span className="muted">({fmtInt(m!.five_minute_response.numerator)}/{fmtInt(m!.five_minute_response.denominator)})</span></dd>
                <dt>Median first response</dt><dd className="num">{fmtSeconds(m!.response_time_seconds.p50)} <span className="muted">n={fmtInt(m!.response_time_seconds.sample_size)}</span></dd>
                <dt>After hours</dt><dd className="num">{fmtInt(m!.calls.after_hours)}</dd>
                <dt>Missed or failed</dt><dd className="num">{fmtInt(m!.calls.missed_or_failed)}</dd>
                <dt>Unique leads</dt><dd className="num">{fmtInt(m!.leads.unique)}</dd>
                <dt>Details complete</dt><dd className="num">{fmtInt(m!.leads.discovery_complete)}</dd>
              </dl>
            </section>
            <section className="card stack" aria-labelledby="q-h">
              <h2 id="q-h" className="card-title">Qualification outcomes</h2>
              <Bars rows={[
                { label: "Qualified", value: m!.qualification.qualified },
                { label: "Needs review", value: m!.qualification.needs_review, tone: "terra" },
                { label: "Not fit", value: m!.qualification.not_fit },
                { label: "Pending", value: m!.qualification.pending, tone: "terra" },
              ]} />
              <hr className="divider" style={{ margin: 0 }} />
              <div className="small muted">Follow-ups raised</div>
              {Object.keys(m!.human_tasks).length === 0 ? <div className="small muted">None in this period.</div> : (
                <ul className="small stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 4 }}>
                  {Object.entries(m!.human_tasks).map(([k, v]) => (
                    <li key={k} className="row between"><span>{ESCALATION[k] ?? humanize(k)}</span><span className="num">{v.raised} raised · {v.open} open</span></li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card stack" aria-labelledby="n-h">
              <h2 id="n-h" className="card-title">Handoffs and acceptance</h2>
              <dl className="kv small">
                <dt>Handoffs created</dt><dd className="num">{fmtInt(m!.handoffs.created)}</dd>
                <dt>Delivered</dt><dd className="num">{fmtInt(m!.handoffs.delivered)}{m!.handoffs.delivered_simulated ? <span className="muted"> ({m!.handoffs.delivered_simulated} simulated)</span> : null}</dd>
                <dt>Waiting to send</dt><dd className="num">{fmtInt(m!.handoffs.pending_delivery)}</dd>
                <dt>Failed</dt><dd className="num">{fmtInt(m!.handoffs.failed)}</dd>
                <dt>Awaiting acceptance</dt><dd className="num">{fmtInt(m!.handoffs.pending_acknowledgements)}</dd>
                <dt>Past deadline</dt><dd className="num">{fmtInt(m!.handoffs.overdue_acknowledgements)}</dd>
                <dt>Median time to accept</dt><dd className="num">{fmtSeconds(m!.handoffs.acknowledgement_latency_seconds.p50)} <span className="muted">n={fmtInt(m!.handoffs.acknowledgement_latency_seconds.sample_size)}</span></dd>
                <dt>Consultations</dt><dd className="num">{fmtInt(m!.consultations.confirmed)} confirmed · {fmtInt(m!.consultations.pending_reconciliation)} awaiting · {fmtInt(m!.consultations.failed)} failed</dd>
              </dl>
            </section>
          </>
        )}
      </div>

      <div className="grid two-col" style={{ marginBottom: 16 }}>
        <Costs d={d} />
        <IntegrationHealth integrations={integrations} d={d} />
      </div>

      <section className="card flush" aria-labelledby="recent-h">
        <div className="card-head" style={{ padding: "18px 22px 0" }}>
          <h2 id="recent-h" className="card-title">Recent lead activity</h2>
          <Link href="/enquiries" className="small">All enquiries <span aria-hidden="true">→</span></Link>
        </div>
        {recent.error ? <div style={{ padding: 22 }}><ErrorState error={recent.error} onRetry={recent.reload} /></div> : !recent.data ? (
          <div className="stack" style={{ padding: 22 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 36 }} />)}</div>
        ) : recent.data.data.length === 0 ? <EmptyState title="No leads in this period" /> : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead><tr><th>Lead</th><th>Project</th><th>Qualification</th><th>Calls</th><th>Last call</th></tr></thead>
              <tbody>
                {recent.data.data.map((l) => (
                  <tr key={l.id}>
                    <td><Link className="row-link" href={`/enquiries/${l.id}`}>{l.contact_name ?? "Unnamed caller"}</Link> <span className="tiny muted">{l.reference}</span> {l.is_simulated ? <SimulatedTag simulated compact /> : null}</td>
                    <td className="small">{serviceLabel(l.service_type)}</td>
                    <td><StatusChip map={QUAL} value={l.qualification_status} /></td>
                    <td className="num small">{l.call_count}</td>
                    <td className="small nowrap">{fmtWhen(l.last_call_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Head() {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">Activity &amp; Costs</h1>
        <p className="page-lede">What happened, what is waiting, and what it cost to run.</p>
      </div>
    </div>
  );
}

function Costs({ d }: { d: Dashboard | null }) {
  if (!d) return <CardSkeleton lines={6} />;
  const c = d.costs;
  if (d.costs_restricted || !c) {
    return <section className="card"><h2 className="card-title">Operating costs</h2><EmptyState title="Visible to administrators">Costs are shown to the founder&apos;s account only.</EmptyState></section>;
  }
  const won = d.metrics.confirmed_contract_value;
  return (
    <section className="card stack" aria-labelledby="cost-h">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2 id="cost-h" className="card-title">Operating costs by provider</h2>
        <span className="row wrap" style={{ gap: 6 }}>
          <Chip tone="warn">{fmtCost(c.estimated_operating_paise)} estimated</Chip>
          <Chip tone="ok">{c.invoiced_operating_paise > 0 ? fmtCost(c.invoiced_operating_paise) : "No"} invoiced</Chip>
        </span>
      </div>
      {c.contains_synthetic_rates ? <div className="note warn small">Some estimates use sample planning rates, not provider price lists or invoices.</div> : null}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Provider</th><th>Category</th><th>Basis</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            {c.lines.length === 0 ? (
              <tr><td colSpan={4} className="muted small">No usage recorded in this period.</td></tr>
            ) : c.lines.map((l) => (
              <tr key={`${l.provider}-${l.category}`}>
                <td>{PROVIDER[l.provider] ?? humanize(l.provider)}{!l.operating_cost ? <div className="tiny muted">Development, excluded from operating cost</div> : null}</td>
                <td className="small">{COST_CATEGORY[l.category] ?? humanize(l.category)}</td>
                <td><Chip tone={l.basis === "invoiced" ? "ok" : l.basis === "mixed" ? "info" : "warn"}>{humanize(l.basis)}</Chip>{l.includes_simulated_usage ? <div className="tiny muted">includes simulated usage</div> : null}{l.unpriced_events ? <div className="tiny muted">{l.unpriced_events} events without a rate</div> : null}</td>
                <td className="num" style={{ textAlign: "right" }}>{fmtCost(l.amount_paise)}{l.variance_paise !== null ? <div className="tiny muted">variance {fmtCost(l.variance_paise)}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv small">
        <dt>Total operating cost</dt><dd className="num"><strong>{fmtCost(c.total_operating_paise)}</strong> over {Math.round(c.period_days)} days</dd>
        <dt>Per qualified lead</dt><dd className="num">{fmtCost(c.cost_per_qualified_lead_paise)} <span className="muted">({fmtInt(c.qualified_leads)} qualified)</span></dd>
        <dt>Per confirmed consultation</dt><dd className="num">{fmtCost(c.cost_per_confirmed_consultation_paise)} <span className="muted">({fmtInt(c.confirmed_consultations)} confirmed)</span></dd>
        <dt>Development tools</dt><dd className="num">{fmtCost(c.excluded_development_paise)} <span className="muted">(excluded)</span></dd>
      </dl>
      <hr className="divider" style={{ margin: 0 }} />
      <div className="row between small"><span>Confirmed won project value</span><span className="num">{won.won_outcomes_with_value > 0 ? fmtLakh(won.paise) : "Not available"}</span></div>
      <p className="tiny muted" style={{ margin: 0 }}>{won.note} This sample does not show return on investment.</p>
      {c.currency_assumptions.length ? <p className="tiny muted" style={{ margin: 0 }}>Currency: {c.currency_assumptions.map((a) => `${a.currency} at ₹${a.fx_rate_to_inr} (${a.fx_source})`).join("; ")}.</p> : null}
    </section>
  );
}

function IntegrationHealth({ integrations, d }: { integrations: { data: Integrations | null; error: unknown; reload: () => void }; d: Dashboard | null }) {
  const i = integrations.data;
  return (
    <section className="card stack" aria-labelledby="int-h">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2 id="int-h" className="card-title">Integration failures and retries</h2>
        {d ? <span className="tiny muted">Last dispatcher run {d.freshness.last_dispatcher_run_at ? fmtWhen(d.freshness.last_dispatcher_run_at) : "not recorded"}</span> : null}
      </div>
      {integrations.error ? <ErrorState error={integrations.error} onRetry={integrations.reload} /> : !i ? <div className="skeleton" style={{ height: 160 }} /> : (
        <>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
            {i.integrations.map((p) => (
              <li key={p.provider} className="row between small" style={{ alignItems: "flex-start" }}>
                <span>
                  <strong style={{ fontWeight: 500 }}>{PROVIDER[p.provider]}</strong>
                  <span className="tiny muted" style={{ display: "block" }}>
                    {p.health ? `${p.health.failed} failed · ${p.health.pending} pending${p.health.last_error_at ? ` · last error ${fmtWhen(p.health.last_error_at)}` : ""}` : "No activity recorded"}
                  </span>
                </span>
                <Chip tone={p.health && p.health.failed > 0 ? "bad" : p.mode === "live" ? "ok" : p.mode === "mock" ? "info" : "neutral"}>{p.health && p.health.failed > 0 ? "Needs attention" : p.mode === "not_configured" ? "Not configured" : humanize(p.mode)}</Chip>
              </li>
            ))}
          </ul>
          <hr className="divider" style={{ margin: 0 }} />
          <div className="small" style={{ fontWeight: 500 }}>Background jobs</div>
          {i.jobs.length === 0 ? <div className="small muted">No jobs recorded.</div> : (
            <ul className="small stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 4 }}>
              {i.jobs.filter((j) => j.status !== "succeeded").map((j) => (
                <li key={`${j.kind}-${j.status}`} className="row between">
                  <span>{humanize(j.kind)}{j.last_error ? <span className="tiny" style={{ display: "block", color: "var(--bad)" }}>{j.last_error}</span> : null}</span>
                  <Chip tone={j.status === "dead" ? "bad" : j.status === "queued" || j.status === "running" ? "info" : "neutral"}>{j.count} {j.status === "dead" ? "stopped" : j.status}</Chip>
                </li>
              ))}
              {i.jobs.every((j) => j.status === "succeeded") ? <li className="muted">All {i.jobs.reduce((n, j) => n + j.count, 0)} jobs succeeded.</li> : null}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

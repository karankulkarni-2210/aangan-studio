"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { qs, type Dashboard, type LeadList } from "@/ui/api";
import { ActivityChart, Funnel } from "@/ui/charts";
import { CardSkeleton, Chip, EmptyState, ErrorState, Icon, Segmented, SimulatedTag, StatusChip, useResource } from "@/ui/components";
import { SampleEnquiryButton } from "@/ui/demo";
import { COST_CATEGORY, fmtCost, fmtInt, fmtLakh, fmtPct, fmtTime, fmtWhen, humanize, initials, LEAD_BOOKING, nextAction, placeLabel, QUAL, serviceLabel } from "@/ui/format";
import { MobilePeriod, PeriodNote, periodRange, PERIODS, useWorkspace, type DataScope } from "@/ui/shell";
import { useSession } from "@/ui/session";

export default function OverviewPage() {
  const { me } = useSession();
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Your studio, at a glance.</h1>
          <p className="page-lede">Respond quickly. Hand over clearly. Keep every opportunity visible.</p>
        </div>
        <SampleEnquiryButton />
      </div>
      {me?.role === "designer" ? <DesignerOverview /> : <StudioOverview />}
      <div className="banner" style={{ marginTop: 20 }}>
        <span className="attention-icon accent" aria-hidden="true"><Icon name="users" size={18} /></span>
        <span className="serif">Human review stays in the loop</span>
        <span className="small muted">Pricing, commitments and complaints are handled by the studio. The assistant never quotes prices.</span>
      </div>
    </>
  );
}

function StudioOverview() {
  const { api, me } = useSession();
  const { period, scope, setScope } = useWorkspace();
  const range = periodRange(period);
  const data: DataScope = me?.sandbox ? "simulated" : scope;
  const dash = useResource(() => api<Dashboard>(`/api/v1/dashboard${qs({ ...range, data })}`).then((r) => r.data), [period, data]);
  const recent = useResource(
    () => api<LeadList>(`/api/v1/leads${qs({ page_size: 5, simulated: data === "all" ? "all" : data === "live" ? "false" : "true" })}`).then((r) => r.data),
    [data, dash.data?.generated_at],
  );
  const d = dash.data;
  const m = d?.metrics;

  return (
    <div className="stack lg">
      <div className="row wrap between">
        {d ? (
          <PeriodNote from={d.period.from} to={d.period.to} extra={<>{fmtInt(m!.calls.total)} calls in sample · updated {fmtTime(d.generated_at)}</>} />
        ) : (
          <span className="small muted">{PERIODS.find((p) => p.value === period)?.label}</span>
        )}
        <div className="row wrap">
          {me?.sandbox ? (
            <Chip tone="terra">Simulated records only</Chip>
          ) : (
            <Segmented<DataScope>
              label="Data shown"
              value={scope}
              onChange={setScope}
              options={[{ value: "all", label: "All" }, { value: "live", label: "Live calls" }, { value: "simulated", label: "Simulated" }]}
            />
          )}
          <div className="show-mobile"><MobilePeriod /></div>
        </div>
      </div>

      {dash.error ? <ErrorState error={dash.error} onRetry={dash.reload} /> : null}

      <div className="grid metrics">
        {!d ? (
          [0, 1, 2, 3].map((i) => <CardSkeleton key={i} lines={2} />)
        ) : (
          <>
            <Metric href="/enquiries" icon="phone" label="Incoming enquiries" value={fmtInt(m!.calls.total)} sub={`${fmtInt(m!.leads.unique)} unique leads`} simulated={d.data_labels.contains_simulated_data} />
            <Metric
              href="/activity"
              icon="clock"
              label="Responded within 5 min"
              value={fmtPct(m!.five_minute_response.rate)}
              sub={m!.five_minute_response.denominator ? `${fmtInt(m!.five_minute_response.numerator)} of ${fmtInt(m!.five_minute_response.denominator)} eligible calls` : "No eligible calls in this period"}
              simulated={d.data_labels.contains_simulated_data}
            />
            <Metric href="/enquiries?qualification=qualified" icon="users" label="Qualified leads" value={fmtInt(m!.qualification.qualified)} sub={`Ready for designer review · ${fmtInt(m!.qualification.total)} assessed`} simulated={d.data_labels.contains_simulated_data} />
            <Metric href="/consultations" icon="calendar" label="Consultations booked" value={fmtInt(m!.consultations.confirmed)} sub="Confirmed with a booking ID" simulated={d.data_labels.contains_simulated_data} />
          </>
        )}
      </div>

      <div className="grid two-col">
        <div className="stack lg">
          <section className="card" aria-labelledby="activity-h">
            <div className="card-head">
              <h2 id="activity-h" className="card-title">Enquiry activity</h2>
              <div className="legend">
                <span><i style={{ background: "var(--accent)" }} /> Enquiries</span>
                <span><i style={{ background: "var(--terra)", borderRadius: 1 }} /> Answered within 5 min</span>
              </div>
            </div>
            {!d ? <div className="skeleton" style={{ height: 220 }} /> : d.daily.some((x) => x.calls > 0) ? <ActivityChart days={d.daily} /> : <EmptyState title="No calls in this period">Run a sample enquiry or widen the period.</EmptyState>}
          </section>
          <section className="card" aria-labelledby="funnel-h">
            <div className="card-head">
              <h2 id="funnel-h" className="card-title">Conversion funnel</h2>
              {d ? <span className="tiny muted">Won counts use a {d.metrics.cohort_conversion.observation_window_days}-day observation window{d.metrics.cohort_conversion.observation_complete ? "" : " (still open)"}</span> : null}
            </div>
            {!d ? (
              <div className="stack">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 18 }} />)}</div>
            ) : (
              <Funnel
                steps={[
                  { label: "Enquiries", value: m!.calls.total },
                  { label: "Unique leads", value: m!.leads.unique },
                  { label: "Details complete", value: m!.leads.discovery_complete },
                  { label: "Qualified", value: m!.qualification.qualified },
                  { label: "Consultation confirmed", value: m!.consultations.confirmed },
                  { label: "Won", value: m!.cohort_conversion.won, note: "Recorded by the studio" },
                ]}
              />
            )}
          </section>
        </div>

        <section className="card" aria-labelledby="attention-h">
          <div className="card-head">
            <h2 id="attention-h" className="card-title">Needs your attention</h2>
          </div>
          {!d ? <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 52 }} />)}</div> : <Attention d={d} />}
        </section>
      </div>

      <div className="grid two-col">
        <section className="card flush" aria-labelledby="recent-h">
          <div className="card-head" style={{ padding: "18px 22px 0" }}>
            <h2 id="recent-h" className="card-title">Recent enquiries</h2>
            <Link href="/enquiries" className="small">View all <span aria-hidden="true">→</span></Link>
          </div>
          {recent.error ? <div style={{ padding: 22 }}><ErrorState error={recent.error} onRetry={recent.reload} /></div> : <RecentTable list={recent.data} />}
        </section>
        <CostSummary d={d} />
      </div>

      {d ? <p className="tiny muted" style={{ margin: 0 }}>{d.data_labels.note} {d.data_labels.label ? `${d.data_labels.label}.` : ""}</p> : null}
    </div>
  );
}

function Metric({ icon, label, value, sub, simulated, href }: { icon: string; label: string; value: string; sub: string; simulated: boolean; href?: string }) {
  const body = (
    <>
      <span className="metric-icon" aria-hidden="true"><Icon name={icon} /></span>
      <div className="grow">
        <div className="row wrap between" style={{ gap: 6 }}>
          <span className="metric-label">{label}</span>
          {simulated ? <Chip tone="terra">Includes simulated</Chip> : null}
        </div>
        <div className="metric-value num">{value}</div>
        <div className="metric-sub">{sub}</div>
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="card metric metric-link" aria-label={`${label}: ${value}. Open details`}>{body}</Link>
  ) : (
    <div className="card metric">{body}</div>
  );
}

function Attention({ d }: { d: Dashboard }) {
  const m = d.metrics;
  const incomplete = m.leads.discovery_incomplete + m.qualification.needs_review;
  const pricing = m.human_tasks.pricing_request?.open ?? 0;
  const otherTasks = Object.entries(m.human_tasks).filter(([k]) => k !== "pricing_request").reduce((n, [, v]) => n + v.open, 0);
  const failures = m.handoffs.failed + m.consultations.failed + d.freshness.dead_jobs;
  const items = [
    {
      show: incomplete > 0,
      icon: "alert",
      tone: "warn",
      title: `${incomplete} ${incomplete === 1 ? "lead needs" : "leads need"} more details or review`,
      body: `${m.leads.discovery_incomplete} incomplete, ${m.qualification.needs_review} flagged for review.`,
      href: "/enquiries?qualification=needs_review",
      cta: "Review leads",
    },
    {
      show: m.handoffs.pending_acknowledgements > 0,
      icon: "users",
      tone: "accent",
      title: `${m.handoffs.pending_acknowledgements} ${m.handoffs.pending_acknowledgements === 1 ? "handoff" : "handoffs"} awaiting acceptance`,
      body: m.handoffs.overdue_acknowledgements ? `${m.handoffs.overdue_acknowledgements} past the acceptance deadline.` : "Sent to designers, pending their response.",
      href: "/enquiries?attention=ack_overdue",
      cta: "View handoffs",
    },
    {
      show: pricing > 0,
      icon: "rupee",
      tone: "accent",
      title: `${pricing} pricing ${pricing === 1 ? "question" : "questions"} for Nikhil`,
      body: "Callers asked about price. The assistant did not quote; the studio calls back.",
      href: "/enquiries?attention=open_escalations",
      cta: "See callers",
    },
    {
      show: otherTasks > 0,
      icon: "phone",
      tone: "accent",
      title: `${otherTasks} other follow-up ${otherTasks === 1 ? "task" : "tasks"}`,
      body: "Complaints, commitments, callbacks and bookings to confirm.",
      href: "/enquiries?attention=open_escalations",
      cta: "Open tasks",
    },
    {
      show: failures > 0 || m.consultations.pending_reconciliation > 0,
      icon: "mail",
      tone: "bad",
      title: `${failures + m.consultations.pending_reconciliation} delivery or integration ${failures + m.consultations.pending_reconciliation === 1 ? "issue" : "issues"}`,
      body: `${m.handoffs.failed} emails failed, ${m.consultations.failed} bookings failed, ${m.consultations.pending_reconciliation} awaiting confirmation, ${d.freshness.dead_jobs} jobs stopped retrying.`,
      href: "/activity",
      cta: "View activity",
    },
  ].filter((i) => i.show);
  if (items.length === 0) return <EmptyState title="All clear">Nothing is waiting on the team in this period.</EmptyState>;
  return (
    <div className="attention">
      {items.map((i) => (
        <div key={i.title} className="attention-item">
          <span className={`attention-icon ${i.tone}`} aria-hidden="true"><Icon name={i.icon} size={18} /></span>
          <div className="grow">
            <div style={{ fontWeight: 500 }}>{i.title}</div>
            <div className="small muted">{i.body}</div>
          </div>
          <Link href={i.href} className="small nowrap">{i.cta} <span aria-hidden="true">→</span></Link>
        </div>
      ))}
    </div>
  );
}

function RecentTable({ list }: { list: LeadList | null }) {
  const router = useRouter();
  if (!list) return <div style={{ padding: 22 }} className="stack">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)}</div>;
  if (list.data.length === 0) return <EmptyState title="No enquiries yet">New phone enquiries appear here as soon as a call starts.</EmptyState>;
  return (
    <div className="table-wrap" style={{ marginTop: 12 }}>
      <table className="table">
        <thead>
          <tr><th>Client</th><th>Project</th><th>Status</th><th className="hide-mobile">Designer</th><th>Received</th></tr>
        </thead>
        <tbody>
          {list.data.map((l) => (
            <tr key={l.id} className="clickable" onClick={() => router.push(`/enquiries/${l.id}`)}>
              <td>
                <div className="person">
                  <span className="avatar" aria-hidden="true">{initials(l.contact_name)}</span>
                  <div>
                    <Link className="row-link" href={`/enquiries/${l.id}`} onClick={(e) => e.stopPropagation()}>{l.contact_name ?? "Unnamed caller"}</Link>
                    {l.is_simulated ? <div><SimulatedTag simulated compact /></div> : null}
                  </div>
                </div>
              </td>
              <td className="small">{serviceLabel(l.service_type)}<div className="muted">{placeLabel(l.location_city, l.location_locality)}</div></td>
              <td>{l.booking_status === "confirmed" ? <StatusChip map={LEAD_BOOKING} value="confirmed" /> : <StatusChip map={QUAL} value={l.qualification_status} />}</td>
              <td className="small hide-mobile">{l.owner?.display_name ?? <span className="muted">Unassigned</span>}</td>
              <td className="small nowrap">{fmtWhen(l.intake_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CATEGORY_TONE = ["var(--accent)", "var(--terra)", "#8c9a8f", "#d9c3a5", "#5f7f9a", "#c0b9aa"];

function CostSummary({ d }: { d: Dashboard | null }) {
  if (!d) return <CardSkeleton lines={4} />;
  const c = d.costs;
  const won = d.metrics.confirmed_contract_value;
  return (
    <section className="card" aria-labelledby="cost-h">
      <div className="card-head">
        <h2 id="cost-h" className="card-title">Operating cost</h2>
        {c ? <Chip tone="warn">{c.invoiced_operating_paise > 0 ? (c.estimated_operating_paise > 0 ? "Estimated + invoiced" : "Invoiced") : "Estimated"}{c.contains_synthetic_rates ? " · sample rates" : ""}</Chip> : null}
      </div>
      {d.costs_restricted || !c ? (
        <EmptyState title="Visible to administrators">Operating costs are shown to the founder&apos;s account only.</EmptyState>
      ) : (
        <div className="stack">
          <div className="metric-value num" style={{ margin: 0 }}>{fmtCost(c.total_operating_paise)}</div>
          <div className="stackbar" aria-hidden="true">
            {Object.entries(c.by_category).filter(([, v]) => v > 0).map(([k, v], i) => (
              <div key={k} style={{ width: `${(v / Math.max(1, c.total_operating_paise)) * 100}%`, background: CATEGORY_TONE[i % CATEGORY_TONE.length] }} />
            ))}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
            {Object.entries(c.by_category).filter(([, v]) => v > 0).map(([k, v], i) => (
              <li key={k} className="row between small">
                <span className="row"><i style={{ width: 9, height: 9, borderRadius: "50%", background: CATEGORY_TONE[i % CATEGORY_TONE.length], display: "inline-block" }} aria-hidden="true" />{COST_CATEGORY[k] ?? humanize(k)}</span>
                <span className="num">{fmtCost(v)}</span>
              </li>
            ))}
          </ul>
          <hr className="divider" style={{ margin: "4px 0" }} />
          <div className="row between small"><span>Per qualified lead</span><span className="num">{fmtCost(c.cost_per_qualified_lead_paise)}</span></div>
          <div className="row between small"><span>Per confirmed consultation</span><span className="num">{fmtCost(c.cost_per_confirmed_consultation_paise)}</span></div>
          <hr className="divider" style={{ margin: "4px 0" }} />
          <div className="row between small">
            <span>Confirmed won project value</span>
            <span className="num">{won.won_outcomes_with_value > 0 ? fmtLakh(won.paise) : "Not available"}</span>
          </div>
          <p className="tiny muted" style={{ margin: 0 }}>Won value is contract value the studio recorded, not revenue collected. Bookings and open deals are not counted as earned.</p>
        </div>
      )}
    </section>
  );
}

function DesignerOverview() {
  const { api } = useSession();
  const mine = useResource(() => api<LeadList>(`/api/v1/leads${qs({ owner: "me", page_size: 50 })}`).then((r) => r.data), []);
  if (mine.error) return <ErrorState error={mine.error} onRetry={mine.reload} />;
  if (!mine.data) return <div className="grid metrics">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={2} />)}</div>;
  const leads = mine.data.data;
  const waiting = leads.filter((l) => l.handoff_status === "sent");
  const booked = leads.filter((l) => l.booking_status === "confirmed");
  return (
    <div className="stack lg">
      <div className="grid metrics">
        <Metric href="/enquiries" icon="users" label="Leads assigned to you" value={fmtInt(mine.data.pagination.total)} sub="Designers see only their own leads" simulated={leads.some((l) => l.is_simulated)} />
        <Metric href="/enquiries" icon="mail" label="Awaiting your acceptance" value={fmtInt(waiting.length)} sub={waiting.some((l) => l.ack_overdue) ? "Some are past the deadline" : "Accept to take over the client"} simulated={false} />
        <Metric href="/consultations" icon="calendar" label="Consultations booked" value={fmtInt(booked.length)} sub="Confirmed with a booking ID" simulated={false} />
        <Metric icon="sparkle" label="Won" value={fmtInt(leads.filter((l) => l.outcome_status === "won").length)} sub="Recorded outcomes" simulated={false} />
      </div>
      <section className="card flush">
        <div className="card-head" style={{ padding: "18px 22px 0" }}>
          <h2 className="card-title">Your leads</h2>
          <Link href="/enquiries" className="small">Open inbox <span aria-hidden="true">→</span></Link>
        </div>
        {leads.length === 0 ? (
          <EmptyState title="Nothing assigned yet">Qualified leads matching your services are handed to you after the call.</EmptyState>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead><tr><th>Client</th><th>Project</th><th>Next action</th><th>Received</th></tr></thead>
              <tbody>
                {leads.slice(0, 10).map((l) => {
                  const a = nextAction(l);
                  return (
                    <tr key={l.id}>
                      <td><Link className="row-link" href={`/enquiries/${l.id}`}>{l.contact_name ?? "Unnamed caller"}</Link> {l.is_simulated ? <SimulatedTag simulated compact /> : null}</td>
                      <td className="small">{serviceLabel(l.service_type)} · {placeLabel(l.location_city, l.location_locality)}</td>
                      <td><Chip tone={a.tone}>{a.label}</Chip></td>
                      <td className="small nowrap">{fmtWhen(l.intake_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

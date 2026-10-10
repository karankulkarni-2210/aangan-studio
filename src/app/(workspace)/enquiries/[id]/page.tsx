"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { describeError, type AcknowledgementResponse, type LeadDetail, type OutcomeResponse, type PatchLeadResponse, type StaffList } from "@/ui/api";
import { BookingDialog } from "@/ui/booking";
import { CardSkeleton, Chip, Dialog, EmptyState, ErrorState, Icon, SimulatedTag, StatusChip, useResource, useToast } from "@/ui/components";
import {
  BOOKING,
  CRM,
  DELIVERY,
  ESCALATION,
  FACT_LABEL,
  FACT_STATUS,
  fmtDate,
  fmtInt,
  fmtLakh,
  fmtSeconds,
  fmtSlot,
  fmtWhen,
  HANDOFF,
  humanize,
  LEAD_BOOKING,
  nextAction,
  placeLabel,
  QUAL,
  serviceLabel,
  STAGE,
} from "@/ui/format";
import { useSession } from "@/ui/session";

type Detail = LeadDetail;
const FACT_ORDER = ["service", "location", "area", "budget", "timeline", "contact_name", "contact_email", "callback_preference"] as const;
const BASIS: Record<string, string> = { carpet: "carpet area", built_up: "built-up area", super_built_up: "super built-up area", unspecified: "basis not stated" };

export default function LeadPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { api } = useSession();
  const lead = useResource(() => api<Detail>(`/api/v1/leads/${id}`).then((r) => r.data), [id]);

  if (lead.error) {
    return (
      <>
        <BackLink />
        <ErrorState error={lead.error} onRetry={lead.reload} />
      </>
    );
  }
  if (!lead.data) {
    return (
      <>
        <BackLink />
        <div className="grid two-col"><CardSkeleton lines={6} /><CardSkeleton lines={4} /></div>
      </>
    );
  }
  return <LeadView d={lead.data} reload={lead.reload} />;
}

function BackLink() {
  return (
    <Link href="/enquiries" className="row small" style={{ marginBottom: 14, gap: 6, display: "inline-flex" }}>
      <Icon name="back" size={16} /> All enquiries
    </Link>
  );
}

function LeadView({ d, reload }: { d: Detail; reload: () => void }) {
  const l = d.lead;
  const a = nextAction({ ...l, open_escalations: d.escalation_flags.open });
  return (
    <>
      <BackLink />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="row wrap" style={{ gap: 8, marginBottom: 6 }}>
            <span className="small muted">{l.reference}</span>
            <SimulatedTag simulated={l.is_simulated} />
            {d.data_labels.demo_policy ? <Chip tone="warn">Sample business rules{d.data_labels.policy_version ? ` v${d.data_labels.policy_version}` : ""}</Chip> : null}
          </div>
          <h1 className="page-title">{l.contact_name ?? "Unnamed caller"}</h1>
          <p className="page-lede">{serviceLabel(l.service_type)} · {placeLabel(l.location_city, l.location_locality)} · received {fmtWhen(l.intake_at)} IST</p>
        </div>
        <div className="row wrap">
          <StatusChip map={QUAL} value={l.qualification_status} />
          <Chip tone="outline">{STAGE[l.stage] ?? humanize(l.stage)}</Chip>
        </div>
      </div>
      {l.is_simulated ? <div className="note warn" style={{ marginBottom: 16 }}>Created by a simulated call. This is not a real customer, and its bookings, CRM records and emails were simulated.</div> : null}
      {l.injection_suspected ? <div className="note bad" style={{ marginBottom: 16 }}>The caller said something that looked like instructions to the system. It was treated as ordinary speech; review the transcript before relying on this enquiry.</div> : null}

      <div className="grid two-col">
        <div className="stack lg">
          <Facts d={d} />
          <Conversation d={d} />
          <Qualification d={d} />
        </div>
        <div className="stack lg">
          <Actions d={d} reload={reload} nextLabel={a.label} />
          <Consultations d={d} />
          <Sync d={d} />
          <FollowUps d={d} />
          <Timeline d={d} />
        </div>
      </div>
    </>
  );
}

function factValue(d: Detail, field: string): React.ReactNode {
  const l = d.lead;
  const f = d.facts[field as keyof Detail["facts"]];
  if (field === "budget" && l.budget_paise !== null) {
    return (
      <>
        {fmtLakh(l.budget_paise)} <span className="tiny muted">caller&apos;s stated budget, not a studio price</span>
      </>
    );
  }
  if (field === "area" && l.area_sqft !== null) return `${fmtInt(Math.round(l.area_sqft))} sq ft${l.area_basis ? ` (${BASIS[l.area_basis]})` : ""}`;
  if (field === "service" && l.service_type) return serviceLabel(l.service_type);
  return f?.display ?? <span className="muted">Not captured</span>;
}

function Facts({ d }: { d: Detail }) {
  const quoteFor = (field: string) =>
    // Prefer the caller's own statement over their "yes" to the read-back.
    d.evidence
      .filter((e) => e.field === field && e.quote && e.status !== "superseded" && e.status !== "rejected")
      .sort((x, y) => Number(x.source === "caller_confirmation") - Number(y.source === "caller_confirmation") || (y.created_at ?? "").localeCompare(x.created_at ?? ""))[0]?.quote;
  const problems = FACT_ORDER.filter((f) => ["missing", "unconfirmed", "contradictory"].includes(d.facts[f]?.status ?? "missing") && (d.missing_fields.includes(f) || d.facts[f]?.status !== "missing"));
  return (
    <section className="card" aria-labelledby="facts-h">
      <div className="card-head">
        <h2 id="facts-h" className="card-title">Project facts</h2>
        <span className="tiny muted">From the caller&apos;s own words</span>
      </div>
      <dl className="kv">
        {FACT_ORDER.map((f) => {
          const q = quoteFor(f);
          return (
            <div key={f} style={{ display: "contents" }}>
              <dt>{FACT_LABEL[f]}</dt>
              <dd>
                <div className="row wrap" style={{ gap: 8 }}>
                  <span>{factValue(d, f)}</span>
                  <StatusChip map={FACT_STATUS} value={d.facts[f]?.status ?? "missing"} />
                </div>
                {q ? <div className="tiny muted" style={{ marginTop: 2 }}>&ldquo;{q}&rdquo;</div> : null}
              </dd>
            </div>
          );
        })}
        <dt>Phone</dt>
        <dd>{d.lead.caller_phone ?? <span className="muted">Not captured</span>}</dd>
      </dl>
      <hr className="divider" />
      <h3 className="small" style={{ fontWeight: 500, marginBottom: 8 }}>Missing or conflicting information</h3>
      {problems.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>Nothing missing. Every required detail was captured.</p>
      ) : (
        <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
          {problems.map((f) => (
            <li key={f}>
              <strong style={{ fontWeight: 500 }}>{FACT_LABEL[f]}</strong>: {d.facts[f]?.status === "contradictory" ? "the caller gave different answers; confirm on the callback" : d.facts[f]?.status === "unconfirmed" ? "heard but not confirmed by the caller" : "not captured"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Conversation({ d }: { d: Detail }) {
  if (d.calls.length === 0) {
    return (
      <section className="card">
        <h2 className="card-title">Conversation</h2>
        <EmptyState title="No call recorded">This lead has no call attached.</EmptyState>
      </section>
    );
  }
  const flags = Object.entries(d.escalation_flags).filter(([k, v]) => v === true && k !== "injection_suspected").map(([k]) => k);
  return (
    <section className="card" aria-labelledby="conv-h">
      <div className="card-head">
        <h2 id="conv-h" className="card-title">Conversation</h2>
        <span className="tiny muted">{d.calls.length} {d.calls.length === 1 ? "call" : "calls"}</span>
      </div>
      <div className="stack">
        {d.calls.map((c) => (
          <div key={c.id} className="stack" style={{ gap: 8 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <SimulatedTag simulated={c.is_simulated} />
              <span className="small">{fmtWhen(c.arrived_at)} IST</span>
              <span className="small muted">· {c.duration_seconds !== null ? fmtSeconds(c.duration_seconds) : "duration not available"}</span>
              <span className="small muted">· first response {c.response_seconds !== null ? fmtSeconds(c.response_seconds) : "not available"}</span>
              {c.after_hours ? <Chip tone="info">After hours</Chip> : null}
            </div>
            <p className="small" style={{ margin: 0 }}>
              {summary(d, c)}
            </p>
            {c.transcript_purged ? (
              <p className="tiny muted" style={{ margin: 0 }}>The transcript was removed under the retention policy.</p>
            ) : c.transcript.length ? (
              <details className="disclosure">
                <summary>Show transcript ({c.transcript.length} lines)</summary>
                <div className="transcript" style={{ marginTop: 10 }}>
                  {c.transcript.map((t) => (
                    <div key={t.id} className={`bubble ${t.speaker === "agent" ? "agent" : "caller"}`}>
                      <span className="who">{t.speaker === "agent" ? "Assistant" : t.speaker === "caller" ? "Caller" : "System"}</span>
                      {t.text}
                      {t.price_guard_flag ? <div className="tiny" style={{ color: "var(--bad)" }}>Price wording blocked by the guard</div> : null}
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <p className="tiny muted" style={{ margin: 0 }}>{c.recording_consent === "declined" ? "The caller declined a transcript." : "No transcript available."}</p>
            )}
          </div>
        ))}
        {flags.length ? (
          <div className="row wrap" style={{ gap: 6 }}>
            {flags.map((f) => <Chip key={f} tone="terra">{humanize(f.replace(/_requested$/, " requested"))}</Chip>)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function summary(d: Detail, c: Detail["calls"][number]): string {
  const l = d.lead;
  const parts: string[] = [];
  parts.push(l.service_type ? `Caller asked about ${serviceLabel(l.service_type).toLowerCase()}` : "Caller's project type was not captured");
  if (l.location_city || l.location_locality) parts.push(`in ${placeLabel(l.location_city, l.location_locality)}`);
  let s = parts.join(" ") + ".";
  if (d.escalation_flags.pricing_requested) s += " They asked about pricing; the assistant did not quote and passed it to the studio.";
  if (d.missing_fields.length) s += ` Not captured: ${d.missing_fields.map((f) => (FACT_LABEL[f] ?? f).toLowerCase()).join(", ")}.`;
  if (c.end_reason) s += ` Call ended: ${humanize(c.end_reason).toLowerCase()}.`;
  return s;
}

function Qualification({ d }: { d: Detail }) {
  const cur = d.qualification.current;
  return (
    <section className="card" aria-labelledby="q-h">
      <div className="card-head">
        <h2 id="q-h" className="card-title">Qualification</h2>
        {cur ? <StatusChip map={QUAL} value={cur.decision} /> : null}
      </div>
      {!cur ? (
        <EmptyState title="Not assessed yet">The rules run once the caller has given enough details.</EmptyState>
      ) : (
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            Decided by the studio&apos;s written rules{cur.policy_version ? ` (policy v${cur.policy_version})` : ""}, not by the AI. {cur.kind === "human_override" ? "A team member overrode the automatic result." : ""}
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
            {cur.reasons.map((r) => (
              <li key={r.rule_id} className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                <Chip tone={r.result === "pass" ? "ok" : r.effect === "not_fit" ? "bad" : r.effect === "needs_review" ? "warn" : "neutral"}>{r.result === "pass" ? "Pass" : humanize(r.result)}</Chip>
                <div className="small">
                  <div>{ruleText(r)}</div>
                  {r.effect !== "none" ? <div className="tiny muted">{r.effect === "not_fit" ? "Makes the lead not a fit" : "Sends the lead to review"}</div> : null}
                </div>
              </li>
            ))}
          </ul>
          {d.qualification.history.length > 1 ? (
            <details className="disclosure">
              <summary>Assessment history ({d.qualification.history.length})</summary>
              <ul className="small stack" style={{ marginTop: 8, paddingLeft: 18, gap: 4 }}>
                {d.qualification.history.map((h) => (
                  <li key={h.id}>{fmtWhen(h.created_at)}: {QUAL[h.decision]?.label ?? h.decision} ({humanize(h.kind)}){h.override_reason ? `: ${h.override_reason}` : ""}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** "service passes (Demo: …)" → "Demo: …"; technical paise figures are dropped. */
function ruleText(r: { rule_id: string; message?: string }): string {
  const m = r.message ?? "";
  const inner = /^[\w ]+? (?:passes|fails|is missing|missing|declined|unconfirmed|contradictory|unrecognised)[^(]*\((.*)\)$/.exec(m)?.[1];
  return (inner ?? (m || humanize(r.rule_id.toLowerCase()))).replace(/\s*\([\d,]+ paise\)/g, "");
}

function Actions({ d, reload, nextLabel }: { d: Detail; reload: () => void; nextLabel: string }) {
  const { api, me } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const l = d.lead;
  const role = me?.role;
  const pendingAck = d.handoffs.find((h) => h.ack_required && !h.acknowledged_at && (h.delivery_status === "sent" || h.delivery_status === "simulated"));
  const canAccept =
    pendingAck &&
    (role === "admin" || (pendingAck.recipient_kind === "designer" && role === "designer" && l.owner?.id === me?.id) || (pendingAck.recipient_kind === "front_desk_queue" && role === "front_desk"));
  const canAssign = role === "admin" || role === "front_desk";
  const canBook = l.qualification_status !== "not_fit" && !["confirmed", "pending_reconciliation"].includes(l.booking_status) && l.outcome_status !== "lost";
  const closed = l.outcome_status === "won" || l.outcome_status === "lost";

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      toast(await fn());
      reload();
    } catch (err) {
      toast(describeError(err).detail, "bad");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="actions-h">
      <div>
        <h2 id="actions-h" className="card-title">Next step</h2>
        <p className="small muted" style={{ margin: "4px 0 0" }}>{nextLabel}</p>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {pendingAck ? (
          canAccept ? (
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => run("ack", async () => {
              const { data } = await api<AcknowledgementResponse>(`/api/v1/leads/${l.id}/acknowledgements`, { method: "POST" });
              return data.already_acknowledged ? "This lead was already accepted." : "Lead accepted. You now own the client relationship.";
            })}>
              <Icon name="check" size={18} /> {busy === "ack" ? "Accepting…" : "Accept lead"}
            </button>
          ) : (
            <div className="note small">Waiting for {pendingAck.recipient_name ?? "the front-desk queue"} to accept.</div>
          )
        ) : null}
        {canAssign ? (
          <button type="button" className="btn" onClick={() => setAssignOpen(true)} disabled={busy !== null}>
            <Icon name="user" size={18} /> {l.owner ? "Reassign designer" : "Assign designer"}
          </button>
        ) : null}
        {canBook ? (
          <button type="button" className="btn" onClick={() => setBookOpen(true)} disabled={busy !== null}>
            <Icon name="calendar" size={18} /> Book consultation
          </button>
        ) : null}
        {!closed ? (
          <button type="button" className="btn" disabled={busy !== null || l.outcome_status === "contacted"} onClick={() => run("contacted", async () => {
            await api<OutcomeResponse>(`/api/v1/leads/${l.id}/outcomes`, { method: "POST", body: { outcome: "contacted", occurred_at: new Date().toISOString() }, headers: { "idempotency-key": `contacted-${l.id}-${l.version}` } });
            return "Marked as contacted.";
          })}>
            <Icon name="phone" size={18} /> {l.outcome_status === "contacted" ? "Contacted" : busy === "contacted" ? "Saving…" : "Mark contacted"}
          </button>
        ) : null}
        <button type="button" className="btn" onClick={() => setOutcomeOpen(true)} disabled={busy !== null}>
          <Icon name="sparkle" size={18} /> Record outcome
        </button>
      </div>
      <dl className="kv small">
        <dt>Designer</dt>
        <dd>{l.owner?.display_name ?? "Unassigned"}</dd>
        <dt>Handoff</dt>
        <dd><StatusChip map={HANDOFF} value={l.handoff_status} /></dd>
        <dt>Outcome</dt>
        <dd>{l.outcome_status === "unknown" ? "Not recorded" : humanize(l.outcome_status)}</dd>
      </dl>
      {d.possible_related_leads.length ? (
        <div className="note small">
          Same phone number as {d.possible_related_leads.map((r, i) => <span key={r.id}>{i ? ", " : ""}<Link href={`/enquiries/${r.id}`}>{r.reference}</Link></span>)}. Not merged automatically.
        </div>
      ) : null}
      {canAssign ? <AssignDialog open={assignOpen} onClose={() => setAssignOpen(false)} d={d} onSaved={reload} /> : null}
      {canBook || bookOpen ? <BookingDialog open={bookOpen} onClose={() => setBookOpen(false)} lead={l} onBooked={reload} /> : null}
      <OutcomeDialog open={outcomeOpen} onClose={() => setOutcomeOpen(false)} d={d} onSaved={reload} />
    </section>
  );
}

function AssignDialog({ open, onClose, d, onSaved }: { open: boolean; onClose: () => void; d: Detail; onSaved: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const staff = useResource(open ? () => api<StaffList>("/api/v1/staff").then((r) => r.data) : null, [open]);
  const [owner, setOwner] = useState(d.lead.owner?.id ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const designers = (staff.data?.data ?? []).filter((s) => s.active && s.role === "designer");
  const save = async () => {
    if (reason.trim().length < 3) {
      setError("Add a short reason (at least 3 characters). It is kept in the audit log.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<PatchLeadResponse>(`/api/v1/leads/${d.lead.id}`, { method: "PATCH", body: { version: d.lead.version, owner_staff_id: owner || null, edit_reason: reason.trim() } });
      toast(owner ? "Designer assigned. They will be notified." : "Lead unassigned.");
      onSaved();
      onClose();
    } catch (err) {
      setError(describeError(err).detail);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Assign a designer" subtitle="The designer owns the client relationship from here." footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      {staff.error ? <ErrorState error={staff.error} onRetry={staff.reload} /> : (
        <div className="stack">
          <label className="field">
            <span>Designer</span>
            <select className="select" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!staff.data}>
              <option value="">Unassigned</option>
              {designers.map((s) => <option key={s.id} value={s.id}>{s.display_name}{s.services.length ? ` · ${s.services.map(serviceLabel).join(", ")}` : ""}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Reason for the change</span>
            <input className="input" value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} placeholder="e.g. Asha has availability this week" />
          </label>
          {error ? <div className="field-error" role="alert">{error}</div> : null}
        </div>
      )}
    </Dialog>
  );
}

function OutcomeDialog({ open, onClose, d, onSaved }: { open: boolean; onClose: () => void; d: Detail; onSaved: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const [outcome, setOutcome] = useState<"contacted" | "consultation_booked" | "won" | "lost">("won");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const rupees = value.trim() ? Number(value.replace(/[,\s₹]/g, "")) : null;
    if (outcome === "won" && rupees !== null && (!Number.isFinite(rupees) || rupees <= 0)) {
      setError("Enter the contract value in rupees, or leave it blank.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { outcome, occurred_at: new Date(`${date}T12:00:00+05:30`).toISOString() };
      if (outcome === "won" && rupees) body.contract_value_paise = Math.round(rupees * 100);
      if (reason.trim()) body.reason = reason.trim();
      await api<OutcomeResponse>(`/api/v1/leads/${d.lead.id}/outcomes`, { method: "POST", body });
      toast("Outcome recorded.");
      onSaved();
      onClose();
    } catch (err) {
      setError(describeError(err).detail);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Record an outcome" subtitle="Outcomes are added to the lead's history and are never overwritten." footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Record outcome"}</button></>}>
      <div className="stack">
        <label className="field">
          <span>Outcome</span>
          <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            <option value="won">Won: client signed</option>
            <option value="lost">Lost</option>
            <option value="consultation_booked">Consultation booked (outside this system)</option>
            <option value="contacted">Contacted</option>
          </select>
        </label>
        <label className="field">
          <span>Date</span>
          <input className="input" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
        </label>
        {outcome === "won" ? (
          <label className="field">
            <span>Contract value agreed (₹, optional)</span>
            <input className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 1500000" />
            <span className="tiny muted">Recorded by the studio after signing. It is not collected revenue, and the assistant never quotes it.</span>
          </label>
        ) : null}
        <label className="field">
          <span>{outcome === "lost" ? "Reason" : "Note (optional)"}</span>
          <input className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error ? <div className="field-error" role="alert">{error}</div> : null}
      </div>
    </Dialog>
  );
}

function Consultations({ d }: { d: Detail }) {
  return (
    <section className="card" aria-labelledby="c-h">
      <div className="card-head">
        <h2 id="c-h" className="card-title">Consultation</h2>
        <StatusChip map={LEAD_BOOKING} value={d.lead.booking_status} />
      </div>
      {d.bookings.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>No consultation requested yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
          {d.bookings.map((b) => (
            <li key={b.id} className="stack" style={{ gap: 4 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <StatusChip map={BOOKING} value={b.status} />
                {b.simulated || b.mode === "mock" ? <Chip tone="terra">Simulated booking</Chip> : <Chip tone="accent">Cal.com</Chip>}
              </div>
              <div className="small">{b.slot_start ? fmtSlot(b.slot_start, b.slot_end) : "No time chosen"}</div>
              <div className="tiny muted">
                {b.confirmed && b.provider_booking_uid ? `Booking ID ${b.provider_booking_uid}` : "Not confirmed: no booking ID from the calendar"} · requested by {b.requested_by === "voice_agent" ? "the assistant" : "staff"}
              </div>
              {b.last_error ? <div className="tiny" style={{ color: "var(--bad)" }}>{b.last_error}</div> : null}
              {b.decline_reason ? <div className="tiny muted">Reason: {b.decline_reason}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Sync({ d }: { d: Detail }) {
  const hub = d.crm_sync.filter((s) => s.provider === "hubspot");
  return (
    <section className="card" aria-labelledby="s-h">
      <div className="card-head">
        <h2 id="s-h" className="card-title">HubSpot and email</h2>
      </div>
      <div className="stack">
        <div>
          <div className="row between"><span className="small" style={{ fontWeight: 500 }}>HubSpot</span><StatusChip map={CRM} value={d.lead.crm_status} /></div>
          {hub.length === 0 ? <p className="tiny muted" style={{ margin: "4px 0 0" }}>Nothing to sync yet. Only qualified leads create a deal.</p> : hub.map((s) => (
            <div key={`${s.object_kind}`} className="tiny muted" style={{ marginTop: 4 }}>
              {humanize(s.object_kind)}: {humanize(s.status)}{s.mode === "mock" ? " (mock, not written to HubSpot)" : ""}{s.attempts > 1 ? ` · ${s.attempts} attempts` : ""}{s.last_error ? ` · ${s.last_error}` : ""}
            </div>
          ))}
        </div>
        <hr className="divider" style={{ margin: 0 }} />
        <div>
          <div className="small" style={{ fontWeight: 500 }}>Handoff emails</div>
          {d.handoffs.length === 0 ? <p className="tiny muted" style={{ margin: "4px 0 0" }}>No handoff yet. It is sent after the call ends.</p> : d.handoffs.map((h) => (
            <div key={h.id} className="stack" style={{ gap: 2, marginTop: 8 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <StatusChip map={DELIVERY} value={h.delivery_status} />
                <span className="tiny">to {h.recipient_name ?? "front-desk queue"} · {humanize(h.purpose)}</span>
              </div>
              <div className="tiny muted">
                {h.sent_at ? `Sent ${fmtWhen(h.sent_at)}` : "Not sent yet"}
                {h.acknowledged_at ? ` · accepted ${fmtWhen(h.acknowledged_at)}` : h.ack_required ? ` · acceptance due ${fmtWhen(h.ack_deadline_at)}${h.ack_overdue ? " (overdue)" : ""}` : ""}
                {h.last_error ? ` · ${h.last_error}` : ""}
              </div>
              {h.preview ? (
                <details className="disclosure tiny">
                  <summary>Preview email</summary>
                  <div className="note" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}><strong>{h.preview.subject}</strong>{"\n\n"}{h.preview.text}</div>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FollowUps({ d }: { d: Detail }) {
  const open = d.human_tasks.filter((t) => t.status === "open");
  if (d.human_tasks.length === 0) return null;
  return (
    <section className="card" aria-labelledby="t-h">
      <div className="card-head">
        <h2 id="t-h" className="card-title">Follow-ups for the team</h2>
        <Chip tone={open.length ? "terra" : "ok"}>{open.length ? `${open.length} open` : "All resolved"}</Chip>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
        {d.human_tasks.map((t) => (
          <li key={t.id} className="small">
            <div className="row wrap" style={{ gap: 6 }}>
              <strong style={{ fontWeight: 500 }}>{ESCALATION[t.kind] ?? humanize(t.kind)}</strong>
              <Chip tone={t.status === "open" ? "warn" : "neutral"}>{humanize(t.status)}</Chip>
            </div>
            <div className="muted">{t.summary}</div>
            <div className="tiny faint">For {humanize(t.assigned_role)}{t.due_at ? ` · due ${fmtWhen(t.due_at)}` : ""}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Timeline({ d }: { d: Detail }) {
  const ev: Array<{ at: string; text: string; terra?: boolean }> = [];
  const push = (at: string | null | undefined, text: string, terra = false) => at && ev.push({ at, text, terra });
  push(d.lead.intake_at, "Enquiry received");
  for (const c of d.calls) {
    push(c.answered_at ?? c.arrived_at, `${c.is_simulated ? "Simulated call" : "Call"} answered`);
    push(c.ended_at, `Call ended${c.duration_seconds !== null ? ` after ${fmtSeconds(c.duration_seconds)}` : ""}`);
  }
  for (const h of d.qualification.history) push(h.created_at, `Assessed: ${QUAL[h.decision]?.label ?? h.decision}${h.kind !== "automatic" ? ` (${humanize(h.kind)})` : ""}`);
  for (const t of d.human_tasks) {
    push(t.created_at, `Follow-up raised: ${ESCALATION[t.kind] ?? humanize(t.kind)}`, true);
    push(t.resolved_at, `Follow-up resolved: ${ESCALATION[t.kind] ?? humanize(t.kind)}`);
  }
  for (const b of d.bookings) {
    push(b.created_at, `Consultation ${b.status === "declined" ? "declined by caller" : "requested"}`);
    if (b.status === "confirmed") push(b.caller_confirmed_at ?? b.created_at, `Consultation confirmed for ${fmtSlot(b.slot_start)}`);
  }
  for (const h of d.handoffs) {
    push(h.sent_at, `${h.delivery_status === "simulated" ? "Simulated email" : "Email"} sent to ${h.recipient_name ?? "front-desk queue"}`);
    push(h.acknowledged_at, `Accepted by ${h.recipient_name ?? "the team"}`);
  }
  for (const o of d.outcomes) push(o.occurred_at, `Outcome: ${humanize(o.outcome)}${o.contract_value_paise ? ` (${fmtLakh(o.contract_value_paise)} contract value)` : ""}`);
  ev.sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section className="card" aria-labelledby="tl-h">
      <h2 id="tl-h" className="card-title" style={{ marginBottom: 14 }}>Activity</h2>
      {ev.length === 0 ? <p className="small muted">No activity yet.</p> : (
        <ol className="timeline">
          {ev.map((e, i) => (
            <li key={i} className={e.terra ? "terra" : ""}>
              <div className="small">{e.text}</div>
              <div className="tiny muted">{fmtWhen(e.at)} IST · {fmtDate(e.at)}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

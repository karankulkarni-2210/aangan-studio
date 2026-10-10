"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { qs, type BookingList, type BookingListItem, type LeadDetail, type LeadList } from "@/ui/api";
import { BookingDialog } from "@/ui/booking";
import { Chip, Dialog, EmptyState, ErrorState, Icon, Segmented, StatusChip, useResource } from "@/ui/components";
import { BOOKING, fmtDayLong, fmtInt, fmtTime, fmtWhen, istDayKey, placeLabel, serviceLabel } from "@/ui/format";
import { useSession } from "@/ui/session";

type Group = "upcoming" | "pending" | "completed" | "cancelled";
const GROUPS: Array<{ value: Group; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled and failed" },
];

function groupOf(b: BookingListItem, now: number): Group {
  if (b.status === "confirmed") return b.slot_start && new Date(b.slot_start).getTime() < now ? "completed" : "upcoming";
  if (b.status === "requested" || b.status === "pending_reconciliation" || b.status === "conflict") return "pending";
  return "cancelled";
}

export default function ConsultationsPage() {
  const { api } = useSession();
  const [group, setGroup] = useState<Group>("upcoming");
  const [pickOpen, setPickOpen] = useState(false);
  const list = useResource(() => api<BookingList>(`/api/v1/bookings${qs({ limit: 200 })}`).then((r) => r.data), []);

  const now = Date.now();
  const counts = useMemo(() => {
    const c: Record<Group, number> = { upcoming: 0, pending: 0, completed: 0, cancelled: 0 };
    for (const b of list.data?.data ?? []) c[groupOf(b, now)]++;
    return c;
  }, [list.data, now]);

  const days = useMemo(() => {
    const items = (list.data?.data ?? []).filter((b) => groupOf(b, now) === group);
    items.sort((a, b) => {
      const ta = new Date(a.slot_start ?? a.created_at ?? 0).getTime();
      const tb = new Date(b.slot_start ?? b.created_at ?? 0).getTime();
      return group === "upcoming" || group === "pending" ? ta - tb : tb - ta;
    });
    const m = new Map<string, BookingListItem[]>();
    for (const b of items) {
      const k = b.slot_start ? istDayKey(b.slot_start) : "unscheduled";
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    return [...m.entries()];
  }, [list.data, group, now]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Consultations</h1>
          <p className="page-lede">Bookings confirmed through Cal.com, and the ones still waiting. Times in IST.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setPickOpen(true)}>
          <Icon name="calendar" /> Book a consultation
        </button>
      </div>

      <div className="row wrap between" style={{ marginBottom: 16 }}>
        <Segmented<Group> label="Consultation status" value={group} onChange={setGroup} options={GROUPS.map((g) => ({ value: g.value, label: `${g.label} (${fmtInt(counts[g.value])})` }))} />
      </div>

      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 76 }} />)}</div>
      ) : days.length === 0 ? (
        <div className="card">
          <EmptyState title={group === "upcoming" ? "No upcoming consultations" : `Nothing ${GROUPS.find((g) => g.value === group)!.label.toLowerCase()}`}>
            {group === "upcoming" ? "Qualified callers can book during the call, or you can book one for them here." : "Bookings in this state will appear here."}
          </EmptyState>
        </div>
      ) : (
        <div className="stack lg">
          {days.map(([day, items]) => (
            <section key={day} aria-label={day === "unscheduled" ? "No time chosen" : fmtDayLong(items[0].slot_start)}>
              <h2 className="small muted" style={{ fontWeight: 500, marginBottom: 8 }}>{day === "unscheduled" ? "No time chosen" : fmtDayLong(items[0].slot_start)}</h2>
              <div className="card flush">
                {items.map((b, i) => (
                  <div key={b.id} className="row wrap" style={{ padding: "14px 18px", borderTop: i ? "1px solid var(--border)" : 0, gap: 14, alignItems: "flex-start" }}>
                    <div style={{ width: 88 }} className="num">
                      <div style={{ fontWeight: 500 }}>{b.slot_start ? fmtTime(b.slot_start) : "–"}</div>
                      <div className="tiny muted">{b.slot_end ? `to ${fmtTime(b.slot_end)}` : "IST"}</div>
                    </div>
                    <div className="grow">
                      <Link href={`/enquiries/${b.lead_id}`} className="row-link" style={{ color: "var(--text)", fontWeight: 500 }}>{b.contact_name ?? "Unnamed caller"}</Link>
                      <div className="small muted">{serviceLabel(b.service_type)} · {placeLabel(b.location_city, b.location_locality)} · {b.lead_reference}</div>
                      <div className="tiny muted">
                        {b.owner ? `Designer: ${b.owner.display_name}` : "No designer assigned"} · requested by {b.requested_by === "voice_agent" ? "the assistant" : "staff"} {fmtWhen(b.created_at)}
                      </div>
                      {b.last_error && b.status !== "confirmed" ? <div className="tiny" style={{ color: "var(--bad)" }}>{b.last_error}</div> : null}
                    </div>
                    <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
                      <StatusChip map={BOOKING} value={b.status} />
                      {b.simulated || b.mode === "mock" ? <Chip tone="terra">Simulated booking</Chip> : <Chip tone="accent">Cal.com</Chip>}
                      {b.status === "confirmed" && !b.confirmed ? <Chip tone="bad">No booking ID</Chip> : null}
                    </div>
                  </div>
                ))}
              </div>
              {group === "pending" ? <p className="tiny muted" style={{ margin: "6px 2px 0" }}>Pending bookings are not confirmed. The system checks Cal.com automatically; don&apos;t rebook them by hand.</p> : null}
            </section>
          ))}
        </div>
      )}
      <PickLeadDialog open={pickOpen} onClose={() => setPickOpen(false)} onBooked={list.reload} />
    </>
  );
}

/** Choose a lead that can still be booked, then run the booking flow for it. */
function PickLeadDialog({ open, onClose, onBooked }: { open: boolean; onClose: () => void; onBooked: () => void }) {
  const { api } = useSession();
  const leads = useResource(open ? () => api<LeadList>(`/api/v1/leads${qs({ qualification: "qualified", page_size: 100 })}`).then((r) => r.data) : null, [open]);
  const [lead, setLead] = useState<LeadDetail["lead"] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const bookable = (leads.data?.data ?? []).filter((l) => l.booking_status === "none" || l.booking_status === "failed" || l.booking_status === "declined");

  const choose = async (id: string) => {
    setLoadError(null);
    try {
      const { data } = await api<LeadDetail>(`/api/v1/leads/${id}`);
      setLead(data.lead);
    } catch (err) {
      setLoadError(err);
    }
  };

  if (lead) {
    return <BookingDialog open={open} lead={lead} onBooked={onBooked} onClose={() => { setLead(null); onClose(); }} />;
  }
  return (
    <Dialog open={open} onClose={onClose} title="Book a consultation" subtitle="Choose a qualified lead without a confirmed consultation.">
      {loadError ? <div style={{ marginBottom: 12 }}><ErrorState error={loadError} /></div> : null}
      {leads.error ? (
        <ErrorState error={leads.error} onRetry={leads.reload} />
      ) : !leads.data ? (
        <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 52 }} />)}</div>
      ) : bookable.length === 0 ? (
        <EmptyState title="No leads waiting for a booking">Every qualified lead already has a consultation or is awaiting confirmation.</EmptyState>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {bookable.map((l) => (
            <button key={l.id} type="button" className="scenario" onClick={() => choose(l.id)}>
              <span className="grow">
                <strong style={{ fontWeight: 500 }}>{l.contact_name ?? "Unnamed caller"}</strong> <span className="tiny muted">{l.reference}</span>
                <span className="small muted" style={{ display: "block" }}>{serviceLabel(l.service_type)} · {placeLabel(l.location_city, l.location_locality)}</span>
              </span>
              {l.is_simulated ? <Chip tone="terra">Simulated</Chip> : null}
              <Icon name="arrow" size={18} />
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

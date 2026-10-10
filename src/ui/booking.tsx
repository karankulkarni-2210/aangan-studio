"use client";

import { useMemo, useState } from "react";
import { ApiFailure, describeError, qs, type BookingResponse, type BookingSlots, type LeadDetail } from "./api";
import { Chip, Dialog, EmptyState, ErrorState, Icon, Skeleton, useResource, useToast } from "./components";
import { fmtDayLong, fmtSlot, fmtTime, istDayKey } from "./format";
import { useSession } from "./session";

// Staff booking flow: real slots from the backend's Cal.com integration (mock calendar for
// simulated leads), IST labels, attendee check, explicit client confirmation, and success only
// when the backend returns a confirmed booking with a provider booking id.

type Slot = { start: string; end: string; label: string };
type Outcome =
  | { kind: "confirmed"; booking: BookingResponse["booking"] }
  | { kind: "pending"; booking: BookingResponse["booking"] }
  | { kind: "error"; error: unknown };

const REASONS: Record<string, string> = {
  lead_not_fit: "This enquiry was assessed as not a fit, so consultations cannot be booked for it.",
  booking_disabled: "Consultation booking is turned off in the studio policy.",
  lead_not_qualified: "Only qualified leads can be booked.",
};

export function BookingDialog({ open, onClose, lead, onBooked }: { open: boolean; onClose: () => void; lead: LeadDetail["lead"]; onBooked: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const slots = useResource(open ? () => api<BookingSlots>(`/api/v1/booking-slots${qs({ lead_id: lead.id })}`).then((r) => r.data) : null, [open, lead.id]);
  const [alternatives, setAlternatives] = useState<Slot[] | null>(null);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [key, setKey] = useState(() => newKey());

  const list = alternatives ?? slots.data?.slots ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of list) m.set(istDayKey(s.start), [...(m.get(istDayKey(s.start)) ?? []), s]);
    return [...m.values()];
  }, [list]);
  const simulated = lead.is_simulated || slots.data?.event_type.mode === "mock";
  const missingName = !lead.contact_name;

  const reset = () => {
    setPicked(null);
    setConfirmed(false);
    setOutcome(null);
    setAlternatives(null);
    setKey(newKey());
  };
  const close = () => {
    reset();
    onClose();
  };

  const book = async () => {
    if (!picked) return;
    setBusy(true);
    setOutcome(null);
    try {
      const { status, data } = await api<BookingResponse>(`/api/v1/leads/${lead.id}/bookings`, {
        method: "POST",
        body: { decision: "book", slot_start: picked.start, caller_confirmed: true, idempotency_key: key },
      });
      if (data.booking.confirmed && data.booking.provider_booking_uid) {
        setOutcome({ kind: "confirmed", booking: data.booking });
        toast("Consultation confirmed.");
        onBooked();
      } else if (status === 202 || data.booking.status === "pending_reconciliation") {
        setOutcome({ kind: "pending", booking: data.booking });
        onBooked();
      } else {
        setOutcome({ kind: "error", error: new ApiFailure(502, "booking_provider_failed", "The calendar did not confirm this booking; it is not booked.") });
        onBooked();
      }
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "slot_unavailable") {
        const alts = ((err.details as { alternatives?: Slot[] } | null)?.alternatives ?? []).filter(Boolean);
        setAlternatives(alts);
        setPicked(null);
        setConfirmed(false);
        setKey(newKey());
      }
      setOutcome({ kind: "error", error: err });
    } finally {
      setBusy(false);
    }
  };

  const err = outcome?.kind === "error" ? outcome.error : null;
  const errCode = err instanceof ApiFailure ? err.code : null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Book a consultation"
      subtitle={
        <span className="row wrap" style={{ gap: 6 }}>
          {lead.contact_name ?? "Unnamed caller"} · {lead.reference} · times in IST
          {simulated ? <Chip tone="terra">Simulated booking (mock calendar)</Chip> : <Chip tone="accent">Cal.com</Chip>}
        </span>
      }
      footer={
        outcome?.kind === "confirmed" ? (
          <button type="button" className="btn primary" onClick={close}>Done</button>
        ) : outcome?.kind === "pending" ? (
          <button type="button" className="btn" onClick={close}>Close</button>
        ) : (
          <>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn primary" disabled={!picked || !confirmed || busy || missingName} onClick={book}>
              {busy ? "Booking…" : "Confirm booking"}
            </button>
          </>
        )
      }
    >
      {outcome?.kind === "confirmed" ? (
        <div className="stack">
          <div className="note ok"><strong>Booked.</strong> {fmtSlot(outcome.booking.slot_start, outcome.booking.slot_end)}</div>
          <dl className="kv">
            <dt>Booking ID</dt>
            <dd className="num">{outcome.booking.provider_booking_uid}</dd>
            <dt>Calendar</dt>
            <dd>{outcome.booking.simulated ? "Simulated booking (mock calendar). No real calendar event was created." : "Cal.com"}</dd>
          </dl>
        </div>
      ) : outcome?.kind === "pending" ? (
        <div className="note warn">
          <strong>Not confirmed yet.</strong> The calendar did not confirm in time, so this is not booked. The system will check Cal.com automatically. Please don&apos;t book again for this lead; check its status in a few minutes.
        </div>
      ) : slots.loading ? (
        <div className="stack">{[0, 1].map((i) => <Skeleton key={i} h={56} />)}</div>
      ) : slots.error ? (
        <ErrorState error={slots.error} onRetry={slots.reload} />
      ) : slots.data && !slots.data.eligible ? (
        <EmptyState title="This lead can't be booked">{REASONS[slots.data.reason ?? ""] ?? slots.data.reason}</EmptyState>
      ) : (
        <div className="stack lg">
          <section className="stack">
            <h3 className="small" style={{ fontWeight: 500 }}>Attendee</h3>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{lead.contact_name ?? <span className="field-error">Missing: capture the client&apos;s name before booking.</span>}</dd>
              <dt>Phone</dt>
              <dd>{lead.caller_phone ?? "Not captured"}</dd>
              <dt>Email</dt>
              <dd>{lead.contact_email ?? "Not captured (optional for this event type)"}</dd>
            </dl>
            <p className="tiny muted" style={{ margin: 0 }}>Cal.com receives these details from the lead record. Correct them on the lead first if they are wrong.</p>
          </section>

          <section className="stack">
            <h3 className="small" style={{ fontWeight: 500 }}>{alternatives ? "That time was just taken. Available alternatives" : "Available times"}</h3>
            {err && errCode !== "slot_unavailable" ? <BookingError error={err} /> : null}
            {list.length === 0 ? (
              <EmptyState title="No open times">
                There are no available consultation times in the booking window. Offer a callback instead, or try again later.
              </EmptyState>
            ) : (
              byDay.map((day) => (
                <div key={day[0].start} className="stack" style={{ gap: 8 }}>
                  <div className="small muted">{fmtDayLong(day[0].start)}</div>
                  <div className="slot-grid">
                    {day.map((s) => (
                      <button key={s.start} type="button" className="slot" aria-pressed={picked?.start === s.start} onClick={() => { setPicked(s); setConfirmed(false); }}>
                        {fmtTime(s.start)} <span className="tiny muted">IST</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>

          {picked ? (
            <section className="stack">
              <div className="note info">Selected: <strong>{fmtSlot(picked.start, picked.end)}</strong></div>
              <label className="check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>The client has confirmed this time with me.</span>
              </label>
            </section>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function BookingError({ error }: { error: unknown }) {
  const code = error instanceof ApiFailure ? error.code : "";
  const next: Record<string, string> = {
    already_booked: "This lead already has a confirmed consultation. See Consultation details on the lead.",
    booking_in_progress: "A booking for this lead is still being confirmed and may already be in the calendar. Wait a few minutes before trying again.",
    booking_provider_failed: "Cal.com rejected the booking, so nothing was booked. Try another time, or arrange it by phone.",
    calendar_unavailable: "Cal.com could not be reached. Nothing was booked. Try again shortly.",
    attendee_name_required: "Capture the client's name on the lead before booking.",
    attendee_email_required: "This event type needs an email address. Add it to the lead first.",
  };
  const d = describeError(error);
  return (
    <div className="note bad" role="alert">
      <Icon name="alert" size={16} /> <strong>Not booked.</strong> {next[code] ?? d.detail}
    </div>
  );
}

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `bk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

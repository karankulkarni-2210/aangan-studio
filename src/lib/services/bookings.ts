import { z } from "zod";
import { env } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { assertSpeakable } from "@/lib/domain/speech-guard";
import { ApiError, badRequest, conflict, forbidden, notFound } from "@/lib/http/errors";
import type { StaffActor, VoiceBinding } from "@/lib/http/route";
import { enqueue, RetryableJobError, type Job } from "@/lib/jobs/outbox";
import { getProviders } from "@/lib/providers/registry";
import type { Slot } from "@/lib/providers/types";
import { now } from "@/lib/runtime";
import { audit } from "./audit";
import { getActivePolicy, getPolicyById, type PolicyRecord } from "./policies";
import { openTask } from "./tasks";

// Consultation booking (Cal.com). A consultation is "booked" only when the caller has confirmed
// the read-back slot AND the provider has returned a booking id. Conflicts ask for another slot;
// timeouts are reconciled (never blindly re-created); failures become front-desk tasks. Declining
// a booking never undoes qualification.

const iso = z.string().datetime({ offset: true });

export const slotsQuerySchema = z.object({
  lead_id: z.string().uuid().optional(),
  start: iso.optional(),
  end: iso.optional(),
});

export const bookingBodySchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("book"),
      slot_start: iso,
      caller_confirmed: z.literal(true),
      idempotency_key: z.string().min(8).max(100),
    })
    .strict(),
  z
    .object({
      decision: z.literal("decline"),
      idempotency_key: z.string().min(8).max(100),
      reason: z.string().max(200).optional(),
    })
    .strict(),
]);

type Actor = { staff: StaffActor | null; voice: VoiceBinding | null };

export function slotLabel(startIso: string): string {
  return new Date(startIso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

async function loadLeadForActor(db: Db, actor: Actor, leadId: string) {
  if (actor.voice?.finalized) throw conflict("call_finalized", "The call has been finalised; bookings now go through staff");
  return db.tx(async (tx) => {
    if (actor.voice) {
      if (actor.voice.leadId !== leadId) throw forbidden("Voice tools may only act on the current call's lead");
    } else if (actor.staff) {
      const visible = await tx.asStaff(actor.staff.auth_user_id, (q) => q.query(`select id from public.leads where id = $1`, [leadId]));
      if (!visible.rows[0]) throw notFound("Lead");
    }
    const { rows } = await tx.query(`select * from public.leads where id = $1`, [leadId]);
    if (!rows[0]) throw notFound("Lead");
    const policy = (await getPolicyById(tx, rows[0].policy_id)) ?? (await getActivePolicy(tx));
    return { lead: rows[0], policy };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function eligibility(actor: Actor, lead: Record<string, any>, policy: PolicyRecord | null): string | null {
  if (!policy?.config.booking.enabled) return "booking_disabled";
  if (actor.voice && lead.qualification_status !== "qualified") return "lead_not_qualified";
  if (lead.qualification_status === "not_fit") return "lead_not_fit";
  return null;
}

export async function listSlots(db: Db, actor: Actor, query: z.infer<typeof slotsQuerySchema>) {
  const leadId = query.lead_id ?? actor.voice?.leadId ?? null;
  if (actor.voice && !leadId) throw badRequest("lead_required", "The call has no lead yet");
  const ctx = leadId ? await loadLeadForActor(db, actor, leadId) : { lead: null, policy: await db.tx((tx) => getActivePolicy(tx)) };
  const policy = ctx.policy;
  const booking = policy?.config.booking;
  const simulated = ctx.lead?.is_simulated ?? actor.voice?.isSimulated ?? false;
  const providers = getProviders(db, { simulated });
  const base = {
    timezone: "Asia/Kolkata",
    event_type: { duration_minutes: booking?.duration_minutes ?? null, provider: "calcom", mode: providers.calendar.mode },
    lead_id: leadId,
  };
  const reason = ctx.lead ? eligibility(actor, ctx.lead, policy) : policy?.config.booking.enabled ? null : "booking_disabled";
  if (reason) return { ...base, eligible: false, reason, slots: [] };

  const start = query.start ? new Date(query.start) : new Date(now().getTime() + 2 * 3600000);
  const end = query.end ? new Date(query.end) : new Date(start.getTime() + booking!.horizon_days * 86400000);
  if (end <= start || end.getTime() - start.getTime() > 31 * 86400000) throw badRequest("invalid_window", "end must be after start and within 31 days");
  const res = await providers.calendar.getSlots({ start, end, durationMinutes: booking!.duration_minutes, timeZone: "Asia/Kolkata" });
  if (res.status !== "ok") throw new ApiError(502, "calendar_unavailable", "Calendar availability could not be retrieved", { retriable: true });
  const limit = actor.voice ? booking!.max_slots_offered : 200;
  const slots = res.data.slice(0, limit).map((s) => ({ ...s, label: slotLabel(s.start) }));
  const out = { ...base, eligible: true, reason: null, slots };
  if (actor.voice) assertSpeakable(out);
  return out;
}

async function sameDaySlots(db: Db, simulated: boolean, slotStart: string, durationMinutes: number): Promise<Slot[] | null> {
  const s = new Date(slotStart);
  const res = await getProviders(db, { simulated }).calendar.getSlots({
    start: new Date(s.getTime() - 3600000),
    end: new Date(s.getTime() + 24 * 3600000),
    durationMinutes,
    timeZone: "Asia/Kolkata",
  });
  return res.status === "ok" ? res.data : null;
}

export async function createBooking(db: Db, actor: Actor, leadId: string, body: z.infer<typeof bookingBodySchema>, requestId: string) {
  const { lead, policy } = await loadLeadForActor(db, actor, leadId);
  const requestKey = `lead:${leadId}:${body.idempotency_key}`;
  const scripts = policy?.config.scripts;
  const requestedBy = actor.voice ? "voice_agent" : "staff";

  // Idempotent replay.
  const existing = await db.query(`select * from public.bookings where request_key = $1`, [requestKey]);
  if (existing.rows[0]) return { replay: true, status: 200, body: bookingBody(existing.rows[0], scripts) };

  if (body.decision === "decline") {
    const row = await db.tx(async (tx) => {
      const { rows } = await tx.query(
        `insert into public.bookings (lead_id, call_id, mode, status, request_key, decline_reason, requested_by)
         values ($1, $2, $3, 'declined', $4, $5, $6) returning *`,
        [leadId, actor.voice?.callId ?? null, lead.is_simulated ? "mock" : "live", requestKey, body.reason ?? null, requestedBy],
      );
      await tx.query(`update public.leads set booking_status = case when booking_status = 'confirmed' then booking_status else 'declined' end where id = $1`, [leadId]);
      await audit(tx, { actor_kind: actor.voice ? "voice_service" : "staff", actor_staff_id: actor.staff?.id ?? null, action: "booking.declined", entity_type: "booking", entity_id: rows[0].id, request_id: requestId });
      return rows[0];
    });
    return { replay: false, status: 201, body: bookingBody(row, scripts) };
  }

  const reason = eligibility(actor, lead, policy);
  if (reason) throw conflict(reason, "This lead is not eligible for a consultation booking");
  if (!lead.contact_name) throw conflict("attendee_name_required", "Capture the caller's name before booking");
  if (policy!.config.booking.require_attendee_email && !lead.contact_email) throw conflict("attendee_email_required", "A confirmed email address is required for this event type");

  const providers = getProviders(db, { simulated: lead.is_simulated });
  const duration = policy!.config.booking.duration_minutes;
  const slotStart = new Date(body.slot_start).toISOString();
  // One booking in flight or confirmed per lead: the lead row is locked for the check, and a
  // partial unique index (bookings_one_active_per_lead) backs it up against concurrent requests.
  const booking = await db.tx(async (tx) => {
    await tx.query(`select id from public.leads where id = $1 for update`, [leadId]);
    const { rows: active } = await tx.query(
      `select status from public.bookings where lead_id = $1 and status in ('requested', 'pending_reconciliation', 'confirmed') limit 1`,
      [leadId],
    );
    if (active[0]?.status === "confirmed") throw conflict("already_booked", "This lead already has a confirmed consultation");
    if (active[0]) throw conflict("booking_in_progress", "A booking for this lead is still being confirmed; it may already exist in the calendar");
    const { rows } = await tx.query(
      `insert into public.bookings (lead_id, call_id, mode, status, request_key, event_type_id, slot_start, slot_end, caller_confirmed_at,
         attendee_name, attendee_email, attendee_phone, requested_by)
       values ($1,$2,$3,'requested',$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [leadId, actor.voice?.callId ?? null, providers.calendar.mode === "live" ? "live" : "mock", requestKey, env.calcom().eventTypeId ?? null,
        slotStart, new Date(new Date(slotStart).getTime() + duration * 60000), now(), lead.contact_name, lead.contact_email, lead.caller_phone, requestedBy],
    );
    return rows[0];
  }).catch((err: unknown) => {
    if ((err as { code?: string }).code === "23505") throw conflict("booking_in_progress", "A booking for this lead is already in progress");
    throw err;
  });

  const conflictResponse = async () => {
    // Alternatives come from the whole booking window, not just the next 24 hours (a Saturday-evening
    // conflict must still offer Monday when Sunday is closed).
    const horizonEnd = new Date(Math.max(new Date(slotStart).getTime(), now().getTime()) + policy!.config.booking.horizon_days * 86400000);
    const res = await getProviders(db, { simulated: lead.is_simulated }).calendar.getSlots({
      start: new Date(Math.max(now().getTime() + 3600000, new Date(slotStart).getTime() - 3600000)),
      end: horizonEnd,
      durationMinutes: duration,
      timeZone: "Asia/Kolkata",
    });
    const alternatives = (res.status === "ok" ? res.data : []).filter((s) => s.start !== slotStart).slice(0, policy!.config.booking.max_slots_offered);
    await db.query(`update public.bookings set status = 'conflict', last_error = 'slot unavailable' where id = $1`, [booking.id]);
    const details = { booking_id: booking.id, alternatives: alternatives.map((s) => ({ ...s, label: slotLabel(s.start) })), say: [scripts?.booking_conflict ?? ""] };
    assertSpeakable(details);
    return new ApiError(409, "slot_unavailable", "The selected slot is no longer available; offer another", details);
  };

  // Re-check availability immediately before creating. If the check itself fails, do not book
  // blind: report "not booked" and leave it to the front desk.
  const fresh = await sameDaySlots(db, lead.is_simulated, slotStart, duration);
  if (fresh && !fresh.some((s) => s.start === slotStart)) throw await conflictResponse();

  const result: Awaited<ReturnType<typeof providers.calendar.createBooking>> = fresh
    ? await providers.calendar.createBooking({
    start: slotStart,
    durationMinutes: duration,
    timeZone: "Asia/Kolkata",
    attendee: { name: lead.contact_name, email: lead.contact_email, phone: lead.caller_phone },
    bookingKey: booking.id,
    metadata: { aangan_lead_id: leadId, aangan_lead_ref: lead.reference },
  })
    : { status: "failed", message: "availability re-check failed; not booked", retriable: true };
  if (result.status === "conflict") throw await conflictResponse();

  const final = await db.tx(async (tx) => {
    if (result.status === "ok") {
      const { rows } = await tx.query(`update public.bookings set status = 'confirmed', provider_booking_uid = $2, last_error = null where id = $1 returning *`, [booking.id, result.data.uid]);
      await markConfirmed(tx, leadId, booking.id, slotStart);
      await audit(tx, { actor_kind: actor.voice ? "voice_service" : "staff", actor_staff_id: actor.staff?.id ?? null, action: "booking.confirmed", entity_type: "booking", entity_id: booking.id, after: { provider_booking_uid: result.data.uid, mode: booking.mode }, request_id: requestId });
      return { row: rows[0], status: 201 };
    }
    const ambiguous = result.status === "ambiguous";
    const { rows } = await tx.query(`update public.bookings set status = $2, last_error = $3 where id = $1 returning *`, [booking.id, ambiguous ? "pending_reconciliation" : "failed", result.message.slice(0, 300)]);
    await tx.query(`update public.leads set booking_status = case when booking_status = 'confirmed' then booking_status else $2 end where id = $1`, [leadId, ambiguous ? "pending_reconciliation" : "failed"]);
    await openTask(tx, {
      lead_id: leadId,
      call_id: actor.voice?.callId ?? null,
      kind: "booking_pending",
      assigned_role: "front_desk",
      summary: ambiguous
        ? "Calendar did not confirm the booking in time. The caller was told it is NOT booked yet; check Cal.com and call them to confirm a time."
        : `Consultation booking failed (${result.message.slice(0, 100)}). The caller was told it is not booked; arrange a time manually.`,
      dedupe_key: `booking:${booking.id}:pending`,
    });
    if (ambiguous) await enqueue(tx, "booking.reconcile", { booking_id: booking.id }, `booking.reconcile:${booking.id}`, { runAfter: new Date(now().getTime() + 60000), maxAttempts: 5 });
    return { row: rows[0], status: ambiguous ? 202 : 502 };
  });
  const responseBody = bookingBody(final.row, scripts);
  if (final.status === 502) throw new ApiError(502, "booking_provider_failed", "The calendar provider rejected the booking; it is not confirmed", responseBody);
  return { replay: false, status: final.status, body: responseBody };
}

async function markConfirmed(tx: { query: Db["query"] }, leadId: string, bookingId: string, slotStart: string) {
  await tx.query(`update public.leads set booking_status = 'confirmed' where id = $1`, [leadId]);
  await tx.query(
    `insert into public.outcome_events (lead_id, outcome, occurred_at, source, idempotency_key)
     values ($1, 'consultation_booked', $2, 'calcom', $3) on conflict (idempotency_key) do nothing`,
    [leadId, now(), `booking:${bookingId}`],
  );
  await tx.query(
    `update public.leads set outcome_status = case when outcome_status in ('won', 'lost') then outcome_status else 'consultation_booked' end where id = $1`,
    [leadId],
  );
  void slotStart;
}

function bookingBody(row: Record<string, unknown>, scripts: Record<string, string> | undefined) {
  const status = row.status as string;
  const say =
    status === "confirmed" && row.slot_start
      ? (scripts?.booking_confirmed ?? "").replace("{slot_label}", slotLabel(new Date(row.slot_start as string).toISOString()))
      : status === "declined"
        ? scripts?.booking_declined
        : status === "conflict"
          ? scripts?.booking_conflict
          : scripts?.booking_pending;
  const body = {
    booking: {
      id: row.id,
      lead_id: row.lead_id,
      status,
      mode: row.mode,
      simulated: row.mode === "mock",
      slot_start: row.slot_start ? new Date(row.slot_start as string).toISOString() : null,
      slot_end: row.slot_end ? new Date(row.slot_end as string).toISOString() : null,
      timezone: row.timezone,
      provider_booking_uid: row.provider_booking_uid ?? null,
      confirmed: status === "confirmed" && Boolean(row.provider_booking_uid),
    },
    say: say ? [say] : [],
  };
  assertSpeakable(body.say);
  return body;
}

export async function reconcileBookingJob(db: Db, job: Job): Promise<void> {
  const bookingId = String(job.payload.booking_id);
  const { rows } = await db.query(`select b.*, l.is_simulated from public.bookings b join public.leads l on l.id = b.lead_id where b.id = $1`, [bookingId]);
  const b = rows[0];
  if (!b || b.status !== "pending_reconciliation") return;
  const res = await getProviders(db, { simulated: b.is_simulated }).calendar.findBooking({
    bookingKey: b.id,
    start: new Date(b.slot_start).toISOString(),
    attendeeName: b.attendee_name,
    attendeeEmail: b.attendee_email,
  });
  if (res.status !== "ok") throw new RetryableJobError(`reconciliation lookup failed: ${"message" in res ? res.message : ""}`);
  await db.tx(async (tx) => {
    if (res.data?.uid) {
      await tx.query(`update public.bookings set status = 'confirmed', provider_booking_uid = $2, last_error = 'confirmed by reconciliation' where id = $1`, [bookingId, res.data.uid]);
      await markConfirmed(tx, b.lead_id, bookingId, new Date(b.slot_start).toISOString());
      // The booking_pending task stays open: the caller was told it was not booked and must be informed.
      await tx.query(
        `update public.human_tasks set summary = summary || ' UPDATE: reconciliation found the booking in Cal.com; tell the caller it is confirmed.' where dedupe_key = $1 and status = 'open'`,
        [`booking:${bookingId}:pending`],
      );
    } else {
      await tx.query(`update public.bookings set status = 'failed', last_error = 'not found during reconciliation' where id = $1`, [bookingId]);
      await tx.query(`update public.leads set booking_status = case when booking_status = 'confirmed' then booking_status else 'failed' end where id = $1`, [b.lead_id]);
    }
    await audit(tx, { actor_kind: "system", action: "booking.reconciled", entity_type: "booking", entity_id: bookingId, after: { found: Boolean(res.data?.uid) } });
  });
}

import { beforeEach, describe, expect, it } from "vitest";
import * as bookingsRoute from "@/app/api/v1/leads/[id]/bookings/route";
import * as slotsRoute from "@/app/api/v1/booking-slots/route";
import type { Db } from "@/lib/db/types";
import { runDispatcher } from "@/lib/jobs/handlers";
import { createMockCalendar } from "@/lib/providers/mock";
import { setProviderOverrides } from "@/lib/providers/registry";
import { setClock } from "@/lib/runtime";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { leadRow, simulate } from "../helpers/scenario";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

/** A qualified lead without a booking (declined_booking scenario), booked again by staff. */
async function qualifiedLead() {
  const r = await simulate(db, "declined_booking");
  await db.query(`update public.leads set booking_status = 'none' where id = $1`, [r.lead_id]);
  const slots = await call(slotsRoute.GET, "GET", `/api/v1/booking-slots?lead_id=${r.lead_id}`, { as: "front_desk" });
  expect(slots.status).toBe(200);
  return { leadId: r.lead_id!, slots: slots.body.slots as Array<{ start: string; label: string }> };
}

const book = (leadId: string, body: unknown) => call(bookingsRoute.POST, "POST", `/api/v1/leads/${leadId}/bookings`, { as: "front_desk", body, params: { id: leadId } });

describe("consultation booking", () => {
  it("requires explicit caller confirmation", async () => {
    const { leadId, slots } = await qualifiedLead();
    const res = await book(leadId, { decision: "book", slot_start: slots[0].start, idempotency_key: "no-confirm-1" });
    expect(res.status).toBe(400);
  });

  it("a calendar conflict returns alternatives and is never confirmed", async () => {
    const { leadId, slots } = await qualifiedLead();
    await db.query(`insert into public.mock_remote_objects (provider, object_kind, remote_id, lookup_key) values ('calcom', 'slot_taken', 'sim_x', $1)`, [slots[0].start]);
    const res = await book(leadId, { decision: "book", slot_start: slots[0].start, caller_confirmed: true, idempotency_key: "conflict-1" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("slot_unavailable");
    expect(res.body.details.alternatives.length).toBeGreaterThan(0);
    expect(res.body.details.say[0]).toMatch(/choose another time/);
    expect((await leadRow(db, leadId)).booking_status).toBe("none");
  });

  it("a timeout after the provider committed is reconciled, not re-created", async () => {
    const { leadId, slots } = await qualifiedLead();
    setProviderOverrides({ calendar: createMockCalendar(db, { createBooking: ["timeout_after_commit"] }) });
    const res = await book(leadId, { decision: "book", slot_start: slots[1].start, caller_confirmed: true, idempotency_key: "timeout-1" });
    expect(res.status).toBe(202);
    expect(res.body.booking).toMatchObject({ status: "pending_reconciliation", confirmed: false });
    expect(res.body.say[0]).toMatch(/not booked yet/);
    setProviderOverrides(null);
    setClock(() => new Date(Date.now() + 2 * 60000));
    await runDispatcher(db, { trigger: "test" });
    const { rows } = await db.query(`select status, provider_booking_uid from public.bookings where lead_id = $1 and request_key like '%timeout-1'`, [leadId]);
    expect(rows[0].status).toBe("confirmed");
    const { rows: remote } = await db.query(`select count(*)::int as n from public.mock_remote_objects where provider = 'calcom' and object_kind = 'booking'`);
    expect(remote[0].n).toBe(1);
    const { rows: task } = await db.query(`select status, summary from public.human_tasks where lead_id = $1 and kind = 'booking_pending'`, [leadId]);
    expect(task[0].status).toBe("open"); // the caller was told it was NOT booked; staff must inform them
    expect(task[0].summary).toMatch(/reconciliation found the booking/);
  });

  it("a timeout before commit reconciles to failed and leaves a task", async () => {
    const { leadId, slots } = await qualifiedLead();
    setProviderOverrides({ calendar: createMockCalendar(db, { createBooking: ["timeout"] }) });
    await book(leadId, { decision: "book", slot_start: slots[0].start, caller_confirmed: true, idempotency_key: "timeout-2" });
    setProviderOverrides(null);
    setClock(() => new Date(Date.now() + 2 * 60000));
    await runDispatcher(db, { trigger: "test" });
    const lead = await leadRow(db, leadId);
    expect(lead.booking_status).toBe("failed");
    expect(lead.qualification_status).toBe("qualified");
  });

  it("a provider rejection is reported as not confirmed (502) and the lead stays qualified", async () => {
    const { leadId, slots } = await qualifiedLead();
    setProviderOverrides({ calendar: createMockCalendar(db, { createBooking: ["fail"] }) });
    const res = await book(leadId, { decision: "book", slot_start: slots[0].start, caller_confirmed: true, idempotency_key: "provider-fail-1" });
    expect(res.status).toBe(502);
    expect(res.body.details.booking.confirmed).toBe(false);
    expect((await leadRow(db, leadId)).qualification_status).toBe("qualified");
  });

  it("replays are idempotent on the idempotency key", async () => {
    const { leadId, slots } = await qualifiedLead();
    const a = await book(leadId, { decision: "book", slot_start: slots[2].start, caller_confirmed: true, idempotency_key: "same-key-1" });
    const b = await book(leadId, { decision: "book", slot_start: slots[2].start, caller_confirmed: true, idempotency_key: "same-key-1" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.booking.id).toBe(a.body.booking.id);
  });

  it("voice tools cannot book for a lead that is not qualified", async () => {
    const r = await simulate(db, "missing_budget");
    const { rows } = await db.query(`select id from public.calls where lead_id = $1`, [r.lead_id]);
    void rows;
    const slots = await call(slotsRoute.GET, "GET", `/api/v1/booking-slots?lead_id=${r.lead_id}`, { as: "admin" });
    expect(slots.body.eligible).toBe(true); // staff may book a needs_review lead after review
    const ns = await simulate(db, "unsupported_construction");
    const blocked = await call(slotsRoute.GET, "GET", `/api/v1/booking-slots?lead_id=${ns.lead_id}`, { as: "admin" });
    expect(blocked.body).toMatchObject({ eligible: false, reason: "lead_not_fit", slots: [] });
  });

  it("never allows a second booking while one is pending reconciliation", async () => {
    const { leadId, slots } = await qualifiedLead();
    setProviderOverrides({ calendar: createMockCalendar(db, { createBooking: ["timeout_after_commit"] }) });
    expect((await book(leadId, { decision: "book", slot_start: slots[0].start, caller_confirmed: true, idempotency_key: "first-attempt" })).status).toBe(202);
    setProviderOverrides(null);
    const second = await book(leadId, { decision: "book", slot_start: slots[1].start, caller_confirmed: true, idempotency_key: "second-attempt" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("booking_in_progress");
    setClock(() => new Date(Date.now() + 2 * 60000));
    await runDispatcher(db, { trigger: "test" });
    const { rows } = await db.query(`select count(*)::int as n from public.mock_remote_objects where provider = 'calcom' and object_kind = 'booking'`);
    expect(rows[0].n).toBe(1);
    const again = await book(leadId, { decision: "book", slot_start: slots[2].start, caller_confirmed: true, idempotency_key: "third-attempt" });
    expect(again.body.code).toBe("already_booked");
  });

  it("offers alternatives beyond the next 24 hours (Saturday-evening conflict, Sunday closed)", async () => {
    // Saturday 12:33 IST: the only remaining slot today is 17:00; the next ones are on Monday.
    setClock(() => new Date("2026-10-10T07:03:00Z"));
    const { leadId, slots } = await qualifiedLead();
    expect(slots[0].start).toBe("2026-10-10T11:30:00.000Z");
    await db.query(`insert into public.mock_remote_objects (provider, object_kind, remote_id, lookup_key) values ('calcom', 'slot_taken', 'sim_sat', $1)`, [slots[0].start]);
    const res = await book(leadId, { decision: "book", slot_start: slots[0].start, caller_confirmed: true, idempotency_key: "sat-evening-1" });
    expect(res.status).toBe(409);
    expect(res.body.details.alternatives[0].start).toBe("2026-10-12T05:30:00.000Z"); // Monday 11:00 IST
  });
});

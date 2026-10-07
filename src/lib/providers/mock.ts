import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/types";
import type { CalendarAdapter, CrmAdapter, EmailAdapter, ProviderResult, Slot } from "./types";

// Mock providers persist their "remote" state in mock_remote_objects so behaviour is consistent
// across serverless invocations and duplicate creates are observable in tests. Every ID they
// return is prefixed `sim_` so simulated results can never be mistaken for live ones.

export type Fault = "fail" | "fail_once" | "timeout" | "timeout_after_commit" | "conflict";
export type FaultPlan = Partial<Record<string, Fault[]>>;

function takeFault(plan: FaultPlan | undefined, op: string): Fault | undefined {
  const list = plan?.[op];
  if (!list || list.length === 0) return undefined;
  return list.shift();
}

const shortId = () => randomUUID().replace(/-/g, "").slice(0, 12);

async function findRemote(db: Db, provider: string, kind: string, lookupKey: string) {
  const { rows } = await db.query(
    `select remote_id, payload from public.mock_remote_objects where provider = $1 and object_kind = $2 and lookup_key = $3 order by created_at limit 1`,
    [provider, kind, lookupKey],
  );
  return rows[0] as { remote_id: string; payload: Record<string, unknown> } | undefined;
}

async function insertRemote(db: Db, provider: string, kind: string, lookupKey: string, payload: unknown, prefix: string) {
  const id = `sim_${prefix}_${shortId()}`;
  await db.query(
    `insert into public.mock_remote_objects (provider, object_kind, remote_id, lookup_key, payload) values ($1, $2, $3, $4, $5)`,
    [provider, kind, id, lookupKey, JSON.stringify(payload)],
  );
  return id;
}

// Demo availability: Mon-Sat at 11:00, 14:30 and 17:00 IST.
const SLOT_TIMES_IST = [
  [11, 0],
  [14, 30],
  [17, 0],
];

export function mockSlotsBetween(start: Date, end: Date, durationMinutes: number): Slot[] {
  const out: Slot[] = [];
  const IST_OFFSET_MIN = 330;
  const dayMs = 86400000;
  const firstIstMidnight = Math.floor((start.getTime() + IST_OFFSET_MIN * 60000) / dayMs) * dayMs - IST_OFFSET_MIN * 60000;
  for (let day = firstIstMidnight; day < end.getTime(); day += dayMs) {
    const weekday = new Date(day + IST_OFFSET_MIN * 60000).getUTCDay(); // 0 = Sunday in IST
    if (weekday === 0) continue;
    for (const [h, m] of SLOT_TIMES_IST) {
      const s = day + (h * 60 + m) * 60000;
      if (s < start.getTime() || s >= end.getTime()) continue;
      out.push({ start: new Date(s).toISOString(), end: new Date(s + durationMinutes * 60000).toISOString() });
    }
  }
  return out;
}

export function createMockCalendar(db: Db, faults?: FaultPlan): CalendarAdapter {
  return {
    mode: "mock",
    async getSlots({ start, end, durationMinutes }) {
      const fault = takeFault(faults, "getSlots");
      if (fault === "fail" || fault === "fail_once") return { status: "failed", message: "simulated calendar outage", retriable: true };
      const { rows } = await db.query<{ lookup_key: string }>(
        `select lookup_key from public.mock_remote_objects where provider = 'calcom' and object_kind = 'slot_taken'`,
      );
      const taken = new Set(rows.map((r) => r.lookup_key));
      return { status: "ok", data: mockSlotsBetween(start, end, durationMinutes).filter((s) => !taken.has(s.start)) };
    },
    async createBooking(input) {
      const fault = takeFault(faults, "createBooking");
      if (fault === "fail" || fault === "fail_once") return { status: "failed", message: "simulated calendar error", retriable: false };
      if (fault === "timeout") return { status: "ambiguous", message: "simulated timeout before commit" };
      const takenRow = await findRemote(db, "calcom", "slot_taken", input.start);
      if (takenRow || fault === "conflict") return { status: "conflict", message: "slot no longer available" };
      const uid = await insertRemote(db, "calcom", "booking", input.bookingKey, { start: input.start, attendee: input.attendee, metadata: input.metadata }, "cal");
      await insertRemote(db, "calcom", "slot_taken", input.start, { uid }, "slot");
      if (fault === "timeout_after_commit") return { status: "ambiguous", message: "simulated timeout after commit" };
      return { status: "ok", data: { uid } };
    },
    async findBooking({ bookingKey }) {
      const row = await findRemote(db, "calcom", "booking", bookingKey);
      return { status: "ok", data: row ? { uid: row.remote_id } : null };
    },
  };
}

export function createMockCrm(db: Db, faults?: FaultPlan): CrmAdapter {
  return {
    mode: "mock",
    async upsertContact({ name, phone, email, leadId }) {
      const fault = takeFault(faults, "upsertContact");
      if (fault === "fail" || fault === "fail_once") return { status: "failed", message: "simulated CRM outage", retriable: true };
      if (fault === "timeout") return { status: "ambiguous", message: "simulated timeout" };
      const key = email ? `email:${email}` : phone ? `phone:${phone}` : `lead:${leadId}`;
      const existing = await findRemote(db, "hubspot", "contact", key);
      if (existing) return { status: "ok", data: { id: existing.remote_id, created: false } };
      const id = await insertRemote(db, "hubspot", "contact", key, { name, phone, email }, "hs_contact");
      if (fault === "timeout_after_commit") return { status: "ambiguous", message: "simulated timeout after commit" };
      return { status: "ok", data: { id, created: true } };
    },
    async upsertDeal({ leadId, dealName, contactId, description }) {
      const fault = takeFault(faults, "upsertDeal");
      if (fault === "fail" || fault === "fail_once") return { status: "failed", message: "simulated CRM outage", retriable: true };
      if (fault === "timeout") return { status: "ambiguous", message: "simulated timeout" };
      const existing = await findRemote(db, "hubspot", "deal", `lead:${leadId}`);
      if (existing) return { status: "ok", data: { id: existing.remote_id, created: false } };
      const id = await insertRemote(db, "hubspot", "deal", `lead:${leadId}`, { dealName, contactId, description, stage: "open (simulated)" }, "hs_deal");
      if (fault === "timeout_after_commit") return { status: "ambiguous", message: "simulated timeout after commit" };
      return { status: "ok", data: { id, created: true } };
    },
  };
}

export function createMockEmail(db: Db, faults?: FaultPlan): EmailAdapter {
  return {
    mode: "mock",
    async send(msg): Promise<ProviderResult<{ id: string }>> {
      const fault = takeFault(faults, "send");
      if (fault === "fail" || fault === "fail_once") return { status: "failed", message: "simulated email provider error", retriable: true };
      if (fault === "timeout") return { status: "ambiguous", message: "simulated timeout" };
      // Mirrors provider idempotency: the same key returns the original message id.
      const existing = await findRemote(db, "resend", "email", msg.idempotencyKey);
      if (existing) return { status: "ok", data: { id: existing.remote_id } };
      const id = await insertRemote(db, "resend", "email", msg.idempotencyKey, { to: msg.to, subject: msg.subject, tags: msg.tags }, "email");
      return { status: "ok", data: { id } };
    },
  };
}

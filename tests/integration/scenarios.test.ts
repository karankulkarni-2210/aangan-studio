import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { inspectSpeech } from "@/lib/domain/speech-guard";
import { listScenarios } from "@/lib/simulation/scenarios";
import type { SimulationResult } from "@/lib/simulation/runner";
import { createTestDb } from "../helpers/db";
import { leadRow, simulate } from "../helpers/scenario";

// End-to-end: every synthetic scenario through signed webhooks, call-bound tools, booking API,
// finalisation, outbox jobs, mock providers. Expected outcomes live in the fixtures.

let db: Db;
const results = new Map<string, SimulationResult>();

beforeAll(async () => {
  db = await createTestDb();
  for (const s of listScenarios()) results.set(s.id, await simulate(db, s.id));
});

describe.each(listScenarios().map((s) => [s.id, s] as const))("scenario %s", (id, scenario) => {
  it("matches the expected decision, discovery, escalations, booking, handoff and CRM", async () => {
    const r = results.get(id)!;
    const lead = await leadRow(db, r.lead_id!);
    expect(lead.is_simulated).toBe(true);
    expect(lead.qualification_status).toBe(scenario.expected.decision);
    expect(lead.discovery_status).toBe(scenario.expected.discovery_status);
    const { rows: tasks } = await db.query(`select kind from public.human_tasks where lead_id = $1`, [r.lead_id]);
    const kinds = tasks.map((t) => t.kind);
    for (const e of scenario.expected.escalations) expect(kinds).toContain(e);
    expect(lead.booking_status).toBe(scenario.expected.booking_status);
    const { rows: handoffs } = await db.query(`select purpose, delivery_status, recipient_kind, recipient_email from public.handoffs where lead_id = $1 and purpose <> 'ack_escalation'`, [r.lead_id]);
    if (scenario.expected.handoff_purpose) {
      expect(handoffs.map((h) => h.purpose)).toEqual([scenario.expected.handoff_purpose]);
      expect(handoffs[0].delivery_status).toBe("simulated");
    } else {
      expect(handoffs).toHaveLength(0);
    }
    expect(lead.crm_status === "synced").toBe(scenario.expected.crm_synced);
    // Every job finished; nothing is stuck or dead.
    const { rows: dead } = await db.query(`select count(*)::int as n from public.outbox_jobs where status = 'dead'`);
    expect(dead[0].n).toBe(0);
  });

  it("the agent never spoke a price, range, total, discount, tax term or commitment", async () => {
    const r = results.get(id)!;
    for (const line of r.transcript.filter((l) => l.speaker === "agent")) {
      expect(inspectSpeech(line.text), line.text).toEqual({ blocked: false, codes: [] });
    }
    const { rows } = await db.query(`select count(*)::int as n from public.human_tasks where lead_id = $1 and kind = 'agent_price_utterance'`, [r.lead_id]);
    expect(rows[0].n).toBe(0);
  });
});

describe("cross-scenario guarantees", () => {
  it("records every call and saves a lead for each, including interrupted calls", async () => {
    const { rows } = await db.query(`select count(*)::int as calls, count(distinct lead_id)::int as leads from public.calls`);
    expect(rows[0]).toEqual({ calls: results.size, leads: results.size });
  });

  it("a pricing question produces a human task and only the approved script, never a price", async () => {
    const r = results.get("suitable_home")!;
    const pricingTurn = r.transcript.findIndex((l) => /per square foot/i.test(l.text) && l.speaker === "caller");
    const reply = r.transcript[pricingTurn + 1];
    expect(reply.speaker).toBe("agent");
    expect(reply.text).toMatch(/A designer will confirm pricing after reviewing your scope/);
    expect(inspectSpeech(reply.text).blocked).toBe(false);
  });

  it("a booking is announced only after provider confirmation (conflict first, then confirmed)", async () => {
    const r = results.get("suitable_home")!;
    expect(r.steps.find((s) => s.step === "api.booking_create")?.http_status).toBe(409);
    expect(r.steps.find((s) => s.step === "api.booking_create_retry")).toMatchObject({ http_status: 201, detail: { status: "confirmed", confirmed: true } });
    const conflictIdx = r.transcript.findIndex((l) => /just been taken/.test(l.text));
    const bookedIdx = r.transcript.findIndex((l) => /consultation is booked for/.test(l.text));
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(bookedIdx).toBeGreaterThan(conflictIdx);
    const { rows } = await db.query(`select status, provider_booking_uid from public.bookings where lead_id = $1 order by created_at`, [r.lead_id]);
    expect(rows.map((b) => b.status)).toEqual(["conflict", "confirmed"]);
    expect(rows[1].provider_booking_uid).toMatch(/^sim_cal_/);
  });

  it("declining a booking keeps the lead qualified and still hands it to a designer", async () => {
    const lead = await leadRow(db, results.get("declined_booking")!.lead_id!);
    expect(lead).toMatchObject({ qualification_status: "qualified", booking_status: "declined", handoff_status: "sent" });
    expect(lead.owner_staff_id).not.toBeNull();
  });

  it("the interrupted call saved partial facts and opened a callback task", async () => {
    const r = results.get("interrupted_call")!;
    const lead = await leadRow(db, r.lead_id!);
    expect(lead.service_type).toBe("full_home_interiors");
    expect(lead.location_locality).toBe("Hadapsar");
    expect(lead.area_sqft).toBeNull(); // "nine hundred square" was cut off: unconfirmed, never guessed
    expect(lead.fact_status.area.status).toBe("unconfirmed");
    const { rows } = await db.query(`select kind from public.human_tasks where lead_id = $1`, [r.lead_id]);
    expect(rows.map((t) => t.kind)).toEqual(expect.arrayContaining(["callback", "needs_review"]));
  });

  it("prompt injection is treated as data: no qualification, no attacker recipient", async () => {
    const r = results.get("prompt_injection")!;
    const lead = await leadRow(db, r.lead_id!);
    expect(lead.injection_suspected).toBe(true);
    expect(lead.qualification_status).toBe("needs_review");
    const { rows: handoffs } = await db.query(`select recipient_email from public.handoffs where lead_id = $1`, [r.lead_id]);
    expect(handoffs.map((h) => h.recipient_email)).toEqual(["front-desk@aangan-demo.example"]);
    const { rows: emails } = await db.query(`select payload from public.mock_remote_objects where provider = 'resend'`);
    expect(JSON.stringify(emails)).not.toContain("attacker.example");
    const { rows: reasons } = await db.query(`select reasons from public.qualification_assessments where lead_id = $1`, [r.lead_id]);
    expect(JSON.stringify(reasons)).toContain("INJECTION_REVIEW");
  });

  it("ambiguous area units are read back; a rejected read-back is discarded", async () => {
    const r = results.get("ambiguous_area")!;
    const confirmTurn = r.steps.find((s) => s.step === "tool.capture_facts[1]");
    expect(confirmTurn?.detail).toMatchObject({ next: "area", next_kind: "confirm" });
    const { rows } = await db.query(`select value, confirmation_status from public.field_evidence where lead_id = $1 and field = 'area' order by created_at`, [r.lead_id]);
    expect(rows[0]).toMatchObject({ confirmation_status: "rejected" });
    expect(rows[1].value).toMatchObject({ original_unit: "sqm", original_value: 110 });
    const lead = await leadRow(db, r.lead_id!);
    // Shown on the lead as stated, but the qualification rule still requires a read-back.
    expect(lead.area_sqft).toBeCloseTo(1184.03, 1);
    expect(lead.fact_status.area.status).toBe("stated");
    expect(lead.qualification_reasons).toContainEqual(expect.objectContaining({ rule_id: "AREA_POSITIVE_CONFIRMED", result: "unconfirmed", effect: "needs_review" }));
  });

  it("after-hours calls are flagged from the staffed hours in the pinned policy", async () => {
    const { rows } = await db.query(`select after_hours from public.calls where lead_id = $1`, [results.get("price_only")!.lead_id]);
    expect(rows[0].after_hours).toBe(true);
  });

  it("automatic emails go only to the approved roster or the front-desk queue, never to callers", async () => {
    const { rows: mail } = await db.query(`select payload->>'to' as to from public.mock_remote_objects where provider = 'resend'`);
    const { rows: staff } = await db.query(`select email from public.staff where active and approved_for_handoff`);
    const allowed = new Set([...staff.map((s) => s.email), "front-desk@aangan-demo.example"]);
    expect(mail.length).toBeGreaterThan(0);
    for (const m of mail) expect(allowed.has(m.to), m.to).toBe(true);
  });

  it("duplicate status deliveries were ignored", async () => {
    for (const r of results.values()) {
      expect(r.steps.find((s) => s.step === "webhook.status_duplicate_delivery")?.detail).toEqual({ duplicate: true });
    }
    const { rows } = await db.query(`select count(*)::int as n from public.provider_events`);
    expect(rows[0].n).toBe(results.size * 2);
  });
});

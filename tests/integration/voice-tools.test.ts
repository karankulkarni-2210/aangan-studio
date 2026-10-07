import { beforeEach, describe, expect, it } from "vitest";
import * as bookingsRoute from "@/app/api/v1/leads/[id]/bookings/route";
import * as captureRoute from "@/app/internal/voice/tools/capture-facts/route";
import * as escalateRoute from "@/app/internal/voice/tools/escalate-to-human/route";
import * as evaluateRoute from "@/app/internal/voice/tools/evaluate-qualification/route";
import * as handoffRoute from "@/app/internal/voice/tools/request-handoff/route";
import type { Db } from "@/lib/db/types";
import { inspectSpeech } from "@/lib/domain/speech-guard";
import { setClock } from "@/lib/runtime";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { startCall } from "../helpers/voice";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const PRICING_SCRIPT = "A designer will confirm pricing after reviewing your scope. I can capture your details and help book a consultation.";

describe("voice tool authentication and binding", () => {
  it("requires the service credential and a valid call token", async () => {
    const c = await startCall();
    const body = { utterances: [{ seq: 0, speaker: "caller", text: "hello" }] };
    expect((await call(captureRoute.POST, "POST", "/x", { body })).status).toBe(401);
    expect((await call(captureRoute.POST, "POST", "/x", { body, headers: { ...c.headers, authorization: "Bearer nope" } })).status).toBe(401);
    expect((await call(captureRoute.POST, "POST", "/x", { body, headers: { ...c.headers, "x-aangan-call-token": "0".repeat(64) } })).status).toBe(401);
    expect((await call(captureRoute.POST, "POST", "/x", { body, headers: c.headers })).status).toBe(200);
  });

  it("cannot act on another call's lead", async () => {
    const a = await startCall();
    const b = await startCall();
    const res = await call(bookingsRoute.POST, "POST", `/api/v1/leads/${b.leadId}/bookings`, {
      body: { decision: "decline", idempotency_key: "cross-call-1" },
      headers: a.headers,
      params: { id: b.leadId },
    });
    expect(res.status).toBe(403);
  });

  it("closes tools 15 minutes after the call ends", async () => {
    const c = await startCall();
    await c.end();
    setClock(() => new Date(Date.now() + 16 * 60000));
    const res = await c.say("one more thing");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("call_closed");
  });

  it("request-handoff rejects AI-supplied recipients", async () => {
    const c = await startCall();
    const res = await call(handoffRoute.POST, "POST", "/x", { body: { reason: "qualified", recipient_email: "someone@attacker.example" }, headers: c.headers });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation_failed");
  });
});

describe("human escalation boundaries", () => {
  it("a price question produces a pricing task and the approved script, without any price", async () => {
    const c = await startCall();
    const res = await c.say("Roughly how much do you charge per square foot for a 2BHK?");
    expect(res.status).toBe(200);
    expect(res.body.escalations).toEqual([expect.objectContaining({ kind: "pricing_request", say: PRICING_SCRIPT })]);
    for (const line of res.body.say) expect(inspectSpeech(line).blocked).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/₹|\brs\.?\s*\d|per sq/i);
    const { rows } = await db.query(`select kind, status, assigned_role, summary from public.human_tasks where lead_id = $1`, [c.leadId]);
    expect(rows).toEqual([expect.objectContaining({ kind: "pricing_request", status: "open", assigned_role: "front_desk" })]);
    expect(rows[0].summary).toMatch(/No price was given/);
  });

  it("a complaint produces a human task", async () => {
    const c = await startCall();
    const res = await c.say("I want to make a complaint, the last designer was very disappointing.");
    expect(res.body.escalations.map((e: { kind: string }) => e.kind)).toContain("complaint");
    const { rows } = await db.query(`select kind from public.human_tasks where lead_id = $1`, [c.leadId]);
    expect(rows.map((r) => r.kind)).toContain("complaint");
  });

  it("a project promise is refused and referred without commitment", async () => {
    const c = await startCall();
    const res = await c.say("Can you guarantee it will be done by Diwali and give a discount?");
    const esc = res.body.escalations.find((e: { kind: string }) => e.kind === "commitment_request");
    expect(esc.say).toMatch(/not able to make commitments/);
    expect(inspectSpeech(esc.say).blocked).toBe(false);
  });

  it("explicit escalate-to-human is idempotent per call and uses the after-hours script out of hours", async () => {
    const c = await startCall();
    await db.query(`update public.calls set after_hours = true where id = $1`, [c.callId]);
    const a = await call(escalateRoute.POST, "POST", "/x", { body: { kind: "human_requested" }, headers: c.headers });
    const b = await call(escalateRoute.POST, "POST", "/x", { body: { kind: "human_requested" }, headers: c.headers });
    expect(a.body.say[0]).toMatch(/front desk is closed/);
    expect(a.body.transfer.available).toBe(false);
    expect(b.body).toMatchObject({ task_id: a.body.task_id, duplicate: true });
  });

  it("missing qualification facts become needs_review (never not_fit)", async () => {
    const c = await startCall();
    await c.say("We need full home interiors for our flat in Baner.");
    const ev = await call(evaluateRoute.POST, "POST", "/x", { body: {}, headers: c.headers });
    expect(ev.body.decision).toBe("needs_review");
    expect(ev.body.missing_fields).toEqual(expect.arrayContaining(["area", "budget", "timeline"]));
    expect(ev.body.booking_eligible).toBe(false);
  });

  it("asks one question at a time and never re-asks a settled answer", async () => {
    const c = await startCall();
    const r1 = await c.say("We need full home interiors in Kothrud.");
    expect(r1.body.next).toMatchObject({ kind: "question", field: "area" });
    const r2 = await c.say("Sorry, what was that?", r1.body.next.prompt);
    expect(r2.body.next.field).toBe("area");
    expect(r2.body.facts.service).toBe("stated");
  });
});

describe("missing policy", () => {
  it("answers with a fallback, saves the lead and routes to review", async () => {
    await db.query(`update public.business_policies set status = 'retired'`);
    const c = await startCall();
    expect(c.incoming.agent_context).toMatchObject({ policy_missing: true });
    const res = await c.say("We want home interiors in Baner, about 1000 square feet.");
    expect(res.status).toBe(200);
    expect(res.body.say.join(" ")).toMatch(/team will call you back/);
    const ev = await call(evaluateRoute.POST, "POST", "/x", { body: {}, headers: c.headers });
    expect(ev.body.decision).toBe("needs_review");
    expect(ev.body.reasons[0].rule_id).toBe("POLICY_MISSING");
  });
});

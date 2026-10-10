import { beforeEach, describe, expect, it } from "vitest";
import * as ackRoute from "@/app/api/v1/leads/[id]/acknowledgements/route";
import * as leadRoute from "@/app/api/v1/leads/[id]/route";
import type { Db } from "@/lib/db/types";
import { runDispatcher } from "@/lib/jobs/handlers";
import { createMockCrm, createMockEmail } from "@/lib/providers/mock";
import { setProviderOverrides } from "@/lib/providers/registry";
import { setClock } from "@/lib/runtime";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { leadRow, simulate } from "../helpers/scenario";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const drain = async () => {
  for (let i = 0; i < 6; i++) {
    const r = await runDispatcher(db, { trigger: "test" });
    if (r.remaining_ready === 0) break;
  }
};

describe("designer handoff delivery", () => {
  it("sends a deterministic summary with an authenticated link and no transcript", async () => {
    const r = await simulate(db, "suitable_home");
    const { rows } = await db.query(`select * from public.handoffs where lead_id = $1`, [r.lead_id]);
    const h = rows[0];
    expect(h).toMatchObject({ purpose: "designer_handoff", recipient_kind: "designer", delivery_status: "simulated", delivery_mode: "mock" });
    expect(h.recipient_email).toMatch(/@aangan-demo\.example$/);
    expect(h.subject).toMatch(/^\[SIMULATED\] Qualified enquiry AGN-/);
    expect(h.body_text).toContain(`/leads/${r.lead_id}`);
    expect(h.body_text).toMatch(/PRICING REQUESTED/);
    expect(h.body_text).toMatch(/Budget \(caller's own figure, not a quote\): ₹15,00,000/);
    expect(h.body_text).toMatch(/Consultation: CONFIRMED/);
    expect(h.body_text).toMatch(/Email delivery is not acknowledgement/);
    expect(h.body_text).not.toMatch(/how much do you charge/i); // transcript stays behind auth
    expect(h.body_text).not.toContain("+919000000101"); // phone masked in email
  });

  it("an email failure is visible, retried, and does not block CRM", async () => {
    setProviderOverrides({ email: createMockEmail(db, { send: ["fail", "fail", "fail", "fail", "fail", "fail"] }) });
    const r = await simulate(db, "declined_booking", { runJobs: false });
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) {
      setClock(() => new Date(t0 + i * 3600_000));
      await runDispatcher(db, { trigger: "test" });
    }
    const lead = await leadRow(db, r.lead_id!);
    expect(lead.handoff_status).toBe("failed");
    expect(lead.crm_status).toBe("synced");
    const { rows: h } = await db.query(`select delivery_status, attempts, last_error from public.handoffs where lead_id = $1`, [r.lead_id]);
    expect(h[0]).toMatchObject({ delivery_status: "failed", attempts: 6 });
    const { rows: t } = await db.query(`select kind from public.human_tasks where lead_id = $1 and kind = 'integration_failure'`, [r.lead_id]);
    expect(t).toHaveLength(1);
  });

  it("a transient email failure succeeds on retry", async () => {
    setProviderOverrides({ email: createMockEmail(db, { send: ["fail_once"] }) });
    const r = await simulate(db, "declined_booking", { runJobs: false });
    await runDispatcher(db, { trigger: "test" });
    setClock(() => new Date(Date.now() + 120_000));
    await drain();
    const lead = await leadRow(db, r.lead_id!);
    expect(lead.handoff_status).toBe("sent");
  });

  it("re-running finalisation never creates a second handoff or email", async () => {
    const r = await simulate(db, "declined_booking");
    await db.query(`update public.calls set finalized_at = null where lead_id = $1`, [r.lead_id]);
    await db.query(`insert into public.outbox_jobs (kind, payload, dedupe_key) values ('call.finalize', $1, 'refinalize')`, [JSON.stringify({ call_id: r.call_id })]);
    await drain();
    const { rows } = await db.query(`select count(*)::int as n from public.handoffs where lead_id = $1`, [r.lead_id]);
    expect(rows[0].n).toBe(1);
    const { rows: mail } = await db.query(`select count(*)::int as n from public.mock_remote_objects where provider = 'resend'`);
    expect(mail[0].n).toBe(1);
  });

  it("CRM failure isolation: a down CRM leaves the lead and email intact", async () => {
    setProviderOverrides({ crm: createMockCrm(db, { upsertContact: Array(10).fill("fail") }) });
    const r = await simulate(db, "declined_booking", { runJobs: false });
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) {
      setClock(() => new Date(t0 + i * 3600_000));
      await runDispatcher(db, { trigger: "test" });
    }
    const lead = await leadRow(db, r.lead_id!);
    expect(lead).toMatchObject({ qualification_status: "qualified", handoff_status: "sent", crm_status: "failed" });
  });
});

describe("acknowledgement", () => {
  it("only the assigned designer (or an admin) can accept; repeats are idempotent", async () => {
    const r = await simulate(db, "suitable_home");
    const lead = await leadRow(db, r.lead_id!);
    const { rows: s } = await db.query(`select email from public.staff where id = $1`, [lead.owner_staff_id]);
    expect(s[0].email).toBe("asha.demo@aangan-demo.example");
    const path = `/api/v1/leads/${r.lead_id}/acknowledgements`;
    const params = { id: r.lead_id! };

    expect((await call(ackRoute.POST, "POST", path, { params })).status).toBe(401);
    expect((await call(ackRoute.POST, "POST", path, { as: "designer_b", params })).status).toBe(404); // not visible (RLS)
    expect((await call(ackRoute.POST, "POST", path, { as: "front_desk", params })).status).toBe(403);
    const first = await call(ackRoute.POST, "POST", path, { as: "designer", params });
    expect(first.status).toBe(201);
    const second = await call(ackRoute.POST, "POST", path, { as: "designer", params });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ handoff_id: first.body.handoff_id, already_acknowledged: true });
    expect((await leadRow(db, r.lead_id!)).handoff_status).toBe("acknowledged");
  });

  it("front desk accepts review handoffs from the shared queue", async () => {
    const r = await simulate(db, "price_only");
    const res = await call(ackRoute.POST, "POST", `/api/v1/leads/${r.lead_id}/acknowledgements`, { as: "front_desk", params: { id: r.lead_id! } });
    expect(res.status).toBe(201);
  });

  it("an unacknowledged handoff becomes overdue and escalates to the front desk", async () => {
    const r = await simulate(db, "suitable_home");
    setClock(() => new Date(Date.now() + 121 * 60000));
    await drain();
    const lead = await leadRow(db, r.lead_id!);
    expect(lead.ack_overdue).toBe(true);
    const { rows } = await db.query(`select purpose, recipient_kind, delivery_status from public.handoffs where lead_id = $1 order by created_at`, [r.lead_id]);
    expect(rows.map((h) => h.purpose)).toEqual(["designer_handoff", "ack_escalation"]);
    expect(rows[1]).toMatchObject({ recipient_kind: "front_desk_queue", delivery_status: "simulated" });
    const { rows: t } = await db.query(`select status from public.human_tasks where lead_id = $1 and kind = 'ack_overdue'`, [r.lead_id]);
    expect(t[0].status).toBe("open");
    // Late acknowledgement clears the overdue state and resolves the task.
    const ack = await call(ackRoute.POST, "POST", `/api/v1/leads/${r.lead_id}/acknowledgements`, { as: "designer", params: { id: r.lead_id! } });
    expect(ack.status).toBe(201);
    expect((await leadRow(db, r.lead_id!)).ack_overdue).toBe(false);
  });

  it("reassigning to another designer re-targets the handoff to them (no lockout)", async () => {
    const r = await simulate(db, "suitable_home");
    const id = r.lead_id!;
    const { rows: vikram } = await db.query(`select id from public.staff where email = 'vikram.demo@aangan-demo.example'`);
    const lead = await leadRow(db, id);
    const patch = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "front_desk", params: { id }, body: { version: lead.version, owner_staff_id: vikram[0].id, edit_reason: "Asha on leave" } });
    expect(patch.status).toBe(200);
    await drain();
    const { rows: h } = await db.query(`select recipient_email, delivery_status from public.handoffs where lead_id = $1 and purpose = 'designer_handoff'`, [id]);
    expect(h[0]).toEqual({ recipient_email: "vikram.demo@aangan-demo.example", delivery_status: "simulated" });
    const { rows: mail } = await db.query(`select payload->>'to' as to from public.mock_remote_objects where provider = 'resend' order by created_at`);
    expect(mail.map((m) => m.to)).toContain("vikram.demo@aangan-demo.example");
    const params = { id };
    expect((await call(ackRoute.POST, "POST", `/api/v1/leads/${id}/acknowledgements`, { as: "designer", params })).status).toBe(404);
    expect((await call(ackRoute.POST, "POST", `/api/v1/leads/${id}/acknowledgements`, { as: "designer_b", params })).status).toBe(201);
  });

  it("reassigning to the front desk supersedes the designer handoff instead of leaving it to go overdue", async () => {
    const r = await simulate(db, "suitable_home");
    const id = r.lead_id!;
    const { rows: fd } = await db.query(`select id from public.staff where email = 'frontdesk.a@aangan-demo.example'`);
    const lead = await leadRow(db, id);
    await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "front_desk", params: { id }, body: { version: lead.version, owner_staff_id: fd[0].id, edit_reason: "front desk handling" } });
    setClock(() => new Date(Date.now() + 3 * 3600_000));
    await drain();
    expect((await leadRow(db, id)).ack_overdue).toBe(false);
    const { rows } = await db.query(`select count(*)::int as n from public.human_tasks where lead_id = $1 and kind = 'ack_overdue'`, [id]);
    expect(rows[0].n).toBe(0);
  });

  it("a designer's acceptance supersedes the earlier front-desk review handoff", async () => {
    const r = await simulate(db, "missing_budget");
    const id = r.lead_id!;
    const lead = await leadRow(db, id);
    await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "front_desk", params: { id }, body: { version: lead.version, facts: [{ field: "budget", paise: 120_000_000 }], edit_reason: "budget shared on callback" } });
    await drain();
    const owner = await leadRow(db, id);
    const { rows: s } = await db.query(`select email from public.staff where id = $1`, [owner.owner_staff_id]);
    const key = s[0].email.startsWith("vikram") ? "designer_b" : s[0].email.startsWith("neha") ? "designer_c" : "designer";
    expect((await call(ackRoute.POST, "POST", `/api/v1/leads/${id}/acknowledgements`, { as: key, params: { id } })).status).toBe(201);
    setClock(() => new Date(Date.now() + 3 * 3600_000));
    await drain();
    const after = await leadRow(db, id);
    expect(after).toMatchObject({ handoff_status: "acknowledged", ack_overdue: false });
    const { rows } = await db.query(`select count(*)::int as n from public.human_tasks where lead_id = $1 and kind = 'ack_overdue'`, [id]);
    expect(rows[0].n).toBe(0);
  });

  it("the pilot redirect sends live handoffs to DESIGNER_HANDOFF_EMAIL and names the intended recipient", async () => {
    process.env.DESIGNER_HANDOFF_EMAIL = "pilot.designer@example.com";
    const sent: Array<{ to: string; text: string }> = [];
    setProviderOverrides({ email: { mode: "live", send: async (m) => { sent.push({ to: m.to, text: m.text }); return { status: "ok", data: { id: `live_${sent.length}` } }; } } });
    const r = await simulate(db, "suitable_home");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("pilot.designer@example.com");
    expect(sent[0].text).toMatch(/^PILOT REDIRECT: intended for asha\.demo@aangan-demo\.example/);
    const { rows } = await db.query(`select recipient_email, delivery_status from public.handoffs where lead_id = $1`, [r.lead_id]);
    expect(rows[0]).toEqual({ recipient_email: "asha.demo@aangan-demo.example", delivery_status: "sent" });
  });

  it("mock (simulated) sends ignore the pilot redirect", async () => {
    process.env.DESIGNER_HANDOFF_EMAIL = "pilot.designer@example.com";
    await simulate(db, "suitable_home");
    const { rows } = await db.query(`select payload->>'to' as to from public.mock_remote_objects where provider = 'resend'`);
    expect(rows.map((x) => x.to)).toEqual(["asha.demo@aangan-demo.example"]);
  });
});

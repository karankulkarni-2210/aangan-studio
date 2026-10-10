import { beforeAll, describe, expect, it } from "vitest";
import * as leadRoute from "@/app/api/v1/leads/[id]/route";
import * as leadsRoute from "@/app/api/v1/leads/route";
import { LeadDetail, LeadList, PatchLeadResponse } from "@/lib/api/schemas";
import type { Db } from "@/lib/db/types";
import type { SimulationResult } from "@/lib/simulation/runner";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { leadRow, simulate } from "../helpers/scenario";

let db: Db;
const r: Record<string, SimulationResult> = {};
beforeAll(async () => {
  db = await createTestDb();
  for (const id of ["suitable_home", "missing_budget", "declined_booking", "unsupported_construction"]) r[id] = await simulate(db, id);
});

describe("lead inbox", () => {
  it("front desk sees every lead; the payload matches the contract", async () => {
    const res = await call(leadsRoute.GET, "GET", "/api/v1/leads", { as: "front_desk" });
    expect(res.status).toBe(200);
    expect(LeadList.safeParse(res.body).success).toBe(true);
    expect(res.body.pagination.total).toBe(4);
  });

  it("designers only see leads assigned to them (row-level security)", async () => {
    const asha = await call(leadsRoute.GET, "GET", "/api/v1/leads", { as: "designer" });
    const owners = new Set(asha.body.data.map((l: { owner: { display_name: string } | null }) => l.owner?.display_name));
    expect([...owners]).toEqual(["Designer Asha (demo)"]);
    const { rows } = await db.query(`select count(*)::int as n from public.leads l join public.staff s on s.id = l.owner_staff_id where s.email = 'neha.demo@aangan-demo.example'`);
    const neha = await call(leadsRoute.GET, "GET", "/api/v1/leads", { as: "designer_c" });
    expect(neha.body.data).toHaveLength(rows[0].n);
    expect(neha.body.data.every((l: { owner: { display_name: string } }) => l.owner.display_name === "Designer Neha (demo)")).toBe(true);
  });

  it("filters by stage, service, owner and paginates", async () => {
    const notFit = await call(leadsRoute.GET, "GET", "/api/v1/leads?status=not_fit", { as: "admin" });
    expect(notFit.body.data.map((l: { id: string }) => l.id)).toEqual([r.unsupported_construction.lead_id]);
    const office = await call(leadsRoute.GET, "GET", "/api/v1/leads?service=small_office_interiors", { as: "admin" });
    expect(office.body.pagination.total).toBe(2);
    const mine = await call(leadsRoute.GET, "GET", "/api/v1/leads?owner=me", { as: "designer" });
    expect(mine.body.data.length).toBeGreaterThan(0);
    const page = await call(leadsRoute.GET, "GET", "/api/v1/leads?page=2&page_size=3", { as: "admin" });
    expect(page.body).toMatchObject({ data: [expect.any(Object)], pagination: { page: 2, total_pages: 2 } });
    const bad = await call(leadsRoute.GET, "GET", "/api/v1/leads?status=bogus", { as: "admin" });
    expect(bad.status).toBe(400);
  });
});

describe("lead detail", () => {
  it("returns facts, evidence, calls, qualification, flags, bookings, CRM, handoffs and outcomes", async () => {
    const id = r.suitable_home.lead_id!;
    const res = await call(leadRoute.GET, "GET", `/api/v1/leads/${id}`, { as: "admin", params: { id } });
    expect(res.status).toBe(200);
    const parsed = LeadDetail.safeParse(res.body);
    if (!parsed.success) console.error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 1));
    expect(parsed.success).toBe(true);
    const d = res.body;
    expect(d.data_labels).toEqual({ simulated: true, demo_policy: true, policy_version: 1 });
    expect(d.facts.area).toMatchObject({ status: "confirmed", display: "1,250 sq ft, carpet" });
    expect(d.facts.budget.display).toBe("₹15,00,000 (caller-stated)");
    expect(d.evidence.every((e: { quote: string | null }) => e.quote)).toBe(true);
    expect(d.calls[0].transcript.length).toBeGreaterThan(10);
    expect(d.calls[0].response_seconds).toBeLessThanOrEqual(5);
    expect(d.escalation_flags).toMatchObject({ pricing_requested: true, complaint: false });
    expect(d.bookings.find((b: { status: string }) => b.status === "confirmed")).toMatchObject({ confirmed: true, simulated: true });
    expect(d.crm_sync).toHaveLength(2);
    expect(d.handoffs[0].preview.subject).toMatch(/SIMULATED/);
    expect(d.outcomes).toEqual([expect.objectContaining({ outcome: "consultation_booked", source: "calcom" })]);
    expect(d.qualification.current).toMatchObject({ decision: "qualified", policy_version: 1, kind: "automatic" });
  });

  it("designers also see the demo/simulated labels on their own leads", async () => {
    const id = r.suitable_home.lead_id!;
    const res = await call(leadRoute.GET, "GET", `/api/v1/leads/${id}`, { as: "designer", params: { id } });
    expect(res.status).toBe(200);
    expect(res.body.data_labels).toEqual({ simulated: true, demo_policy: true, policy_version: 1 });
  });

  it("a designer cannot read another designer's lead or its transcript", async () => {
    const id = r.suitable_home.lead_id!;
    const res = await call(leadRoute.GET, "GET", `/api/v1/leads/${id}`, { as: "designer_b", params: { id } });
    expect(res.status).toBe(404);
  });

  it("rejects malformed ids", async () => {
    const res = await call(leadRoute.GET, "GET", `/api/v1/leads/not-a-uuid`, { as: "admin", params: { id: "not-a-uuid" } });
    expect(res.status).toBe(400);
  });
});

describe("authorised human edits", () => {
  it("enforces optimistic concurrency and audits the change", async () => {
    const id = r.missing_budget.lead_id!;
    const lead = await leadRow(db, id);
    const stale = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "front_desk", params: { id }, body: { version: lead.version - 1, notes: "x", edit_reason: "test" } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "version_conflict", details: { current_version: lead.version } });
    const ifMatch = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "front_desk", params: { id }, headers: { "if-match": `"${lead.version + 5}"` }, body: { version: lead.version, notes: "x", edit_reason: "test" } });
    expect(ifMatch.status).toBe(412);
    const ok = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "front_desk", params: { id }, body: { version: lead.version, notes: "Called back; budget confirmed by phone.", edit_reason: "callback" } });
    expect(ok.status).toBe(200);
    expect(PatchLeadResponse.safeParse(ok.body).success).toBe(true);
    const { rows } = await db.query(`select action, before, after from public.audit_events where entity_id = $1 and action = 'lead.edited'`, [id]);
    expect(rows[0].after.notes).toMatch(/budget confirmed/);
    expect(rows[0].before.notes).toBeNull();
  });

  it("a fact correction triggers a recorded reassessment, keeping the call-time assessment", async () => {
    const id = r.missing_budget.lead_id!;
    const lead = await leadRow(db, id);
    const res = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, {
      as: "front_desk",
      params: { id },
      body: { version: lead.version, facts: [{ field: "budget", paise: 10_000_000 }], edit_reason: "Caller shared budget on callback" },
    });
    expect(res.status).toBe(200);
    expect(res.body.qualification.decision).toBe("not_fit");
    const { rows } = await db.query(`select kind, decision, policy_version, created_by from public.qualification_assessments where lead_id = $1 order by created_at`, [id]);
    // In-call and end-of-call automatic assessments are kept; the human reassessment is appended.
    expect(rows.map((a) => [a.kind, a.decision])).toEqual([
      ["automatic", "qualified"],
      ["automatic", "qualified"],
      ["reassessment", "not_fit"],
    ]);
    expect(rows[2].created_by).not.toBeNull();
    const { rows: h } = await db.query(`select purpose from public.handoffs where lead_id = $1 order by created_at`, [id]);
    expect(h.map((x) => x.purpose)).toEqual(["designer_handoff"]);
  });

  it("designers cannot reassign or override qualification", async () => {
    const id = r.suitable_home.lead_id!;
    const lead = await leadRow(db, id);
    const res = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "designer", params: { id }, body: { version: lead.version, owner_staff_id: null, edit_reason: "reassign" } });
    expect(res.status).toBe(403);
    const ok = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, { as: "designer", params: { id }, body: { version: lead.version, notes: "Site visit planned", edit_reason: "note" } });
    expect(ok.status).toBe(200);
  });

  it("an administrator can override qualification with a reason", async () => {
    const id = r.unsupported_construction.lead_id!;
    const lead = await leadRow(db, id);
    const res = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${id}`, {
      as: "admin",
      params: { id },
      body: { version: lead.version, qualification_override: { decision: "needs_review", reason: "Caller also wants interiors after construction" }, edit_reason: "founder review" },
    });
    expect(res.body.qualification.decision).toBe("needs_review");
    const { rows } = await db.query(`select kind, override_reason from public.qualification_assessments where lead_id = $1 order by created_at desc limit 1`, [id]);
    expect(rows[0]).toMatchObject({ kind: "human_override", override_reason: expect.stringContaining("interiors") });
  });
});

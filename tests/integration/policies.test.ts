import { beforeEach, describe, expect, it } from "vitest";
import policyJson from "../../config/policy.demo.json";
import * as publishRoute from "@/app/api/v1/policies/[id]/publish/route";
import * as policiesRoute from "@/app/api/v1/policies/route";
import * as readyRoute from "@/app/ready/route";
import { PolicyDraftResponse, PolicyList } from "@/lib/api/schemas";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { simulate } from "../helpers/scenario";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("policy versions", () => {
  it("is readable by admin and front desk only", async () => {
    expect((await call(policiesRoute.GET, "GET", "/api/v1/policies", { as: "designer" })).status).toBe(403);
    const res = await call(policiesRoute.GET, "GET", "/api/v1/policies", { as: "front_desk" });
    expect(res.status).toBe(200);
    expect(PolicyList.safeParse(res.body).success).toBe(true);
    expect(res.body.readiness).toMatchObject({ active_version: 1, active_is_demo: true, pricing_in_voice_context: false });
  });

  it("only administrators create drafts; invalid drafts cannot be published", async () => {
    expect((await call(policiesRoute.POST, "POST", "/api/v1/policies", { as: "front_desk", body: { config: policyJson } })).status).toBe(403);
    const bad = structuredClone(policyJson);
    bad.escalation.pricing_request.say = "Our standard rate is ₹1,600 per sq ft, indicative only.";
    const draft = await call(policiesRoute.POST, "POST", "/api/v1/policies", { as: "admin", body: { config: bad } });
    expect(draft.status).toBe(201);
    expect(PolicyDraftResponse.safeParse(draft.body).success).toBe(true);
    expect(draft.body.validation.ok).toBe(false);
    const pub = await call(publishRoute.POST, "POST", "/x", { as: "admin", params: { id: draft.body.policy.id } });
    expect(pub.status).toBe(400);
    expect(pub.body.code).toBe("policy_invalid");
  });

  it("publishing is audited, retires the old version, and earlier calls stay pinned", async () => {
    const before = await simulate(db, "missing_budget");
    const next = structuredClone(policyJson);
    next.label = "Demo data and sample business rules";
    (next.qualification_rules.find((r) => r.id === "BUDGET_NOT_CLEARLY_BELOW_SCOPE") as { threshold: number }).threshold = 50_000_000;
    const draft = await call(policiesRoute.POST, "POST", "/api/v1/policies", { as: "admin", body: { config: next } });
    expect(draft.body.validation.ok).toBe(true);
    expect((await call(publishRoute.POST, "POST", "/x", { as: "designer", params: { id: draft.body.policy.id } })).status).toBe(403);
    const pub = await call(publishRoute.POST, "POST", "/x", { as: "admin", params: { id: draft.body.policy.id } });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ version: 2, status: "active" });
    const again = await call(publishRoute.POST, "POST", "/x", { as: "admin", params: { id: draft.body.policy.id } });
    expect(again.status).toBe(409);
    const { rows } = await db.query(`select version, status from public.business_policies order by version`);
    expect(rows).toEqual([{ version: 1, status: "retired" }, { version: 2, status: "active" }]);
    const { rows: audit } = await db.query(`select before, after from public.audit_events where action = 'policy.published'`);
    expect(audit[0].after.active_version).toBe(2);
    const { rows: pinned } = await db.query(`select distinct policy_version from public.qualification_assessments where lead_id = $1`, [before.lead_id]);
    expect(pinned).toEqual([{ policy_version: 1 }]);
    const after = await simulate(db, "missing_budget");
    const { rows: newer } = await db.query(`select distinct policy_version from public.qualification_assessments where lead_id = $1`, [after.lead_id]);
    expect(newer).toEqual([{ policy_version: 2 }]);
  });

  it("readiness fails when no policy is active, without exposing configuration values", async () => {
    await db.query(`update public.business_policies set status = 'retired'`);
    const res = await call(readyRoute.GET, "GET", "/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.find((c: { name: string }) => c.name === "active_policy")).toMatchObject({ ok: false, blocking: true });
    expect(JSON.stringify(res.body)).not.toContain(process.env.VOICE_TOOL_SECRET!);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import * as bookingsRoute from "@/app/api/v1/bookings/route";
import * as slotsRoute from "@/app/api/v1/booking-slots/route";
import * as costRoute from "@/app/api/v1/cost-entries/route";
import * as dashboardRoute from "@/app/api/v1/dashboard/route";
import * as sessionRoute from "@/app/api/v1/demo/session/route";
import * as leadRoute from "@/app/api/v1/leads/[id]/route";
import * as leadsRoute from "@/app/api/v1/leads/route";
import * as meRoute from "@/app/api/v1/me/route";
import * as policiesRoute from "@/app/api/v1/policies/route";
import * as staffRoute from "@/app/api/v1/staff/route";
import { BookingList, Dashboard, DemoSession, Me, StaffList } from "@/lib/api/schemas";
import type { Db } from "@/lib/db/types";
import type { SimulationResult } from "@/lib/simulation/runner";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { simulate } from "../helpers/scenario";

let db: Db;
let sandbox: string;
let realLead: string;
const r: Record<string, SimulationResult> = {};

beforeAll(async () => {
  db = await createTestDb();
  for (const id of ["suitable_home", "missing_budget"]) r[id] = await simulate(db, id);
  // Stand-in for a real (non-simulated) customer record.
  realLead = r.missing_budget.lead_id!;
  await db.query(`update public.leads set is_simulated = false where id = $1`, [realLead]);
  const res = await call(sessionRoute.POST, "POST", "/api/v1/demo/session", { body: { persona: "admin" } });
  expect(res.status).toBe(201);
  expect(DemoSession.safeParse(res.body).success).toBe(true);
  sandbox = res.body.access_token;
});

describe("evaluator sandbox session", () => {
  it("identifies itself as a sandbox", async () => {
    const me = await call(meRoute.GET, "GET", "/api/v1/me", { token: sandbox });
    expect(Me.safeParse(me.body).success).toBe(true);
    expect(me.body).toMatchObject({ role: "admin", sandbox: true });
    const staff = await call(meRoute.GET, "GET", "/api/v1/me", { as: "admin" });
    expect(staff.body.sandbox).toBe(false);
  });

  it("only sees simulated leads; real records are not found", async () => {
    const list = await call(leadsRoute.GET, "GET", "/api/v1/leads?simulated=false", { token: sandbox });
    expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([r.suitable_home.lead_id]);
    expect((await call(leadRoute.GET, "GET", `/api/v1/leads/${realLead}`, { token: sandbox, params: { id: realLead } })).status).toBe(404);
    const patch = await call(leadRoute.PATCH, "PATCH", `/api/v1/leads/${realLead}`, { token: sandbox, params: { id: realLead }, body: { version: 1, notes: "x", edit_reason: "test" } });
    expect(patch.status).toBe(404);
    expect((await call(leadRoute.GET, "GET", `/api/v1/leads/${realLead}`, { as: "admin", params: { id: realLead } })).status).toBe(200);
  });

  it("never sees live calendar availability", async () => {
    expect((await call(slotsRoute.GET, "GET", "/api/v1/booking-slots", { token: sandbox })).status).toBe(400);
    expect((await call(slotsRoute.GET, "GET", `/api/v1/booking-slots?lead_id=${realLead}`, { token: sandbox })).status).toBe(404);
    const sim = await call(slotsRoute.GET, "GET", `/api/v1/booking-slots?lead_id=${r.suitable_home.lead_id}`, { token: sandbox });
    expect(sim.status).toBe(200);
    expect(sim.body.event_type.mode).toBe("mock");
  });

  it("cannot change studio configuration without the edit passcode", async () => {
    delete process.env.SETTINGS_PASSCODE;
    const draft = await call(policiesRoute.POST, "POST", "/api/v1/policies", { token: sandbox, body: { config: {} } });
    expect(draft).toMatchObject({ status: 403, body: { code: "sandbox_read_only" } });
    process.env.SETTINGS_PASSCODE = "studio-passcode-1";
    expect((await call(policiesRoute.POST, "POST", "/api/v1/policies", { token: sandbox, body: { config: {} } })).body.code).toBe("settings_passcode_required");
    expect((await call(policiesRoute.POST, "POST", "/api/v1/policies", { token: sandbox, body: { config: {} }, headers: { "x-settings-passcode": "wrong-pass" } })).body.code).toBe("settings_passcode_invalid");
    const ok = await call(policiesRoute.POST, "POST", "/api/v1/policies", { token: sandbox, body: { config: {} }, headers: { "x-settings-passcode": "studio-passcode-1" } });
    expect(ok.status).toBe(201); // stored as an invalid draft; publishing still requires a valid one
    delete process.env.SETTINGS_PASSCODE;
    const cost = await call(costRoute.POST, "POST", "/api/v1/cost-entries", { token: sandbox, body: {} });
    expect(cost.status).toBe(403);
  });

  it("dashboard is limited to simulated data and includes the daily series", async () => {
    const res = await call(dashboardRoute.GET, "GET", "/api/v1/dashboard?data=all", { token: sandbox });
    expect(Dashboard.safeParse(res.body).success).toBe(true);
    expect(res.body.period.data).toBe("simulated");
    expect(res.body.daily.length).toBeGreaterThanOrEqual(30);
    const days = res.body.daily as Array<{ calls: number; leads: number }>;
    expect(days.reduce((n, d) => n + d.calls, 0)).toBe(res.body.metrics.calls.total);
    expect(days.reduce((n, d) => n + d.leads, 0)).toBe(res.body.metrics.leads.unique);
  });
});

describe("workspace directory endpoints", () => {
  it("lists consultations with confirmation only when the provider returned an id", async () => {
    const res = await call(bookingsRoute.GET, "GET", "/api/v1/bookings", { as: "front_desk" });
    expect(res.status).toBe(200);
    expect(BookingList.safeParse(res.body).success).toBe(true);
    const b = res.body.data.find((x: { lead_id: string }) => x.lead_id === r.suitable_home.lead_id);
    expect(b).toMatchObject({ status: "confirmed", confirmed: true, simulated: true, mode: "mock" });
    const sb = await call(bookingsRoute.GET, "GET", "/api/v1/bookings?simulated=false", { token: sandbox });
    expect(sb.body.data.every((x: { simulated: boolean }) => x.simulated)).toBe(true);
  });

  it("returns the staff roster to the front desk but not designers", async () => {
    const res = await call(staffRoute.GET, "GET", "/api/v1/staff", { as: "front_desk" });
    expect(StaffList.safeParse(res.body).success).toBe(true);
    expect(res.body.data.some((s: { role: string }) => s.role === "designer")).toBe(true);
    expect((await call(staffRoute.GET, "GET", "/api/v1/staff", { as: "designer" })).status).toBe(403);
  });

  it("rejects an unknown demo persona", async () => {
    expect((await call(sessionRoute.POST, "POST", "/api/v1/demo/session", { body: { persona: "root" } })).status).toBe(400);
  });
});

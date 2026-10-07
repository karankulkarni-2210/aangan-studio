import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import * as demoRoute from "@/app/api/v1/demo/calls/route";
import * as integrationsRoute from "@/app/api/v1/integrations/route";
import * as leadsRoute from "@/app/api/v1/leads/route";
import * as meRoute from "@/app/api/v1/me/route";
import * as healthRoute from "@/app/health/route";
import * as readyRoute from "@/app/ready/route";
import { Integrations, Me, Ready, SimulationResult } from "@/lib/api/schemas";
import type { Db } from "@/lib/db/types";
import { redact } from "@/lib/log";
import { createTestDb } from "../helpers/db";
import { call, tokenFor } from "../helpers/http";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const LIVE_ENV = {
  APP_MODE: "live",
  DATABASE_URL: "postgres://configured-but-unused",
  SUPABASE_JWT_SECRET: "s".repeat(40),
  VOICE_TOOL_SECRET: "v".repeat(40),
  DISPATCH_SECRET: "d".repeat(40),
  VAANI_WEBHOOK_SECRET: "w".repeat(40),
  APP_BASE_URL: "https://aangan.example",
};

describe("authentication and roles", () => {
  it("requires a token; rejects tokens for non-staff and anonymous users", async () => {
    expect((await call(leadsRoute.GET, "GET", "/api/v1/leads")).status).toBe(401);
    expect((await call(leadsRoute.GET, "GET", "/api/v1/leads", { token: "garbage" })).status).toBe(401);
    const secret = new TextEncoder().encode(process.env.DEMO_JWT_SECRET!);
    const stranger = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject("11111111-1111-4111-8111-111111111111").setAudience("authenticated").setExpirationTime("1h").sign(secret);
    expect((await call(leadsRoute.GET, "GET", "/api/v1/leads", { token: stranger })).status).toBe(403);
    const anon = await new SignJWT({ role: "authenticated", is_anonymous: true }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-4000-8000-000000000001").setAudience("authenticated").setExpirationTime("1h").sign(secret);
    expect((await call(leadsRoute.GET, "GET", "/api/v1/leads", { token: anon })).status).toBe(401);
    const expired = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-4000-8000-000000000001").setAudience("authenticated").setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(secret);
    expect((await call(leadsRoute.GET, "GET", "/api/v1/leads", { token: expired })).status).toBe(401);
  });

  it("roles come from the staff table", async () => {
    const me = await call(meRoute.GET, "GET", "/api/v1/me", { as: "designer" });
    expect(Me.safeParse(me.body).success).toBe(true);
    expect(me.body).toMatchObject({ role: "designer", app_mode: "demo" });
    await db.query(`update public.staff set active = false where email = 'asha.demo@aangan-demo.example'`);
    expect((await call(meRoute.GET, "GET", "/api/v1/me", { as: "designer" })).status).toBe(403);
  });

  it("the demo endpoint is role-restricted", async () => {
    expect((await call(demoRoute.POST, "POST", "/api/v1/demo/calls", { as: "designer", body: { scenario: "price_only" } })).status).toBe(403);
    const ok = await call(demoRoute.POST, "POST", "/api/v1/demo/calls", { as: "front_desk", body: { scenario: "price_only" } });
    expect(ok.status).toBe(201);
    expect(SimulationResult.safeParse(ok.body).success).toBe(true);
    expect(ok.body.label).toMatch(/SIMULATED CALL/);
  });
});

describe("live mode fails closed", () => {
  it("serves only /health while security configuration is incomplete", async () => {
    const token = await tokenFor("admin");
    process.env.APP_MODE = "live";
    expect((await call(healthRoute.GET, "GET", "/health")).body).toEqual({ status: "ok", app_mode: "live" });
    const leads = await call(leadsRoute.GET, "GET", "/api/v1/leads", { token });
    expect(leads.status).toBe(503);
    expect(leads.body.code).toBe("configuration_incomplete");
    const ready = await call(readyRoute.GET, "GET", "/ready");
    expect(ready.status).toBe(503);
    expect(Ready.safeParse(ready.body).success).toBe(true);
    expect(ready.body.checks.find((c: { name: string }) => c.name === "live_security_configuration").detail).toMatch(/DATABASE_URL.*VAANI_WEBHOOK_SECRET/);
  });

  it("never accepts demo tokens in live mode and hides the simulator", async () => {
    const token = await tokenFor("admin");
    Object.assign(process.env, LIVE_ENV);
    const res = await call(leadsRoute.GET, "GET", "/api/v1/leads", { token });
    expect(res.status).toBe(401);
    const supa = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-4000-8000-000000000001").setAudience("authenticated").setExpirationTime("1h").sign(new TextEncoder().encode(LIVE_ENV.SUPABASE_JWT_SECRET));
    const demo = await call(demoRoute.POST, "POST", "/api/v1/demo/calls", { token: supa, body: { scenario: "price_only" } });
    expect(demo.status).toBe(404);
    expect(demo.body.code).toBe("demo_unavailable");
  });
});

describe("secrets never leave the server", () => {
  it("integrations report modes and variable names only", async () => {
    process.env.GEMINI_API_KEY = "AIzaTEST-not-a-real-key-123456";
    const res = await call(integrationsRoute.GET, "GET", "/api/v1/integrations", { as: "admin" });
    expect(Integrations.safeParse(res.body).success).toBe(true);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("AIzaTEST");
    expect(text).not.toContain(process.env.VOICE_TOOL_SECRET!);
    const gemini = res.body.integrations.find((i: { provider: string }) => i.provider === "gemini");
    expect(gemini.mode).toBe("live");
    const hubspot = res.body.integrations.find((i: { provider: string }) => i.provider === "hubspot");
    expect(hubspot).toMatchObject({ mode: "mock", missing_env: ["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PIPELINE_ID", "HUBSPOT_DEALSTAGE_ID"] });
    expect((await call(integrationsRoute.GET, "GET", "/api/v1/integrations", { as: "designer" })).status).toBe(403);
  });

  it("logs redact credentials and personal data", () => {
    const out = JSON.stringify(redact({ authorization: "Bearer abc.def", note: "call +91 98765 43210 or a@b.co", nested: { api_key: "k" }, count: 3 }));
    expect(out).not.toMatch(/abc\.def|98765|a@b\.co|"k"/);
    expect(out).toContain('"count":3');
  });
});

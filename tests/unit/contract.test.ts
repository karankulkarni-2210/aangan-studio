import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApi, OPERATIONS } from "@/lib/api/openapi";
import { demoSeedSql } from "@/lib/seed/demo";
import { listScenarios, PLAN_FIXTURES } from "@/lib/simulation/scenarios";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("generated artefacts are up to date", () => {
  it("openapi.json matches the zod contract (run `npm run openapi`)", () => {
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "openapi.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
  it("supabase/seed.sql matches the demo seed module (run `npm run seed:generate`)", () => {
    expect(fs.readFileSync(path.join(ROOT, "supabase/seed.sql"), "utf8")).toBe(demoSeedSql());
  });
});

describe("frozen API boundary", () => {
  const frozen = [
    "get /api/v1/leads", "get /api/v1/leads/{id}", "patch /api/v1/leads/{id}", "post /api/v1/leads/{id}/acknowledgements",
    "post /api/v1/leads/{id}/outcomes", "get /api/v1/dashboard", "get /api/v1/policies", "post /api/v1/policies",
    "post /api/v1/policies/{id}/publish", "post /webhooks/voice/{provider}/incoming", "post /webhooks/voice/{provider}/status",
    "post /internal/voice/tools/capture-facts", "post /internal/voice/tools/evaluate-qualification", "post /internal/voice/tools/escalate-to-human",
    "post /internal/voice/tools/request-handoff", "get /api/v1/booking-slots", "post /api/v1/leads/{id}/bookings", "get /api/v1/integrations",
    "post /internal/jobs/dispatch", "post /api/v1/demo/calls", "get /health", "get /ready",
  ];
  it("every frozen endpoint exists with a route file", () => {
    const ops = new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`));
    for (const f of frozen) expect(ops.has(f), f).toBe(true);
    for (const o of OPERATIONS) {
      const file = path.join(ROOT, "src/app", o.path.replace(/\{(\w+)\}/g, "[$1]"), "route.ts");
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toMatch(new RegExp(`export const ${o.method.toUpperCase()}\\b`));
    }
  });
  it("additions beyond the frozen list are explicitly marked", () => {
    const extra = OPERATIONS.filter((o) => !frozen.includes(`${o.method} ${o.path}`));
    expect(extra.every((o) => o.addition)).toBe(true);
  });
});

describe("fixtures", () => {
  it("the five plan fixtures exist and are synthetic", () => {
    const ids = listScenarios().map((s) => s.id);
    for (const id of PLAN_FIXTURES) expect(ids).toContain(id);
    expect(listScenarios().every((s) => s.synthetic)).toBe(true);
  });
  it("fixtures are not embedded in the runtime prompt", () => {
    const prompt = fs.readFileSync(path.join(ROOT, "src/lib/ai/prompt.ts"), "utf8");
    for (const s of listScenarios()) expect(prompt).not.toContain(s.turns[0].caller);
  });
});

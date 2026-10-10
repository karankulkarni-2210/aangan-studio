import { beforeAll, describe, expect, it } from "vitest";
import * as evaluateRoute from "@/app/internal/voice/tools/evaluate-qualification/route";
import type { Db } from "@/lib/db/types";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { startCall } from "../helpers/voice";

// Nikhil's rubric (qualified.md, services.md), checked against real cases from the September 2026
// enquiry log (caller wording paraphrased from the anonymised transcripts).

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});

async function decide(...lines: string[]) {
  const c = await startCall();
  for (const l of lines) expect((await c.say(l)).status).toBe(200);
  const res = await call(evaluateRoute.POST, "POST", "/x", { body: {}, headers: c.headers });
  expect(res.status).toBe(200);
  return res.body as { decision: string; reasons: Array<{ rule_id: string; effect: string }> };
}
const failed = (r: { reasons: Array<{ rule_id: string; effect: string }> }) => r.reasons.filter((x) => x.effect === "not_fit").map((x) => x.rule_id);

describe("Nikhil's rubric on real September enquiries", () => {
  it("T19/W07: restaurants and gyms are out of scope", async () => {
    expect(failed(await decide("I'm planning to open a restaurant in Koregaon Park and want the interiors designed."))).toContain("REAL_PROJECT_IN_SCOPE");
    expect(failed(await decide("I'm opening a gym in Kothrud, about 2,500 sq ft."))).toContain("REAL_PROJECT_IN_SCOPE");
  });

  it("T03/F03: outside Pune and PCMC (Nashik, Talegaon) is declined", async () => {
    expect(failed(await decide("I'm in Nashik and want to redo my home office and study."))).toContain("IN_SERVICE_AREA");
    expect(failed(await decide("We want full home interiors for our independent house in Talegaon Dabhade."))).toContain("IN_SERVICE_AREA");
  });

  it("T10: a volunteered budget clearly below the scope is declined, without asking for one", async () => {
    expect(failed(await decide("I have a 1BHK in Kharadi and want to do the kitchen and one bedroom. My budget is 1 to 1.5 lakh maximum."))).toContain("BUDGET_NOT_CLEARLY_BELOW_SCOPE");
  });

  it("T07/F08: needing it done within three weeks is declined", async () => {
    expect(failed(await decide("I want to redo my living room and kitchen in Wakad, and it must be finished within three weeks."))).toContain("REALISTIC_TIMELINE");
  });

  it("T18: a 180 sq ft commercial pod is below the minimum scope", async () => {
    expect(failed(await decide("I run a coworking space in Baner and want a 180 sq ft pod designed."))).toContain("OFFICE_AT_LEAST_500_SQFT");
  });

  it("T01/T11: real home projects in the area, including rented flats, are not declined", async () => {
    expect((await decide("We have a 3BHK in Kothrud and want a complete redesign: kitchen, living room and both bedrooms.")).decision).not.toBe("not_fit");
    expect((await decide("I'm in a rented apartment in Baner and want to design the living room, bedroom and kitchen, no structural changes.")).decision).not.toBe("not_fit");
  });
});

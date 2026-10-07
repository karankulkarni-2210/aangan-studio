import { z } from "zod";
import { env } from "@/lib/config/env";
import { ApiError } from "@/lib/http/errors";
import { jsonResponse, route } from "@/lib/http/route";
import { runScenarioById } from "@/lib/simulation/runner";
import { listScenarios } from "@/lib/simulation/scenarios";

const liveGuard = () => {
  if (env.appMode() === "live") throw new ApiError(404, "demo_unavailable", "Simulated calls are unavailable in live mode");
};

export const GET = route({ auth: "staff", roles: ["admin", "front_desk"] }, async () => {
  liveGuard();
  return { data: listScenarios().map((s) => ({ id: s.id, title: s.title, description: s.description, expected: s.expected, synthetic: true })) };
});

export const POST = route({ auth: "staff", roles: ["admin", "front_desk"], rateLimitPerMinute: 20, maxBodyBytes: 4 * 1024 }, async ({ db, json }) => {
  liveGuard();
  const body = await json(z.object({ scenario: z.string().max(60), run_jobs: z.boolean().default(true) }).strict());
  const result = await runScenarioById(db, body.scenario, { runJobs: body.run_jobs });
  return jsonResponse(result, 201);
});

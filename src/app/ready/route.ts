import { jsonResponse, route } from "@/lib/http/route";
import { readiness } from "@/lib/services/readiness";

// Readiness: dependencies and configuration, reported as booleans and variable NAMES only.
export const GET = route({ auth: "none", allowWhenLiveIncomplete: true, rateLimitPerMinute: 120 }, async ({ db }) => {
  const r = await readiness(db);
  return jsonResponse(r, r.ready ? 200 : 503);
});

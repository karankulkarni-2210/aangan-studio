import { jsonResponse, route } from "@/lib/http/route";
import { demoSessionSchema, startDemoSession } from "@/lib/services/demo-session";

// Contract addition: evaluator sandbox sign-in (demo mode only; see the service for the limits).
export const POST = route({ auth: "none", rateLimitPerMinute: 20, maxBodyBytes: 1024 }, async ({ db, json }) =>
  jsonResponse(await startDemoSession(db, await json(demoSessionSchema)), 201),
);

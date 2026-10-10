import { z } from "zod";
import { jsonResponse, route } from "@/lib/http/route";
import { appendOutcome, outcomeBodySchema } from "@/lib/services/outcomes";

export const POST = route({ auth: "staff", rateLimitPerMinute: 60, maxBodyBytes: 8 * 1024, sandbox: "simulated_lead" }, async ({ db, staff, params, json, req, requestId }) => {
  const body = await json(outcomeBodySchema);
  const key = req.headers.get("idempotency-key");
  const result = await appendOutcome(db, staff!, z.string().uuid().parse(params.id), body, key && key.length <= 100 ? key : null, requestId);
  return jsonResponse(result, result.replay ? 200 : 201);
});

import { z } from "zod";
import { jsonResponse, route } from "@/lib/http/route";
import { acknowledgeLead } from "@/lib/services/handoffs";

// Idempotent: repeating the request returns the existing acknowledgement (200) instead of a new one.
export const POST = route({ auth: "staff", rateLimitPerMinute: 60, maxBodyBytes: 4 * 1024 }, async ({ db, staff, params, requestId }) => {
  const result = await acknowledgeLead(db, staff!, z.string().uuid().parse(params.id), requestId);
  return jsonResponse(result, result.already_acknowledged ? 200 : 201);
});

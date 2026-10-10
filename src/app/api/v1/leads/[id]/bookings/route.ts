import { z } from "zod";
import { jsonResponse, route } from "@/lib/http/route";
import { bookingBodySchema, createBooking } from "@/lib/services/bookings";

// Staff JWT, or the voice service bound to the current call (X-Aangan-Call-Id/Token).
export const POST = route({ auth: "staff_or_voice", roles: ["admin", "front_desk", "designer"], rateLimitPerMinute: 30, maxBodyBytes: 8 * 1024, sandbox: "simulated_lead" }, async (ctx) => {
  const body = await ctx.json(bookingBodySchema);
  const result = await createBooking(ctx.db, { staff: ctx.staff, voice: ctx.voice }, z.string().uuid().parse(ctx.params.id), body, ctx.requestId);
  return jsonResponse(result.body, result.status);
});

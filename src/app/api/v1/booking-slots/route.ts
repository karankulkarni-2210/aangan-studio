import { assertSandboxLead, route } from "@/lib/http/route";
import { listSlots, slotsQuerySchema } from "@/lib/services/bookings";

export const GET = route({ auth: "staff_or_voice", rateLimitPerMinute: 60 }, async (ctx) => {
  const q = ctx.query(slotsQuerySchema);
  // Sandbox sessions see slots only for a simulated lead (mock calendar), never live availability.
  await assertSandboxLead(ctx.db, ctx.staff, q.lead_id);
  return listSlots(ctx.db, { staff: ctx.staff, voice: ctx.voice }, q);
});

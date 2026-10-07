import { route } from "@/lib/http/route";
import { listSlots, slotsQuerySchema } from "@/lib/services/bookings";

export const GET = route({ auth: "staff_or_voice", rateLimitPerMinute: 60 }, async (ctx) => listSlots(ctx.db, { staff: ctx.staff, voice: ctx.voice }, ctx.query(slotsQuerySchema)));

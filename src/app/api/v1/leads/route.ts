import { route } from "@/lib/http/route";
import { listLeads, listQuerySchema } from "@/lib/services/leads";

export const GET = route({ auth: "staff", rateLimitPerMinute: 300 }, async ({ db, staff, query }) => listLeads(db, staff!, query(listQuerySchema)));

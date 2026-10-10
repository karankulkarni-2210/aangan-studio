import { route } from "@/lib/http/route";
import { listLeads, listQuerySchema } from "@/lib/services/leads";

export const GET = route({ auth: "staff", rateLimitPerMinute: 300 }, async ({ db, staff, query }) => {
  const q = query(listQuerySchema);
  // The evaluator sandbox only ever lists simulated leads.
  return listLeads(db, staff!, staff!.sandbox ? { ...q, simulated: "true" } : q);
});

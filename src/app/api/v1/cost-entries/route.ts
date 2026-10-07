import { jsonResponse, route } from "@/lib/http/route";
import { costEntrySchema, recordInvoice } from "@/lib/services/cost-entries";

// Contract addition: administrators record invoiced costs so the dashboard can reconcile estimates.
export const POST = route({ auth: "staff", roles: ["admin"], rateLimitPerMinute: 30, maxBodyBytes: 8 * 1024 }, async ({ db, staff, json, requestId }) =>
  jsonResponse(await recordInvoice(db, staff!, await json(costEntrySchema), requestId), 201),
);

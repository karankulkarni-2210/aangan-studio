import { route } from "@/lib/http/route";
import { computeDashboard, dashboardQuerySchema } from "@/lib/services/dashboard";

// Costs are returned to administrators only (front desk sees operations metrics).
export const GET = route({ auth: "staff", roles: ["admin", "front_desk"], rateLimitPerMinute: 60 }, async ({ db, staff, query }) => {
  const q = query(dashboardQuerySchema);
  // The evaluator sandbox only ever sees simulated activity.
  return computeDashboard(db, staff!, staff!.sandbox ? { ...q, data: "simulated" } : q);
});

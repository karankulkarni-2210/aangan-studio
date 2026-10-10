import { route } from "@/lib/http/route";
import { listStaff } from "@/lib/services/directory";

// Contract addition: the roster for assigning designers and reviewing handoff recipients.
export const GET = route({ auth: "staff", roles: ["admin", "front_desk"], rateLimitPerMinute: 60 }, async ({ db, staff }) => listStaff(db, staff!));

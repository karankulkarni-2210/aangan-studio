import { route } from "@/lib/http/route";
import { integrationStatus } from "@/lib/services/integrations";

export const GET = route({ auth: "staff", roles: ["admin", "front_desk"], rateLimitPerMinute: 60 }, async ({ db }) => integrationStatus(db));

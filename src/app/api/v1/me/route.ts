import { env } from "@/lib/config/env";
import { route } from "@/lib/http/route";

// Contract addition: lets the frontend render role-appropriate screens and restricted states.
export const GET = route({ auth: "staff", rateLimitPerMinute: 120 }, async ({ staff }) => ({
  id: staff!.id,
  role: staff!.role,
  display_name: staff!.display_name,
  email: staff!.email,
  app_mode: env.appMode(),
}));

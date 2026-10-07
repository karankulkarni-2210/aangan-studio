import { env } from "@/lib/config/env";
import { route } from "@/lib/http/route";

// Liveness only: no dependency checks, no configuration details.
export const GET = route({ auth: "none", allowWhenLiveIncomplete: true }, async () => ({ status: "ok", app_mode: env.appMode() }));

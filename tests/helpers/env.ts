import { randomBytes } from "node:crypto";

// Tests never touch live providers: every provider credential is removed and demo mode is forced.
const PROVIDER_VARS = [
  "GEMINI_API_KEY", "CALCOM_API_KEY", "CALCOM_EVENT_TYPE_ID", "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PIPELINE_ID", "HUBSPOT_DEALSTAGE_ID",
  "RESEND_API_KEY", "RESEND_FROM", "VAANI_API_KEY", "VAANI_WEBHOOK_SECRET", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_JWT_SECRET", "CRON_SECRET",
  // Alias names from the studio's setup notes, and the pilot email redirect.
  "CAL_API_KEY", "CAL_EVENT_TYPE_ID", "HUBSPOT_QUALIFIED_STAGE_ID", "RESEND_FROM_EMAIL", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "DESIGNER_HANDOFF_EMAIL",
];

export function configureTestEnv(): void {
  for (const k of PROVIDER_VARS) delete process.env[k];
  process.env.APP_MODE = "demo";
  process.env.LOG_LEVEL = "silent";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DEMO_JWT_SECRET = randomBytes(32).toString("hex");
  process.env.VOICE_TOOL_SECRET = randomBytes(32).toString("hex");
  process.env.DISPATCH_SECRET = randomBytes(32).toString("hex");
  process.env.SIMULATED_VOICE_WEBHOOK_SECRET = randomBytes(32).toString("hex");
}

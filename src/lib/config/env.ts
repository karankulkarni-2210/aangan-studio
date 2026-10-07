import type { IntegrationMode, IntegrationProvider } from "@/lib/domain/enums";

// Environment is read on every call (cheap) so tests and scripts can change it at runtime.
// Secret VALUES never leave this module except to the code that needs them; readiness and
// integration endpoints only report variable NAMES and booleans.

export type AppMode = "demo" | "live";

const v = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
};

export const env = {
  appMode(): AppMode {
    return v("APP_MODE") === "live" ? "live" : "demo";
  },
  appBaseUrl: () => v("APP_BASE_URL") ?? "http://localhost:3000",
  leadUrlTemplate: () => v("LEAD_URL_TEMPLATE") ?? `${env.appBaseUrl()}/leads/{lead_id}`,
  databaseUrl: () => v("DATABASE_URL"),
  databaseSsl: () => v("DATABASE_SSL") === "true",
  databasePoolMax: () => Number(v("DATABASE_POOL_MAX") ?? 3),
  supabaseUrl: () => v("SUPABASE_URL"),
  supabaseJwtSecret: () => v("SUPABASE_JWT_SECRET"),
  /** Demo-mode only. Locally generated (npm run demo:secret); ignored entirely in live mode. */
  demoJwtSecret: () => (env.appMode() === "demo" ? v("DEMO_JWT_SECRET") : undefined),
  voiceToolSecret: () => v("VOICE_TOOL_SECRET"),
  dispatchSecret: () => v("DISPATCH_SECRET") ?? v("CRON_SECRET"),
  vaaniWebhookSecret: () => v("VAANI_WEBHOOK_SECRET"),
  simulatedWebhookSecret: () => v("SIMULATED_VOICE_WEBHOOK_SECRET"),
  vaani: () => ({ apiKey: v("VAANI_API_KEY"), baseUrl: v("VAANI_API_BASE_URL") ?? "https://www.vaanilabs.in", flowId: v("VAANI_FLOW_ID") }),
  gemini: () => ({ apiKey: v("GEMINI_API_KEY"), model: v("GEMINI_MODEL") ?? "gemini-3.8-flash", timeoutMs: Number(v("GEMINI_TIMEOUT_MS") ?? 8000) }),
  calcom: () => ({
    apiKey: v("CALCOM_API_KEY"),
    eventTypeId: v("CALCOM_EVENT_TYPE_ID"),
    baseUrl: v("CALCOM_API_BASE_URL") ?? "https://api.cal.com",
  }),
  hubspot: () => ({
    accessToken: v("HUBSPOT_ACCESS_TOKEN"),
    pipelineId: v("HUBSPOT_PIPELINE_ID"),
    dealStageId: v("HUBSPOT_DEALSTAGE_ID"),
    leadIdProperty: v("HUBSPOT_LEAD_ID_PROPERTY") ?? "aangan_lead_id",
    baseUrl: v("HUBSPOT_API_BASE_URL") ?? "https://api.hubapi.com",
  }),
  resend: () => ({ apiKey: v("RESEND_API_KEY"), from: v("RESEND_FROM"), baseUrl: v("RESEND_API_BASE_URL") ?? "https://api.resend.com" }),
};

/** Variables that must be present for each integration to run live. Names only. */
export const INTEGRATION_ENV: Record<IntegrationProvider, string[]> = {
  vaani: ["VAANI_API_KEY", "VAANI_WEBHOOK_SECRET"],
  gemini: ["GEMINI_API_KEY"],
  calcom: ["CALCOM_API_KEY", "CALCOM_EVENT_TYPE_ID"],
  hubspot: ["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PIPELINE_ID", "HUBSPOT_DEALSTAGE_ID"],
  resend: ["RESEND_API_KEY", "RESEND_FROM"],
  supabase: ["DATABASE_URL", "SUPABASE_URL"],
};

export function missingEnv(names: string[]): string[] {
  return names.filter((n) => !v(n));
}

/**
 * Credentials present -> live. Missing in demo mode -> explicit mock. Missing in live mode ->
 * not_configured: work for that integration fails visibly instead of pretending to succeed.
 */
export function integrationMode(provider: IntegrationProvider): IntegrationMode {
  if (provider === "supabase" && v("DATABASE_URL")?.startsWith("pglite:")) return env.appMode() === "demo" ? "mock" : "not_configured";
  if (missingEnv(INTEGRATION_ENV[provider]).length === 0) return "live";
  return env.appMode() === "demo" ? "mock" : "not_configured";
}

/** Security configuration that live mode requires before serving anything but /health. */
export function liveSecurityGaps(): string[] {
  const gaps: string[] = [];
  if (!v("DATABASE_URL") || v("DATABASE_URL")!.startsWith("pglite:")) gaps.push("DATABASE_URL (Supabase Postgres)");
  if (!v("SUPABASE_URL") && !v("SUPABASE_JWT_SECRET")) gaps.push("SUPABASE_URL (JWKS) or SUPABASE_JWT_SECRET");
  if (!v("VOICE_TOOL_SECRET") || (v("VOICE_TOOL_SECRET")?.length ?? 0) < 32) gaps.push("VOICE_TOOL_SECRET (>= 32 chars)");
  if (!env.dispatchSecret() || (env.dispatchSecret()?.length ?? 0) < 32) gaps.push("DISPATCH_SECRET or CRON_SECRET (>= 32 chars)");
  if (!v("VAANI_WEBHOOK_SECRET")) gaps.push("VAANI_WEBHOOK_SECRET");
  if (!v("APP_BASE_URL")?.startsWith("https://")) gaps.push("APP_BASE_URL (https)");
  return gaps;
}

export function isLiveAndIncomplete(): boolean {
  return env.appMode() === "live" && liveSecurityGaps().length > 0;
}

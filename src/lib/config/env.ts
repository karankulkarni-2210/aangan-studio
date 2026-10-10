import type { IntegrationMode, IntegrationProvider } from "@/lib/domain/enums";

// Environment is read on every call (cheap) so tests and scripts can change it at runtime.
// Secret VALUES never leave this module except to the code that needs them; readiness and
// integration endpoints only report variable NAMES and booleans.

export type AppMode = "demo" | "live";

/**
 * Accepted alternative names (e.g. the names used in the studio's setup notes). The canonical name
 * wins when both are set; readiness and integration reports always use canonical names.
 */
export const ENV_ALIASES: Record<string, string[]> = {
  APP_BASE_URL: ["NEXT_PUBLIC_APP_URL"],
  SUPABASE_URL: ["NEXT_PUBLIC_SUPABASE_URL"],
  CALCOM_API_KEY: ["CAL_API_KEY"],
  CALCOM_EVENT_TYPE_ID: ["CAL_EVENT_TYPE_ID"],
  HUBSPOT_DEALSTAGE_ID: ["HUBSPOT_QUALIFIED_STAGE_ID"],
  RESEND_FROM: ["RESEND_FROM_EMAIL"],
};

const raw = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "") : undefined;
};

const v = (name: string): string | undefined => {
  for (const n of [name, ...(ENV_ALIASES[name] ?? [])]) {
    const value = raw(n);
    if (value) return value;
  }
  return undefined;
};

/** Accepts a numeric id or a Cal.com event-type URL (…/event-types/7421657?…). */
export function parseCalEventTypeId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return value;
  return /\/event-types\/(\d+)/.exec(value)?.[1];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  /** Vaani AI (app.vaanivoice.ai): REST with X-API-Key; BYOL WebSocket bridge authenticated by VAANI_BYOL_TOKEN. */
  vaani: () => ({ apiKey: v("VAANI_API_KEY"), baseUrl: v("VAANI_API_BASE_URL") ?? "https://api.vaanivoice.ai", byolToken: v("VAANI_BYOL_TOKEN") }),
  gemini: () => ({
    apiKey: v("GEMINI_API_KEY"),
    model: v("GEMINI_MODEL") ?? "gemini-3.8-flash",
    timeoutMs: Number(v("GEMINI_TIMEOUT_MS") ?? 8000),
    // Voice turns are latency-sensitive. "LOW" verified on gemini-3.8-flash (2026-10-10, ~4 s per turn);
    // "MINIMAL" is rejected by that model (HTTP 400).
    thinkingLevel: (v("GEMINI_THINKING_LEVEL") ?? "LOW").toUpperCase(),
  }),
  calcom: () => ({
    apiKey: v("CALCOM_API_KEY"),
    eventTypeId: parseCalEventTypeId(v("CALCOM_EVENT_TYPE_ID")),
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
  /**
   * Pilot redirect: when set, every LIVE handoff email goes to this one address (the intended
   * roster recipient is stated in the email). Needed with Resend's onboarding@resend.dev sender,
   * which only delivers to the Resend account owner. Simulated leads are unaffected (mock email).
   */
  handoffRedirectEmail: () => {
    const value = v("DESIGNER_HANDOFF_EMAIL")?.toLowerCase();
    return value && EMAIL.test(value) ? value : undefined;
  },
};

/** Variables that must be present for each integration to run live. Names only. */
export const INTEGRATION_ENV: Record<IntegrationProvider, string[]> = {
  vaani: ["VAANI_API_KEY", "VAANI_WEBHOOK_SECRET", "VAANI_BYOL_TOKEN"],
  gemini: ["GEMINI_API_KEY"],
  calcom: ["CALCOM_API_KEY", "CALCOM_EVENT_TYPE_ID"],
  hubspot: ["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PIPELINE_ID", "HUBSPOT_DEALSTAGE_ID"],
  resend: ["RESEND_API_KEY", "RESEND_FROM"],
  supabase: ["DATABASE_URL", "SUPABASE_URL"],
};

export function missingEnv(names: string[]): string[] {
  return names.filter((n) => (n === "CALCOM_EVENT_TYPE_ID" ? !env.calcom().eventTypeId : !v(n)));
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
  if (!v("VAANI_WEBHOOK_SECRET") || (v("VAANI_WEBHOOK_SECRET")?.length ?? 0) < 32) gaps.push("VAANI_WEBHOOK_SECRET (>= 32 chars)");
  if (!v("APP_BASE_URL")?.startsWith("https://")) gaps.push("APP_BASE_URL (https)");
  return gaps;
}

export function isLiveAndIncomplete(): boolean {
  return env.appMode() === "live" && liveSecurityGaps().length > 0;
}

import { env, INTEGRATION_ENV, integrationMode, missingEnv } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from "@/lib/domain/enums";

// Integration panel data: live/mock/not_configured mode, the NAMES of missing variables, verified
// contract notes and recent health. Secret values are never read into this response.

const NOTES: Record<IntegrationProvider, { verified: string; capability: string; gaps: string[] }> = {
  vaani: {
    verified: "Docs checked 2026-10-07 (OpenAPI v1): browser voice sessions; webhooks call.completed/call.failed/usage.charged with X-VaaniVoice-Signature HMAC.",
    capability: "Voice conversation (Vaani-owned audio). Webhook verification and event dedupe implemented.",
    gaps: [
      "No documented server-side tool calling: the business tools are exercised by the simulated provider.",
      "No documented inbound telephony / number routing; phone answering is not live.",
      "Webhook `data` shape undocumented: unmappable events are stored and marked failed, not guessed.",
    ],
  },
  gemini: {
    verified: "Docs checked 2026-10-07: generateContent + responseJsonSchema; default model gemini-3.8-flash (configurable).",
    capability: "Intent, fact extraction with quotes, proposed route. Server validates and re-parses every value.",
    gaps: ["Structured-output field names should be re-verified with a live key; Google now recommends the Interactions API."],
  },
  calcom: {
    verified: "Docs checked 2026-10-07: slots 2024-09-04, create 2026-02-25, list 2026-05-01 cal-api-version headers.",
    capability: "Availability, caller-confirmed booking, timeout reconciliation by booking key in metadata.",
    gaps: ["No booking idempotency key in Cal.com; reconciliation lists bookings by time window and metadata.", "Unavailable-slot error shape to verify on the account."],
  },
  hubspot: {
    verified: "Docs checked 2026-10-07: v3 objects (still supported), batch upsert on a unique property.",
    capability: "Contact match/create; one open deal per lead via unique aangan_lead_id upsert; default deal-contact association.",
    gaps: ["Requires the unique deal property and pipeline/stage IDs.", "Contact search is eventually consistent; a timed-out contact create may rarely duplicate."],
  },
  resend: {
    verified: "Docs checked 2026-10-07: POST /emails, Idempotency-Key (24h), User-Agent required.",
    capability: "Designer/front-desk handoff email with authenticated lead link.",
    gaps: ["Exactly-once delivery is not claimed beyond the 24-hour idempotency window."],
  },
  supabase: {
    verified: "Postgres + Auth (JWKS ES256/RS256 or legacy HS256), RLS, transaction-pooler compatible queries.",
    capability: "Leads, calls, evidence, outbox jobs, usage ledger, audit.",
    gaps: ["Dispatcher schedule must be configured (pg_cron + pg_net, or Vercel Pro cron)."],
  },
};

export async function integrationStatus(db: Db) {
  const health = await db.query(`
    select 'resend' as provider, max(sent_at) as last_success_at,
           max(updated_at) filter (where delivery_status = 'failed') as last_error_at,
           count(*) filter (where delivery_status in ('queued', 'sending'))::int as pending,
           count(*) filter (where delivery_status = 'failed')::int as failed,
           count(*) filter (where delivery_mode = 'mock')::int as simulated
      from public.handoffs
    union all
    select 'hubspot', max(succeeded_at), max(last_attempt_at) filter (where status in ('failed', 'ambiguous')),
           count(*) filter (where status = 'pending')::int, count(*) filter (where status in ('failed', 'ambiguous'))::int,
           count(*) filter (where mode = 'mock')::int
      from public.integration_syncs where provider = 'hubspot'
    union all
    select 'calcom', max(updated_at) filter (where status = 'confirmed'), max(updated_at) filter (where status in ('failed', 'pending_reconciliation')),
           count(*) filter (where status in ('requested', 'pending_reconciliation'))::int, count(*) filter (where status = 'failed')::int,
           count(*) filter (where mode = 'mock')::int
      from public.bookings
    union all
    select 'vaani', max(received_at) filter (where processing_status = 'processed'), max(received_at) filter (where processing_status = 'failed'),
           0, count(*) filter (where processing_status = 'failed')::int, count(*) filter (where provider = 'simulated')::int
      from public.provider_events
    union all
    select 'gemini', max(occurred_at), null, 0, 0, count(*) filter (where is_simulated)::int
      from public.usage_events where provider = 'gemini'`);
  const { rows: jobs } = await db.query(`select kind, status, count(*)::int as n, max(last_error) as last_error from public.outbox_jobs group by kind, status`);
  const byProvider = new Map(health.rows.map((r) => [r.provider, r]));
  return {
    app_mode: env.appMode(),
    simulated_leads_use_mocks: true,
    integrations: INTEGRATION_PROVIDERS.map((p) => {
      const h = byProvider.get(p);
      return {
        provider: p,
        mode: p === "supabase" && !env.databaseUrl() ? "mock" : integrationMode(p),
        missing_env: missingEnv(INTEGRATION_ENV[p]),
        ...NOTES[p],
        health: h
          ? {
              last_success_at: h.last_success_at ? new Date(h.last_success_at).toISOString() : null,
              last_error_at: h.last_error_at ? new Date(h.last_error_at).toISOString() : null,
              pending: h.pending,
              failed: h.failed,
              simulated_records: h.simulated,
            }
          : null,
      };
    }),
    jobs: jobs.map((j) => ({ kind: j.kind, status: j.status, count: j.n, last_error: j.status === "dead" ? j.last_error : null })),
  };
}

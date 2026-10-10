# Provider adapters

All adapters follow the same rules:
- **Credentials present:** the adapter runs live.
- **Credentials missing in demo mode:** an explicit **mock** is used (ids prefixed `sim_`, records labelled simulated).
- **Credentials missing in live mode:** the adapter is `not_configured`, so work fails visibly instead of being faked.
- **Simulated leads always use mocks,** even when live credentials exist, so a demo can never create a real booking, CRM record or email.

`GET /api/v1/integrations` shows each provider's mode, the **names** of missing variables, verified-contract notes, known gaps and recent health. Secret values are never returned.

Official documentation was checked on **2026-10-07**. Adapter tests (`tests/unit/adapters.test.ts`) exercise request shapes and error mapping against a stubbed `fetch`. **No live call, email, booking or CRM write has been made.**

| Provider | Env vars (live) | Adapter | Mock |
|---|---|---|---|
| Vaani Labs | `VAANI_API_KEY`, `VAANI_WEBHOOK_SECRET` (+ `VAANI_FLOW_ID`, `VAANI_API_BASE_URL`) | `src/lib/providers/vaani.ts` | `simulated` voice provider (`/webhooks/voice/simulated/*`, demo mode only) |
| Gemini Flash | `GEMINI_API_KEY` (+ `GEMINI_MODEL`, default `gemini-3.8-flash`; `GEMINI_TIMEOUT_MS`) | `src/lib/ai/gemini.ts` | Recorded fixtures (simulated calls) or the heuristic extractor |
| Cal.com | `CALCOM_API_KEY`, `CALCOM_EVENT_TYPE_ID` (+ `CALCOM_API_BASE_URL`) | `src/lib/providers/calcom.ts` | `createMockCalendar`: Mon–Sat 11:00 / 14:30 / 17:00 IST |
| HubSpot | `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PIPELINE_ID`, `HUBSPOT_DEALSTAGE_ID` (+ `HUBSPOT_LEAD_ID_PROPERTY`) | `src/lib/providers/hubspot.ts` | `createMockCrm` |
| Resend | `RESEND_API_KEY`, `RESEND_FROM` (+ `DESIGNER_HANDOFF_EMAIL` pilot redirect) | `src/lib/providers/resend.ts` | `createMockEmail` (stores the preview) |
| Supabase | `DATABASE_URL`, `SUPABASE_URL` and/or `SUPABASE_JWT_SECRET` | `src/lib/db/postgres.ts`, `src/lib/auth/tokens.ts` | `DATABASE_URL=pglite:<dir>` embedded Postgres (demo only) |

Alias names are also accepted, so the studio's setup notes work unchanged: `CAL_API_KEY`, `CAL_EVENT_TYPE_ID` (numeric id or event-type URL), `HUBSPOT_QUALIFIED_STAGE_ID`, `RESEND_FROM_EMAIL`, `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SUPABASE_URL`. The canonical name wins if both are set.

## Vaani Labs (voice)

**Verified** from vaanilabs.in/docs and the OpenAPI v1 spec:
- Base URL `https://www.vaanilabs.in`, auth `Authorization: Bearer vv_live_…`.
- `POST /api/public/v1/voicebot/session` returns a short-lived browser WebSocket session. Agents and flows are configured in the dashboard.
- **Webhooks:** `call.completed`, `call.failed`, `meeting.ended`, `lead.created`, `usage.charged`.
  - Envelope: `{ id: "evt_…", type, created, data }`.
  - Signature: `X-VaaniVoice-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`.
  - Retries: up to 8 attempts.
- **Pricing:** voicebot 4 paise/second, billed per started minute.

**Not documented, so not assumed:**
- Server-side tool or function calling during a conversation.
- Inbound telephony and number routing.
- Transcript retrieval.
- The shape of webhook `data`.

**Implemented:**
- Signature verification and event-id dedupe.
- A 24 h `created` age window, because Vaani signs no timestamp.
- The voicebot session helper.
- A normalised event contract (`voiceEventSchema`). Vaani events that do not map onto it are stored redacted, marked `failed` and answered 202, never guessed at.

**Gap: the live voice-to-tool loop.** The business tools (`/internal/voice/tools/*`) work and are exercised by the simulated provider. Connecting them to real calls needs either Vaani tool-call support on the account or a bridge, plus proven inbound routing. Until then the product is a **simulated** phone-enquiry MVP.

## Gemini Flash (classification and extraction)

**Verified** from ai.google.dev:
- `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with header `x-goog-api-key`.
- `generationConfig.responseMimeType: "application/json"` plus `responseJsonSchema`.
- `thinkingConfig.thinkingLevel` for Gemini 3+.
- `usageMetadata.promptTokenCount / candidatesTokenCount / thoughtsTokenCount`.
- `gemini-3.8-flash` is the newest stable Flash. Introductory paid price: $0.75 input / $3.75 output per 1M tokens, until 2026-12-31. Thinking tokens are billed as output.

Google now recommends the Interactions API for new work, but `generateContent` remains supported. The status of `responseJsonSchema` vs `responseFormat` is ambiguous in the reference, so **re-verify with a real key**.

**Implemented:**
- The system instruction treats the transcript as untrusted data.
- The schema comes from the zod contract, and output is zod-validated.
- Timeout (8 s). On any failure the heuristic extractor runs and the run is flagged `degraded`.
- Token usage goes to the ledger.
- Valid structure is never treated as truth: every fact is re-checked against the quoted caller words.

## Cal.com (consultations)

**Verified:** each endpoint needs its own `cal-api-version`; a wrong value silently selects an older endpoint version.
- `GET /v2/slots`: `2024-09-04`.
- `POST /v2/bookings`: `2026-02-25`. The attendee needs `name` and `timeZone`; `email` is optional in the schema.
- `GET /v2/bookings`: `2026-05-01`. Cursor pagination; filters `attendeeEmail`, `attendeeName`, `afterStart`, `beforeEnd`, `eventTypeId`.
- **No idempotency key** for bookings.

**Implemented:**
- Availability, then caller confirmation, then an availability re-check, then create.
- Only `status: accepted` with a `uid` counts as confirmed.
- A 400 with an unavailable-slot error is a conflict.
- A timeout or 5xx is **ambiguous**: the booking becomes `pending_reconciliation`, and a reconcile job lists bookings in the window and matches `metadata.aangan_booking_key`. It never re-creates.

**Verify on the account:**
- The unavailable-slot error shape.
- Whether bookings without an email are accepted at runtime.
- That the event type does **not** require host confirmation.
- Whether to hold slots with `POST /v2/slots/reservations` during the read-back.

## HubSpot (CRM)

**Verified:**
- Legacy v3 object paths are still supported (date-versioned `2026-09` paths also exist).
- Search: 5 requests/s and eventually consistent.
- Deal→contact association type 3.
- Idempotent writes via `batch/upsert` on a **unique** custom property.

**Implemented:**
- **Contact:** search by email, then phone; create if none. A 409 "Existing ID" is recovered.
- **Deal:** `POST /crm/v3/objects/deals/batch/upsert` with `idProperty = aangan_lead_id` gives one open deal per lead, even across retries and timeouts.
- **Association:** `PUT /crm/v4/objects/deals/{id}/associations/default/contacts/{id}`.
- Remote ids are stored per object in `integration_syncs`.
- Won/lost stays in our outcome history, separate from qualification.

**Setup:** create the deal property `aangan_lead_id` (`type: string`, `hasUniqueValue: true`) and supply the pipeline and stage internal ids.

**Limitation:** a contact create that times out can, rarely, duplicate a contact, because search is eventually consistent.

## Resend (designer handoff)

**Verified:**
- `POST https://api.resend.com/emails` with `Authorization: Bearer re_…`.
- The **`User-Agent` header is required.**
- `Idempotency-Key` (1–256 chars) is kept for 24 h.
- `409 concurrent_idempotent_requests` is transient; `409 invalid_idempotent_request` means the payload changed.
- Rate limit: 10 requests per second per team.

**Implemented:**
- Idempotency key `handoff/{handoff_id}` plus local dedupe (one handoff per lead and purpose).
- A deterministic summary built from structured fields only, with an authenticated lead link and a masked phone number.
- Recipients come from the approved roster or the policy queue and are re-validated at send time.
- Bounded retries; a final failure becomes a visible `integration_failure` task.

**Limitation:** exactly-once delivery is not claimed outside the 24 h idempotency window.

## Supabase and Vercel

- **JWT verification:**
  - JWKS (`/auth/v1/.well-known/jwks.json`, ES256/RS256), or the legacy HS256 secret.
  - Anonymous sessions are rejected.
  - Roles come from `public.staff`.
- **Connection:** use the transaction pooler (port 6543, `DATABASE_SSL=true`) on Vercel. Queries use no named or prepared statements and only `SET LOCAL` inside transactions, so they are pooler-compatible.
- **Dispatcher schedule:**
  - Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`.
  - Hobby allows at most one run per day, so `vercel.json` ships a daily backstop.
  - For per-minute dispatch, use Supabase Cron with pg_net and Vault (`supabase/cron.sql.example`) or Vercel Pro.

## Live verification checklist (requires explicit user authorisation)

Run each item only with your own accounts and your consent. Each one creates real external effects.

1. **Gemini:** a single extraction on a synthetic transcript with `APP_MODE=demo` and a non-simulated test call. Record latency and token usage.
2. **Cal.com:** create one test booking on a test event type, then cancel it in Cal.com. Also check what a conflict returns.
3. **HubSpot:** in a sandbox or test portal, create the unique property, then run `crm.sync` for one test lead twice and confirm a single deal.
4. **Resend:** send one handoff to your own verified address and confirm idempotent re-send behaviour.
5. **Vaani:** register a webhook on a test endpoint and capture a real `call.completed` payload. Map it onto `voiceEventSchema` and confirm whether tool calls or telephony exist on the account.
6. **Supabase:** apply migrations to a new project, link staff to Auth users and run `/ready`.

Record measured latency, API versions and integration status in the integrations panel and in this document.

Never alter studio phone routing, push to a remote or deploy without explicit approval.

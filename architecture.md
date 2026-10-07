# Aangan Studio phone-enquiry backend: architecture

Status: simulated phone-enquiry MVP. **Demo data and sample business rules.** Simulated calls are not live phone answering.

Source material: MESA Case 03 ("Nikhil: Unanswered Enquiries"), `aangan-build-plan.md` and `claude-backend-prompts.md`. Codex owns product architecture, screen design, the API contract and acceptance criteria. This repository is the backend that Claude Code built against that contract.

## 1. The Nine Checks

The checks are grouped as follows:
- **Kill Switches (01–03):** a No stops the build.
- **Sizing (04, 05, 08):** a No reduces scope.
- **Boundary (06, 07, 09):** a No puts a human at that point.

Case units are preserved:
- About 200 enquiries a month **across all channels**, not phone calls.
- 48% × ~200 ≈ **96 unanswered enquiries**.
- Project values of **₹8–14 lakh**.
- The 4× figure is an **observed** relationship in Nikhil's numbers, not a proven causal lift.

| Check | Group | Evidence from the case | Decision and effect in this build |
|---|---|---|---|
| **01 Problem real?** | Kill Switch | YES. About 48% of ~200 monthly all-channel enquiries (≈96) get no response within 48 h. A third arrive outside 10am–7pm. Enquiries answered within an hour convert at 4× the next-day rate (observed, not causal). | Build. Every simulated call gets an immediate spoken response and a saved lead. The dashboard measures response within 300 s; no causal lift is claimed. |
| **02 Workflow repeated?** | Kill Switch | YES. ~200 enquiries a month; first response, discovery, qualification and handoff repeat for each. The figure is all-channel; phone volume is unknown. | Automate the repeated intake steps for incoming phone calls only (WhatsApp/web are out of scope). Calls and unique leads are counted separately. |
| **03 Input available?** | Kill Switch | YES for a demo, PARTLY for studio operation. `services.md`, `qualified.md` and transcripts are referenced but not supplied. `pricing.md` is "indicative only". | Seeded, versioned, editable **sample** policy (`config/policy.demo.json`) and eight synthetic scenarios. No business files block the MVP. Pricing data is excluded from the policy schema. |
| **04 Output valuable?** | Sizing | YES. A fast acknowledgement, a complete designer note and a confirmed consultation advance a ₹8–14 lakh project. | Deliver a saved lead with evidence, a deterministic decision, a confirmed booking, a CRM deal and an email handoff. A booking is a funnel event, not revenue. |
| **05 Impact measurable?** | Sizing | YES. Response time, five-minute compliance, consultations, handoff/acknowledgement latency and outcomes can be recorded. | Instrumented from the first call. Simulated data is labelled and filterable (`?data=live`). A phone-specific baseline is needed before claiming improvement. |
| **06 Failure risk OK?** | Boundary | YES with review/fallback for answering and qualification. **NO for autonomous pricing**: a voice quote may be heard as a commitment. | **The Cut** (below). Uncertain facts, failed integrations and missing policy route to humans. Failures are visible tasks, never silent. |
| **07 Judgment protected?** | Boundary | PARTLY. Answering and qualification can be assisted. Quotes, contractual/project promises and complaints need human judgment. | The agent answers, discovers, qualifies (by rules) and books provider-confirmed slots. Pricing, commitments, complaints and uncertain cases become human tasks. |
| **08 ROI worth it?** | Sizing | Promising, not established. ≈96 unanswered enquiries is all-channel. Phone share, incremental wins, margin and actual tool cost are unknown. | Keep the MVP small. Show operating cost, cost per qualified lead (null when zero) and confirmed contract value separately from revenue. No ROI is inferred. |
| **09 Owner clear?** | Boundary | YES once roles are explicit. | Designer owns the relationship and accepts handoffs. Nikhil (admin) owns pricing and policy publication. Front desk owns exceptions and pending tasks. The project builder owns technical monitoring until an operator is assigned. |

**The Cut: all autonomous customer-facing pricing.** The system never speaks or automatically sends rates, ranges, totals, discounts, tax treatment or project dates, even with an "indicative" disclaimer. It is enforced in five places:
1. The policy schema has no field that can hold pricing. Unknown keys are rejected.
2. Policy validation runs every caller-facing script through the pricing/commitment guard (`src/lib/domain/speech-guard.ts`), so a disclaimer cannot make a price publishable.
3. Every voice-tool response is guard-checked before it leaves the server. A violation returns 500 instead of the text.
4. Gemini only classifies and extracts. It never writes caller-facing text.
5. Agent utterances in transcripts are monitored. A match opens an `agent_price_utterance` admin task.

There is no internal price worksheet in this MVP. If one is added later, it must be human-only, kept outside the voice context and never delivered automatically.

## 2. Architecture

```text
Build time:   Codex (architecture, contract, review) → Claude Chat policy → Claude Code → GitHub

Runtime:      Incoming call ─► Vaani Labs voice session (audio, turn-taking)
                               │  signed webhooks             ▲ approved scripts only
                               ▼                              │
              Next.js route handlers on Vercel ───────────────┘
                ├─ /webhooks/voice/{provider}/incoming|status   (HMAC, dedupe, monotonic state)
                ├─ /internal/voice/tools/*                      (service secret + per-call token)
                │     Gemini Flash: intent + facts with quotes  →  server re-parses and validates
                │     deterministic qualification (pinned policy)  →  human tasks for The Cut
                ├─ /api/v1/*                                    (Supabase Auth JWT, roles, RLS)
                └─ /internal/jobs/dispatch                      (bounded outbox batches)
                         │
              Supabase Postgres: leads, calls, evidence, assessments, tasks, outbox, usage, audit
                         │ outbox jobs (at-least-once, idempotent handlers)
                         ├─► Cal.com    (consultation booking; reconcile on timeout)
                         ├─► HubSpot    (contact + one open deal per lead; unique-property upsert)
                         └─► Resend     (designer / front-desk handoff; Idempotency-Key)
```

There is one Next.js/TypeScript project. Persistence and auth use Supabase (Postgres + Auth + RLS). Durable work runs through a Postgres outbox with leases. No microservices, no in-memory background workers, and no worker loop runs inside a request.

### Components map (Trigger → Input → Context → Processing → AI → Output)

| Stage | Implementation |
|---|---|
| Trigger | `POST /webhooks/voice/{provider}/incoming` with provider call id and timestamps (signed; deduplicated by event id) |
| Input | Caller utterances (`capture-facts`), caller number, language, recording/transcription consent |
| Context | Active **versioned** policy pinned at arrival (services, Pune boundary, rules, scripts, staffed hours, deadlines, retention); no pricing |
| Processing | Event dedupe and monotonic status; evidence validation; deterministic qualification; escalation tasks; outbox jobs |
| AI | Vaani conversation (audio). Gemini Flash runs `responseJsonSchema` extraction (intent, facts with quotes, requests, advisory route) |
| Output | Approved scripts to the caller; Supabase lead; Cal.com booking; HubSpot deal; Resend handoff; dashboard metrics and cost ledger |

### Call lifecycle

1. **Incoming:** stores the provider event and creates the call. The policy is pinned, after-hours is computed, and a new lead is created (never merged on phone number). The response carries a per-call tool token and the agent context: disclosure, first question, approved scripts and rules.
2. **`capture-facts`:**
   1. Store utterances idempotently by `(call_id, seq)` and set `first_response_at` from the first meaningful agent line.
   2. Run Gemini, or the fixture/heuristic extractor, **outside** any transaction.
   3. Validate every fact: it must quote a new caller utterance, numbers are re-parsed, and services and places are mapped through the policy.
   4. Insert evidence, resolve facts, open escalation tasks and choose the next single question. A read-back confirm comes first; a question unanswered twice is skipped.
   5. Guard the response.
3. **`evaluate-qualification`:** deterministic rules on the pinned policy. Assessments are stored with the policy version.
4. **Booking:** slots come from Cal.com. The caller confirms the read-back, availability is re-checked, then the booking is created. It counts as **confirmed only with a provider id**. A conflict returns 409 with alternatives; a timeout returns 202 (pending reconciliation) with a "not booked yet" script.
5. **`request-handoff`:** records intent only. The server picks the recipient after the call.
6. **Status event:** the call reaches a terminal state and `call.finalize` is enqueued (deduplicated). Finalisation:
   - saves the partial lead and settles discovery;
   - re-evaluates qualification;
   - opens callback/review tasks;
   - creates the handoff and CRM jobs **in the same transaction** (transactional outbox);
   - records voice usage.
7. **Jobs:** `handoff.send` (Resend), `handoff.ack_check` (deadline then escalation), `crm.sync` (HubSpot), `booking.reconcile` (Cal.com), and `maintenance.daily` (retention purge, stale-call closure, rate-limit cleanup).

### Qualification

`src/lib/domain/qualification.ts` is a pure function of the pinned policy, resolved facts, intent, discovery state and the injection flag.
- **not_fit** only when a usable (stated or confirmed, unambiguous) fact definitively fails a rule configured as `not_fit`, for example an unsupported service or a known outside location.
- **needs_review** when any fact is missing, declined, unconfirmed or contradictory, or when the intent is not a new project, discovery is incomplete, policy is missing or injection is suspected.
- **qualified** otherwise.

Unknown facts are NULL, never zero. Model confidence never decides suitability. Human edits create `reassessment` or `human_override` rows; the call-time assessment is never rewritten. See `docs/qualification-policy.md`.

## 3. Data model (Supabase migrations in `supabase/migrations`)

| Table | Purpose |
|---|---|
| `staff` | Roster and roles (`admin`, `front_desk`, `designer`). `auth_user_id` links Supabase Auth; roles are never taken from JWT claims. `approved_for_handoff` and `services` drive routing. |
| `business_policies` | Versioned config (draft → active → retired; one active). `is_demo` label. |
| `leads` (Lead) | Channel, contact, resolved fact columns (usable values only), `fact_status`, missing fields, discovery/qualification/handoff/booking/CRM/outcome states, open escalations, `version` for concurrency, `intake_at` for cohorts. |
| `calls` (Call) | Provider + provider call id (unique). Status with monotonic `status_rank`; arrival/answer/first-response/end times; after-hours; SLA exclusion; pinned `policy_id`; consent; prompt tracking. Many calls per lead. |
| `utterances` | Transcript lines (RLS-protected, retention-purged). |
| `field_evidence` (FieldEvidence) | Typed value, verbatim quote, utterance, source (AI / caller confirmation / human edit), ambiguity, confirmation status, extractor. |
| `qualification_assessments` | Decision, rule reasons, missing/contradictory fields, fact snapshot, policy version, kind (automatic / reassessment / human_override). |
| `human_tasks` | Escalations and exceptions (pricing, complaint, commitment, human request, urgent, review, callback, booking pending, integration failure, ack overdue, injection review, agent price utterance). Deduplicated. |
| `handoffs` (Handoff) | Recipient chosen from the roster or queue. Delivery state and acknowledgement state are **separate**; deadline and overdue tracked; preview stored. |
| `bookings` (Booking) | Request key (idempotency), caller confirmation time, provider booking uid, status incl. `pending_reconciliation`. |
| `integration_syncs` (IntegrationSync) | Per lead/provider/object remote ids and status (pending / succeeded / failed / ambiguous), live or mock. |
| `outcome_events` (OutcomeEvent) | Append-only (trigger-enforced) contacted / consultation_booked / won / lost. Contract value only with `won`. |
| `provider_events` (ProviderEvent) | Redacted inbound events, unique on `(provider, event_id)`. |
| `outbox_jobs` (OutboxJob) | Dedupe key, attempts, `run_after` backoff, lease, `dead` state. |
| `usage_events` (UsageEvent), `rate_cards` | Usage, fixed and invoice entries. Supplier currency micros + FX assumption + integer paise. Estimated vs invoiced; bundled meters; synthetic flags. |
| `audit_events` (AuditEvent) | Append-only (trigger-enforced) actor/action/before/after. |
| `dispatcher_runs`, `rate_limit_buckets`, `mock_remote_objects` | Freshness, durable rate limiting, deterministic mock-provider state. |

Duplicate and ordering guarantees:
- Retried webhooks hit `unique(provider, event_id)`.
- Duplicate handoffs hit `unique(dedupe_key)` (one per lead and purpose).
- Duplicate jobs hit `unique(dedupe_key)`.
- Status only moves forward by rank. Timestamps use `least` / `coalesce`.

## 4. API contract

`openapi.json` is generated from the zod request/response schemas (`npm run openapi`). A test fails if it drifts or if a frozen endpoint loses its route.

Conventions:
- UUID ids, UTC ISO-8601 timestamps, INR amounts in integer paise.
- Supplier currency and FX assumptions are preserved in the cost ledger.
- Every error is `{ code, message, request_id, details }`, and responses carry an `x-request-id` header.

All of the frozen endpoints from the backend prompt are implemented unchanged:
- leads (list, detail, PATCH), acknowledgements, outcomes, dashboard
- policies (GET, POST, publish)
- voice webhooks (incoming, status) and the four voice tools
- booking slots and bookings
- integrations, the dispatcher, demo calls, health and ready

**Documented additions** (non-breaking, marked `x-contract-addition` in `openapi.json`):

| Addition | Reason |
|---|---|
| `GET /api/v1/me` | The frontend needs the caller's role to render restricted states. |
| `POST /api/v1/cost-entries` (admin) | Invoiced costs are needed for reconciliation against estimates. |
| `GET /api/v1/demo/calls` | Lists scenarios; demo mode only. |
| `GET /internal/jobs/dispatch` | Vercel Cron only issues GET; same auth and limits as POST. |
| `capture-facts` optional `extract: false` | Records booking small talk without extraction. |
| `capture-facts` `confirmations[]` | Structured caller read-back confirmations, checked against an affirmative or negative caller utterance. |

**Clarifications Codex should know:**
- **Booking endpoints accept two auth modes:** a staff JWT, or the voice service credential bound to the current call (`X-Aangan-Call-Id` / `X-Aangan-Call-Token`). Voice may only act on its own call's lead and only book qualified leads.
- **`status` filter on `GET /api/v1/leads`:** it is the derived inbox `stage`. The individual state fields are also filterable or returned.
- **`request-handoff` delivers after the call:** delivery happens once the final decision is known, and recipients are always server-chosen.
- **Dashboard costs are admin-only:** the front desk receives `costs: null` with `costs_restricted: true`.

## 5. Security and privacy

- **Roles:** admin (founder), front desk and designer, from `public.staff`. Designers see only assigned leads; RLS enforces this on every staff read. API reads run as the `authenticated` role with `request.jwt.claims` set, and writes go through the API after authorisation. Browser clients (anon key + user JWT) can only read through RLS.
- **Auth:** Supabase access tokens are verified via JWKS (ES256/RS256) or the legacy HS256 secret. Anonymous sessions are rejected. Demo tokens (`DEMO_JWT_SECRET`, locally generated) are accepted **only** in demo mode; there is no built-in credential.
- **Service-role key:** not used by the app; it must never reach the browser.
- **Server-to-server:**
  - Webhooks use HMAC-SHA256 over the raw body (Vaani's scheme), with event-id dedupe and a 24 h age window.
  - Voice tools need `VOICE_TOOL_SECRET` plus a per-call token derived from the call id. The token is re-derivable for retries, and the call closes to tools 15 min after it ends.
  - The dispatcher needs `DISPATCH_SECRET` / `CRON_SECRET`.
- **AI cannot choose recipients:** `request-handoff` is a strict schema, so unknown keys such as `recipient_email` return 400. Recipients come from the approved roster or the policy's front-desk queue and are re-validated at send time.
- **Fail closed:** in live mode, every route except `/health` and `/ready` returns 503 until the database, JWT verification, voice tool secret, dispatcher secret, Vaani webhook secret and HTTPS base URL are configured. The simulated provider and demo endpoint do not exist in live mode. Missing provider credentials in live mode mean `not_configured`, so jobs fail visibly instead of being mocked.
- **Limits:** per-route body-size limits (413) and durable Postgres rate limits per principal (429 with `Retry-After`).
- **Logs:** structured JSON with redaction of tokens, phone numbers, emails and transcript text.
- **Retention:** configurable in the policy. Daily maintenance purges transcript text, evidence quotes, quoted task text and provider payloads; facts, decisions and audit are kept.
- **Transcripts and email:** transcripts appear only on the authenticated lead page. Emails carry a deterministic summary, a masked phone number and an authenticated link.
- **Caller declines transcription:** utterance text and quotes are not stored.

## 6. Reliability and provider limitations

- **Outbox:**
  - Jobs are claimed atomically (`FOR UPDATE SKIP LOCKED`) with a lease.
  - An interrupted dispatcher's job is reclaimed after the lease expires.
  - Retries use exponential backoff, then the job goes `dead` and is visible in `/api/v1/integrations` and the dashboard freshness block.
  - The dispatcher is bounded by job count and time budget.
- **At-least-once delivery.** Exactly-once external delivery is **not** claimed:
  - **Resend:** local dedupe (one handoff per lead and purpose) plus `Idempotency-Key` (24 h window).
  - **HubSpot:** deals are upserted on a unique `aangan_lead_id` property, so retries cannot duplicate them. Contact search is eventually consistent, so a timed-out contact create can rarely duplicate a contact.
  - **Cal.com:** has no idempotency key. A timeout becomes `pending_reconciliation` and the job looks the booking up by our booking key in metadata. It never re-creates without fresh caller confirmation.
- **Failure isolation:** CRM, email and calendar are separate jobs. Any of them can fail without blocking the others or losing the lead.
- **Scheduling:**
  - Vercel Hobby cron runs at most once a day, so `vercel.json` holds a daily backstop.
  - Use Supabase Cron (`supabase/cron.sql.example`, pg_cron + pg_net + Vault) for the per-minute dispatcher, or Vercel Pro cron.

## 7. Dashboard and cost model

Metric definitions ship in every dashboard response (`definitions`):
- **Five-minute compliance:** meaningful spoken response (an agent line of at least 20 characters by default) within 300 s of arrival, divided by eligible calls. Spam, test and internal calls are excluded and the exclusions shown. Missed, early-hang-up and answered-but-silent calls stay in the denominator and are counted in their own buckets.
- **Calls vs leads:** call counts and unique leads are separate.
- **Cohort conversion:** uses the intake window plus an observation window, shows unknown outcomes and flags `observation_complete`.
- **Null ratios:** all ratios are null when the denominator is zero.

Costs follow the plan's formula: `fixed costs + connected minutes × voice bundle rate + separately billed AI/speech + notifications + storage`.
- **Vaani:** the published voicebot rate (4 paise/s, billed per started minute) is applied to connected minutes. Phone pricing is unverified. Speech is recorded as **bundled** at zero, so it is never counted twice.
- **Gemini:** tokens at the published `gemini-3.8-flash` rates, with a **synthetic** FX assumption.
- **Plan charges:** Resend, Cal.com, HubSpot, Vercel, Supabase and GitHub are **synthetic placeholders**, prorated by day.
- **Claude:** tracked as a development tool and excluded from operating cost.
- **Invoices:** recorded with `POST /api/v1/cost-entries`. They replace estimates for the overlapping period and the variance is shown.
- **Cost per qualified lead:** null when there are no qualified leads.
- **Confirmed contract value:** shown separately and labelled as not collected revenue or profit.

## 8. Acceptance checks

| Requirement | Evidence |
|---|---|
| Price question → human escalation, no price | `tests/integration/voice-tools.test.ts` ("a price question…"), `scenarios.test.ts` (no agent line trips the guard), `speech-guard.test.ts` |
| Complaint → human task | `voice-tools.test.ts` ("a complaint…") |
| Project promise refused/referred | `voice-tools.test.ts` ("a project promise…") |
| Missing facts → needs_review | `qualification.test.ts`, `voice-tools.test.ts`, `missing_budget` scenario |
| Failed booking never announced as confirmed | `bookings.test.ts` (conflict 409, timeout 202 "not booked yet", rejection 502), `scenarios.test.ts` ordering check |
| Simulated metrics labelled | `dashboard.test.ts` (`data_labels`, `?data=`), email subjects `[SIMULATED]` |
| Dashboard has operating cost and pending acknowledgements | `dashboard.test.ts`, `npm run demo` checks |
| Missing policy | `voice-tools.test.ts`, `policies.test.ts` (ready 503) |
| Ambiguous area units | `parsers.test.ts`, `ambiguous_area` scenario |
| Prompt injection in transcripts | `normalize.test.ts`, `prompt_injection` scenario |
| Duplicate / out-of-order events | `webhooks.test.ts`, `handoffs.test.ts` (re-finalise) |
| Disconnects | `interrupted_call` scenario, stale-call maintenance test |
| Dispatcher interruption/retry | `jobs.test.ts` |
| Email failure, CRM isolation | `handoffs.test.ts` |
| Calendar conflict, timeout reconciliation | `bookings.test.ts` |
| CRM duplicate prevention | `crm.test.ts` |
| Acknowledgement permissions | `handoffs.test.ts` |
| Zero denominators, late outcomes/cohorts, bundled costs | `dashboard.test.ts` |
| Live mode fails closed; no secret disclosure | `security.test.ts`, `policies.test.ts` |
| Contract drift | `contract.test.ts` |

## 9. Assumptions

- **Policy:** all commercial rules are invented demo values.
  - Services: full-home and small-office interiors; structural construction excluded.
  - Boundary: a Pune locality list.
  - Thresholds: budget ≥ ₹8 lakh, start ≤ 6 months.
  - Staffed hours: Mon–Sat 10:00–19:00 IST (the brief does not give days).
  - Acknowledgement deadline: 120 min.
  - Front-desk queue: `front-desk@aangan-demo.example`.
- **Languages:** English, Hindi and Marathi are provisional, not promised.
- **Recording:** recording or transcription is optional per call. The disclosure is in the policy scripts.
- **Staff:** the demo staff identities are synthetic; real Supabase Auth users must be linked via `staff.auth_user_id`.

## 10. Remaining real-provider work (not done; requires accounts and user authorisation)

- **Vaani:** the documented API offers browser voice sessions and signed post-call webhooks only. There is **no documented server-side tool calling and no inbound telephony**. The live voice-to-tool loop therefore remains simulated. Before any live claim:
  - confirm the account's tool or event contracts, or build a bridge;
  - prove number routing and turn-taking latency.
- **Gemini:** verify `responseJsonSchema` and the model id with a real key, and measure latency (the voice-turn budget is 8 s timeout plus heuristic fallback).
- **Cal.com:** confirm the unavailable-slot error shape, whether booking works without attendee email, and that the event type does not require host confirmation.
- **HubSpot:** create the unique `aangan_lead_id` deal property and pipeline/stage ids; verify the duplicate-contact 409 format.
- **Resend:** verify the sending domain and from-address; use real designer addresses in the roster.
- **Supabase/Vercel:** link Auth users to staff, apply migrations, configure Supabase Cron, set secrets, deploy. Nothing has been published or pushed.

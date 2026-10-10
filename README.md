# Aangan Studio: phone-enquiry backend (simulated MVP)

> **Demo data and sample business rules.** Calls in demo mode are simulated. They exercise the real webhooks, voice tools, booking, CRM and email code paths with mock providers. They do **not** prove live phone answering.

This is the backend for Aangan Studio's incoming-phone enquiry tool (MESA Case 03). It answers, runs discovery and qualification, escalates pricing to a human, books Cal.com consultations, syncs HubSpot, hands leads to designers via Resend, tracks acknowledgements and outcomes, and reports response times and costs.

The stack is one Next.js 16 / TypeScript project with route handlers, Supabase Postgres, Auth and RLS, and a durable outbox. The studio workspace UI (Overview, Enquiries, Consultations, Activity & Costs, Settings) lives in the same app (`src/app/(workspace)`, `src/ui`) and uses the API types from `src/lib/api/schemas.ts`. It is deployed at **https://aangan-studio-delta.vercel.app**.

- Architecture, the Nine Checks and the acceptance mapping: [`architecture.md`](architecture.md)
- Qualification policy (Prompt 0 output): [`docs/qualification-policy.md`](docs/qualification-policy.md)
- Provider adapters, verified contracts and gaps: [`docs/providers.md`](docs/providers.md)

## Quick start (no Docker, no accounts)

Requires Node ≥ 20.9.

```bash
npm install
```

```bash
npm test
```

```bash
npm run demo
```

- `npm test` runs 230 tests against embedded Postgres (PGlite) with the real SQL migrations and RLS.
- `npm run demo` runs the reproducible end-to-end demo and writes `demo-output/`.

The demo covers:
1. Simulated Vaani enquiry.
2. Gemini classification fixture.
3. Saved lead.
4. Deterministic qualification and human pricing escalation.
5. Slot conflict, then a confirmed simulated Cal.com consultation.
6. Simulated HubSpot contact and deal.
7. Resend preview.
8. Designer acknowledgement.
9. Outcome.
10. Dashboard and cost ledger.

It then runs the unsupported-service, missing-budget, price-only, interrupted, declined-booking, prompt-injection and ambiguous-area scenarios. It exits non-zero if any check fails. Output:
- `demo-output/report.md`
- `transcripts/`, `emails/`, `leads/*.json`
- `dashboard.json`, `integrations.json`

## Run the API locally

**Option A: embedded database (no Docker).**

```bash
npm run demo:secrets
```

```bash
DATABASE_URL=pglite:./.demo-db npm run dev
```

`demo:secrets` writes random local secrets to `.env.local` (git-ignored). `pglite:` databases are created, migrated and seeded on first use, and work in demo mode only.

Mint a demo staff token. Identities: `admin`, `front_desk`, `front_desk_b`, `designer`, `designer_b`, `designer_c`.

```bash
npm run demo:token -- admin
```

Then try:

```bash
curl -s localhost:3000/ready
```

```bash
curl -s -X POST localhost:3000/api/v1/demo/calls -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"scenario":"suitable_home"}'
```

```bash
curl -s localhost:3000/api/v1/leads -H "authorization: Bearer $TOKEN"
```

```bash
curl -s localhost:3000/api/v1/dashboard -H "authorization: Bearer $TOKEN"
```

**Option B: Supabase CLI (requires Docker).** Run `npx supabase init` (keeps the existing `supabase/migrations`), then `npx supabase start` and `npx supabase db reset` (migrations plus `supabase/seed.sql`). Then set:
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- `SUPABASE_URL=http://127.0.0.1:54321`
- `SUPABASE_JWT_SECRET` from `supabase status`

Link real Auth users to staff with `update public.staff set auth_user_id = '<auth user id>' where email = '…'`.

**Without the CLI:** `DATABASE_URL=… npm run db:migrate` applies the migrations. Add `-- --seed` for demo data.

## Live phone calls (Vaani AI bridge)

Live calls run through a small always-on service in this repo:

```bash
npm run bridge
```

It serves the Vaani "Bring Your Own LLM" WebSocket (`/vaani/byol/<call_id>`), the call-event webhook (`/vaani/webhook?token=…`) and the job dispatcher. It needs a public `wss://` URL: deploy it with `render.yaml`, or use a tunnel for testing. The Vaani agent settings to change are in [`docs/providers.md`](docs/providers.md).

## Workspace UI and evaluator demo

- **Sign in:** `/login` offers **Explore the demo** (founder, front desk or designer) and **Studio staff sign in** (Supabase Auth email + password).
- **Demo sandbox:** `POST /api/v1/demo/session` issues a 4-hour token with a sandbox claim (demo mode only). Sandbox sessions see and change **simulated leads only** (real leads return 404), never see live calendar availability, and cannot edit policies or costs (403 `sandbox_read_only`). Simulated leads always use mock providers: no real email, calendar booking or CRM write.
- **Demo flow:** Overview → **Try a sample enquiry** (five scripted calls) → saved lead → qualification → simulated consultation → mock HubSpot and email status → switch to the recipient designer and **Accept lead** → the Overview updates.
- **Design:** ivory/forest-green system in `src/app/globals.css` (Instrument Serif + Inter via `next/font`); no extra UI dependencies.

## Deployment (Vercel)

Deployed to the Vercel team **Karan OP** (project `aangan-studio`, functions in `bom1` Mumbai beside the Supabase database).

1. **Environment:** production variables are set in Vercel (provider keys, `DATABASE_URL`, `CRON_SECRET`, `DEMO_JWT_SECRET` and the rest marked sensitive). `.vercelignore` keeps `.env*` out of uploads. `APP_MODE=demo` enables the evaluator sandbox.
2. **Deploy:** `npx vercel deploy --prod` (or connect the GitHub repository in Vercel for deploys on push).
3. **Dispatcher:** `vercel.json` runs a **daily** backstop (Hobby limit), authenticated with `CRON_SECRET`. The Vaani bridge also dispatches every minute while it runs. For per-minute processing without the bridge, use [`supabase/cron.sql.example`](supabase/cron.sql.example) or Vercel Pro cron.
4. **Staff accounts:** create a user in Supabase Auth, then link it: `update public.staff set auth_user_id = '<auth user id>' where email = '<staff email>';` (or insert a new staff row). The UI signs in with email + password, so no redirect URLs are needed; set the Supabase Auth Site URL to the deployed domain if you later enable password-reset or magic-link emails.
5. **Live mode:** set `APP_MODE=live` only when every check in `/ready` passes; live mode fails closed and disables the demo sandbox.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Vitest: unit, integration (embedded Postgres + RLS), adapters (stubbed HTTP), contract drift |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run demo` | Reproducible simulated end-to-end demo and report |
| `npm run openapi` | Regenerate `openapi.json` from the zod contract |
| `npm run seed:generate` | Regenerate `supabase/seed.sql` from `src/lib/seed/demo.ts` + `config/policy.demo.json` |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` (`-- --seed` for demo data) |
| `npm run demo:secrets` / `demo:token -- <identity>` | Local demo secrets / demo staff tokens (demo mode only) |
| `npm run bridge` | Vaani live-call bridge (WebSocket + webhook + dispatcher) |
| `npm run check` | typecheck + tests + demo |

## Layout

```text
config/policy.demo.json        editable sample policy (published as v1 by the seed)
fixtures/scenarios/*.json      synthetic calls + recorded Gemini-shaped extractions + expected outcomes
supabase/migrations/           schema, RLS policies
supabase/seed.sql              generated demo seed
src/app/                       route handlers (API contract in openapi.json)
src/lib/domain/                pure logic: parsers, facts, qualification, pricing guard, detectors
src/lib/ai/                    Gemini adapter, prompt, schema, validation, fixture/heuristic extractors
src/lib/services/              calls, voice tools, leads, handoffs, bookings, CRM, dashboard, usage…
src/lib/providers/             Cal.com, HubSpot, Resend, Vaani adapters + mocks
src/lib/jobs/                  outbox + bounded dispatcher
src/lib/simulation/            in-process simulated phone call runner
tests/                         unit + integration + contract tests
```

## Key guarantees

- **The Cut:** no autonomous customer-facing pricing. No rates, ranges, totals, discounts, tax terms or project dates, with or without disclaimers. Pricing requests, commitments and complaints become human tasks.
- **Rules decide qualification.** The AI only extracts facts with quotes; the server evaluates the pinned policy deterministically. Unknown facts are NULL, and incomplete evidence means `needs_review`.
- **Bookings are confirmed only with a provider booking id,** after the caller confirms the read-back.
- **Handoffs:** delivery is not acknowledgement. Recipients come only from the approved roster or queue.
- **Durable jobs:** leases, retries and visible dead jobs. Duplicate or out-of-order events are safe. Integrations fail independently.

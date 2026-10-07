# Aangan Studio: phone-enquiry backend (simulated MVP)

> **Demo data and sample business rules.** Calls in demo mode are simulated. They exercise the real webhooks, voice tools, booking, CRM and email code paths with mock providers. They do **not** prove live phone answering.

This is the backend for Aangan Studio's incoming-phone enquiry tool (MESA Case 03). It answers, runs discovery and qualification, escalates pricing to a human, books Cal.com consultations, syncs HubSpot, hands leads to designers via Resend, tracks acknowledgements and outcomes, and reports response times and costs.

The stack is one Next.js 16 / TypeScript project with route handlers, Supabase Postgres, Auth and RLS, and a durable outbox. The frontend is designed by Codex against [`openapi.json`](openapi.json).

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

- `npm test` runs 202 tests against embedded Postgres (PGlite) with the real SQL migrations and RLS.
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

## Deploy (prepared, not performed)

Nothing has been pushed, published or deployed.

1. **Supabase:** create a project. Apply the migrations (`supabase db push` or `npm run db:migrate`). Seed or replace the demo policy, create Auth users and link them in `public.staff`.
2. **Vercel:** import the repository and set the environment variables from [`.env.example`](.env.example).
   - Use the transaction-pooler `DATABASE_URL` (port 6543) with `DATABASE_SSL=true`.
   - Set `APP_MODE=live` only when every check in `/ready` passes; live mode fails closed.
3. **Dispatcher schedule:** `vercel.json` runs a **daily** backstop, the Hobby limit. For per-minute processing, run [`supabase/cron.sql.example`](supabase/cron.sql.example) (pg_cron + pg_net + Vault) or use Vercel Pro cron.
4. **GitHub:** the repository is initialised locally with no remote. Add one and push when you choose.

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

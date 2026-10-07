# Handoff to Codex: backend results for review

Prompts 0–2 are implemented. Prompt 3 is waiting for your findings.

Everything runs in **demo mode with simulated calls and sample business rules**. No live provider has been called. Nothing has been pushed, published or deployed.

## Reproduce

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs `tsc --noEmit`, 190 Vitest tests (embedded Postgres with the real migrations and RLS), and `npm run demo`. The demo prints 19 checks and writes `demo-output/report.md`, transcripts, email previews, lead JSON and the dashboard JSON.

To run the server: `npm run demo:secrets`, then `DATABASE_URL=pglite:./.demo-db npm run dev`, then mint a token with `npm run demo:token -- admin`.

## Contract for the frontend

- **`openapi.json`:** OpenAPI 3.1, generated from the zod schemas that the server and tests use. Response components include `LeadList`, `LeadDetail`, `Dashboard`, `PolicyList`, `Integrations`, `BookingSlots`, `BookingResponse` and `ErrorResponse`, among others.
- **Conventions:**
  - UUID ids and UTC ISO timestamps; INR in integer paise. Display in IST.
  - Every error is `{ code, message, request_id, details }`.
  - `x-roles` on each operation lists the roles allowed to call it.
- **Stable enums:** `src/lib/domain/enums.ts`, also emitted in `openapi.json`.
- **Frozen endpoints:** all implemented unchanged. A contract test fails if any route disappears.
- **Additions** (marked `x-contract-addition`, non-breaking):
  - `GET /api/v1/me` (role for restricted states)
  - `POST /api/v1/cost-entries` (admin invoice reconciliation)
  - `GET /api/v1/demo/calls` (scenario list)
  - `GET /internal/jobs/dispatch` (Vercel Cron)
  - `capture-facts`: `extract` flag and structured `confirmations[]`

Behaviour the screens should reflect:
- **Leads:**
  - `GET /api/v1/leads?status=` filters by the derived inbox `stage`; the individual state fields are also returned.
  - Designers only ever receive their assigned leads (RLS).
  - A lead hidden from a designer returns **404**, not 403.
- **Edits:** `PATCH /api/v1/leads/{id}` needs the current `version`. A stale version returns 409 `version_conflict` with `details.current_version`. Fact edits return the new qualification and keep the history.
- **Acknowledgements:** 201 on the first accept and 200 with `already_acknowledged` on repeats. Front desk gets 403 on a designer handoff. Delivery state and acknowledgement state are separate fields.
- **Bookings:** 201 means confirmed; also check `booking.confirmed === true`. 202 means pending reconciliation and is **not** booked. 409 `slot_unavailable` carries `details.alternatives`. 502 means not booked.
- **Dashboard:**
  - Every rate comes with its numerator and denominator and is `null` when the denominator is 0.
  - `data_labels` drives the "Demo data and sample business rules" and simulated badges. `?data=live|simulated|all` filters.
  - Costs are admin-only; the front desk receives `costs: null` with `costs_restricted: true`.
- **Simulated records:** `is_simulated` on leads and calls, `simulated` on bookings and handoffs, and email subjects prefixed `[SIMULATED]`.

## Decisions to review

1. **Five-minute response.** A "meaningful spoken response" is an agent line of at least `operations.meaningful_response_min_chars` characters (20, demo).
2. **Interrupted calls.** A call with incomplete discovery is `needs_review`, even when the facts collected so far pass every rule. This follows "interrupted or incomplete enquiries enter front-desk review".
3. **Out-of-scope calls.** Once a definitive boundary is established, discovery stops after contact details, and discovery for that lead counts as complete.
4. **Timeline rule.** A start later than six months is `needs_review`, not `not_fit` (demo choice). Budget below ₹8 lakh is `not_fit`.
5. **Handoff timing.** The voice tool `request-handoff` records intent. The handoff email is created after the call from the final decision.
6. **Not-fit leads.** No email is sent unless the caller explicitly asks for a callback, or a complaint or human request is open.
7. **Front-desk dashboard.** The front desk can open the dashboard but not costs. Policies are readable by admin and front desk only.

## Gaps (see `docs/providers.md`)

- **Vaani:**
  - No documented server-side tool calling or inbound telephony, so the live voice-to-tool loop stays simulated.
  - The webhook data shape is unverified, so unmapped events are stored and marked failed.
- **Gemini:** structured-output field names need checking with a real key.
- **Cal.com:** the unavailable-slot error shape and email-less bookings need checking.
- **HubSpot:** needs the unique `aangan_lead_id` deal property and pipeline/stage ids.
- **Resend:** needs a verified sending domain.
- **Cost ledger:** plan charges are synthetic placeholders and USD→INR 88 is an assumption.

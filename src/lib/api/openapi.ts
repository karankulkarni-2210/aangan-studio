import { z, type ZodType } from "zod";
import * as S from "./schemas";
import { voiceEventSchema } from "@/lib/services/calls";
import { listQuerySchema, patchLeadSchema } from "@/lib/services/leads";
import { outcomeBodySchema } from "@/lib/services/outcomes";
import { bookingBodySchema, slotsQuerySchema } from "@/lib/services/bookings";
import { dashboardQuerySchema } from "@/lib/services/dashboard";
import { costEntrySchema } from "@/lib/services/cost-entries";
import { captureFactsSchema, escalateSchema, requestHandoffSchema } from "@/lib/services/voice-tools";

// Builds openapi.json (OpenAPI 3.1 / JSON Schema 2020-12) from the same zod schemas the server
// uses to validate requests and the response schemas checked in tests. Run: npm run openapi.

type Security = "staff" | "voice" | "staff_or_voice" | "webhook" | "dispatch" | "none";

interface Op {
  method: "get" | "post" | "patch";
  path: string;
  summary: string;
  description?: string;
  tag: string;
  security: Security;
  roles?: string[];
  query?: ZodType;
  body?: string; // request component name
  responses: Record<number, string | null>; // status -> response component (null = no body)
  addition?: boolean;
}

const requests: Record<string, ZodType> = {
  PatchLeadRequest: patchLeadSchema,
  OutcomeRequest: outcomeBodySchema,
  BookingRequest: bookingBodySchema,
  PolicyDraftRequest: z.object({ config: z.record(z.string(), z.unknown()).describe("Full policy config; see config/policy.demo.json") }).strict(),
  CostEntryRequest: costEntrySchema,
  DemoCallRequest: z.object({ scenario: z.string(), run_jobs: z.boolean().default(true) }).strict(),
  VoiceEvent: voiceEventSchema,
  CaptureFactsRequest: captureFactsSchema,
  EvaluateQualificationRequest: z.object({}).strict(),
  EscalateRequest: escalateSchema,
  RequestHandoffRequest: requestHandoffSchema,
};

const responses: Record<string, ZodType> = {
  ErrorResponse: S.ErrorResponse,
  LeadList: S.LeadList,
  LeadDetail: S.LeadDetail,
  PatchLeadResponse: S.PatchLeadResponse,
  AcknowledgementResponse: S.AcknowledgementResponse,
  OutcomeResponse: S.OutcomeResponse,
  BookingSlots: S.BookingSlots,
  BookingResponse: S.BookingResponse,
  Dashboard: S.Dashboard,
  PolicyList: S.PolicyList,
  PolicyDraftResponse: S.PolicyDraftResponse,
  PolicyPublishResponse: S.PolicyPublishResponse,
  Integrations: S.Integrations,
  Me: S.Me,
  Health: S.Health,
  Ready: S.Ready,
  CostEntryResponse: S.CostEntryResponse,
  DispatchResult: S.DispatchResult,
  DemoScenarioList: S.DemoScenarioList,
  SimulationResult: S.SimulationResult,
  IncomingCallResponse: S.IncomingCallResponse,
  StatusEventResponse: S.StatusEventResponse,
  UnmappedEventResponse: S.UnmappedEventResponse,
  CaptureFactsResponse: S.CaptureFactsResponse,
  EvaluateQualificationResponse: S.EvaluateQualificationResponse,
  EscalateResponse: S.EscalateResponse,
  RequestHandoffResponse: S.RequestHandoffResponse,
};

const STAFF_ERRORS = { 401: "ErrorResponse", 403: "ErrorResponse", 429: "ErrorResponse", 503: "ErrorResponse" } as const;
const VOICE_ERRORS = { 400: "ErrorResponse", 401: "ErrorResponse", 409: "ErrorResponse", 429: "ErrorResponse" } as const;

export const OPERATIONS: Op[] = [
  { method: "get", path: "/api/v1/leads", tag: "Leads", summary: "List leads", description: "Paginated inbox. Row-level security limits designers to assigned leads.", security: "staff", query: listQuerySchema, responses: { 200: "LeadList", 400: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "get", path: "/api/v1/leads/{id}", tag: "Leads", summary: "Lead detail", description: "Facts with evidence, missing fields, calls and transcripts (role-restricted), qualification history, escalation flags, bookings, CRM sync, handoffs and outcomes.", security: "staff", responses: { 200: "LeadDetail", 404: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "patch", path: "/api/v1/leads/{id}", tag: "Leads", summary: "Edit a lead (audited, optimistic concurrency)", description: "Send the lead `version`; a stale version returns 409 version_conflict. Optional If-Match must equal the body version (412 otherwise). Designers cannot reassign or override qualification. Fact edits trigger a recorded reassessment; the original automatic assessment is kept.", security: "staff", body: "PatchLeadRequest", responses: { 200: "PatchLeadResponse", 400: "ErrorResponse", 404: "ErrorResponse", 409: "ErrorResponse", 412: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "post", path: "/api/v1/leads/{id}/acknowledgements", tag: "Handoffs", summary: "Accept a handoff (idempotent)", description: "Assigned designer (or front desk for queue handoffs, or an administrator). 201 on first acceptance, 200 with already_acknowledged=true on repeats.", security: "staff", responses: { 200: "AcknowledgementResponse", 201: "AcknowledgementResponse", 404: "ErrorResponse", 409: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "post", path: "/api/v1/leads/{id}/outcomes", tag: "Outcomes", summary: "Append an outcome", description: "Append-only. contract_value_paise only with outcome=won and is not collected revenue. Optional Idempotency-Key header.", security: "staff", body: "OutcomeRequest", responses: { 200: "OutcomeResponse", 201: "OutcomeResponse", 400: "ErrorResponse", 404: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "get", path: "/api/v1/booking-slots", tag: "Bookings", summary: "Consultation availability", description: "Staff JWT, or the voice service bound to the current call. Voice callers only see slots for qualified leads.", security: "staff_or_voice", query: slotsQuerySchema, responses: { 200: "BookingSlots", 400: "ErrorResponse", 502: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "post", path: "/api/v1/leads/{id}/bookings", tag: "Bookings", summary: "Book (caller-confirmed) or record a declined consultation", description: "201 confirmed (provider booking id present); 202 pending_reconciliation (timeout; NOT booked); 409 slot_unavailable with alternatives; 502 provider rejected (NOT booked). Idempotent on idempotency_key.", security: "staff_or_voice", body: "BookingRequest", responses: { 200: "BookingResponse", 201: "BookingResponse", 202: "BookingResponse", 400: "ErrorResponse", 403: "ErrorResponse", 404: "ErrorResponse", 409: "ErrorResponse", 502: "ErrorResponse", 401: "ErrorResponse", 429: "ErrorResponse" } },
  { method: "get", path: "/api/v1/dashboard", tag: "Dashboard", summary: "Founder dashboard", description: "Metrics with numerators/denominators and definitions; null rates for zero denominators; costs for administrators only.", security: "staff", roles: ["admin", "front_desk"], query: dashboardQuerySchema, responses: { 200: "Dashboard", 400: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "get", path: "/api/v1/policies", tag: "Policies", summary: "Policy versions and configuration readiness", security: "staff", roles: ["admin", "front_desk"], responses: { 200: "PolicyList", ...STAFF_ERRORS } },
  { method: "post", path: "/api/v1/policies", tag: "Policies", summary: "Create and validate a draft policy", description: "Administrator only. Invalid drafts are stored with their validation issues and cannot be published.", security: "staff", roles: ["admin"], body: "PolicyDraftRequest", responses: { 201: "PolicyDraftResponse", 400: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "post", path: "/api/v1/policies/{id}/publish", tag: "Policies", summary: "Publish a draft (audited)", security: "staff", roles: ["admin"], responses: { 200: "PolicyPublishResponse", 400: "ErrorResponse", 404: "ErrorResponse", 409: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "get", path: "/api/v1/integrations", tag: "Integrations", summary: "Integration modes and health (no secrets)", security: "staff", roles: ["admin", "front_desk"], responses: { 200: "Integrations", ...STAFF_ERRORS } },
  { method: "get", path: "/api/v1/demo/calls", tag: "Demo", summary: "List simulated scenarios (demo mode only)", security: "staff", roles: ["admin", "front_desk"], responses: { 200: "DemoScenarioList", 404: "ErrorResponse", ...STAFF_ERRORS }, addition: true },
  { method: "post", path: "/api/v1/demo/calls", tag: "Demo", summary: "Run a simulated call (unavailable in live mode)", security: "staff", roles: ["admin", "front_desk"], body: "DemoCallRequest", responses: { 201: "SimulationResult", 404: "ErrorResponse", ...STAFF_ERRORS } },
  { method: "get", path: "/api/v1/me", tag: "Session", summary: "Current staff identity and role", security: "staff", responses: { 200: "Me", ...STAFF_ERRORS }, addition: true },
  { method: "post", path: "/api/v1/cost-entries", tag: "Costs", summary: "Record an invoiced cost for reconciliation", security: "staff", roles: ["admin"], body: "CostEntryRequest", responses: { 201: "CostEntryResponse", 400: "ErrorResponse", ...STAFF_ERRORS }, addition: true },
  { method: "post", path: "/webhooks/voice/{provider}/incoming", tag: "Voice webhooks", summary: "Incoming call event", description: "Provider-signed (vaani: X-VaaniVoice-Signature; simulated: X-Aangan-Signature; value `sha256=<hex HMAC of raw body>`). Deduplicated by event id. Returns the per-call tool session and agent context.", security: "webhook", body: "VoiceEvent", responses: { 200: "IncomingCallResponse", 202: "UnmappedEventResponse", 400: "ErrorResponse", 401: "ErrorResponse", 404: "ErrorResponse", 413: "ErrorResponse", 429: "ErrorResponse", 503: "ErrorResponse" } },
  { method: "post", path: "/webhooks/voice/{provider}/status", tag: "Voice webhooks", summary: "Call status event", description: "Monotonic: out-of-order events never regress a call. Terminal status enqueues finalisation.", security: "webhook", body: "VoiceEvent", responses: { 200: "StatusEventResponse", 202: "UnmappedEventResponse", 400: "ErrorResponse", 401: "ErrorResponse", 404: "ErrorResponse", 413: "ErrorResponse", 429: "ErrorResponse", 503: "ErrorResponse" } },
  { method: "post", path: "/internal/voice/tools/capture-facts", tag: "Voice tools", summary: "Record utterances, extract facts with evidence, get the next question", security: "voice", body: "CaptureFactsRequest", responses: { 200: "CaptureFactsResponse", ...VOICE_ERRORS } },
  { method: "post", path: "/internal/voice/tools/evaluate-qualification", tag: "Voice tools", summary: "Deterministic qualification against the pinned policy", security: "voice", body: "EvaluateQualificationRequest", responses: { 200: "EvaluateQualificationResponse", ...VOICE_ERRORS } },
  { method: "post", path: "/internal/voice/tools/escalate-to-human", tag: "Voice tools", summary: "Create a human task (pricing, complaint, commitment, human request, urgent)", security: "voice", body: "EscalateRequest", responses: { 200: "EscalateResponse", ...VOICE_ERRORS } },
  { method: "post", path: "/internal/voice/tools/request-handoff", tag: "Voice tools", summary: "Request a handoff (server picks the recipient; delivered after the call)", security: "voice", body: "RequestHandoffRequest", responses: { 200: "RequestHandoffResponse", ...VOICE_ERRORS } },
  { method: "post", path: "/internal/jobs/dispatch", tag: "Operations", summary: "Run the bounded outbox dispatcher", description: "Bearer DISPATCH_SECRET (or CRON_SECRET). Query: limit (<=100), time_budget_ms (<=20000). GET is accepted for Vercel Cron.", security: "dispatch", responses: { 200: "DispatchResult", 401: "ErrorResponse", 429: "ErrorResponse", 503: "ErrorResponse" } },
  { method: "get", path: "/internal/jobs/dispatch", tag: "Operations", summary: "Dispatcher (Vercel Cron GET form)", security: "dispatch", responses: { 200: "DispatchResult", 401: "ErrorResponse", 503: "ErrorResponse" }, addition: true },
  { method: "get", path: "/health", tag: "Operations", summary: "Liveness", security: "none", responses: { 200: "Health" } },
  { method: "get", path: "/ready", tag: "Operations", summary: "Readiness (dependencies and configuration, no secrets)", security: "none", responses: { 200: "Ready", 503: "Ready" } },
];

function components(registryItems: Record<string, ZodType>, io: "input" | "output") {
  const reg = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(registryItems)) reg.add(schema, { id });
  const out = z.toJSONSchema(reg, { io, uri: (id) => `#/components/schemas/${id}`, unrepresentable: "any" }) as { schemas: Record<string, Record<string, unknown>> };
  for (const s of Object.values(out.schemas)) {
    delete s.$schema;
    delete s.$id;
  }
  return out.schemas;
}

function queryParams(schema: ZodType) {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({ name, in: "query", required: js.required?.includes(name) ?? false, schema: s }));
}

const SECURITY: Record<Security, Array<Record<string, string[]>>> = {
  staff: [{ staffJwt: [] }],
  voice: [{ voiceServiceToken: [], callId: [], callToken: [] }],
  staff_or_voice: [{ staffJwt: [] }, { voiceServiceToken: [], callId: [], callToken: [] }],
  webhook: [{ webhookSignature: [] }],
  dispatch: [{ dispatchSecret: [] }],
  none: [],
};

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const params: unknown[] = [];
    for (const m of op.path.matchAll(/\{(\w+)\}/g)) {
      params.push({ name: m[1], in: "path", required: true, schema: m[1] === "provider" ? { type: "string", enum: ["vaani", "simulated"] } : { type: "string", format: "uuid" } });
    }
    if (op.query) params.push(...queryParams(op.query));
    const res: Record<string, unknown> = {};
    for (const [status, comp] of Object.entries(op.responses)) {
      res[status] = comp ? { description: Number(status) < 400 ? "Success" : "Error", content: { "application/json": { schema: { $ref: `#/components/schemas/${comp}` } } } } : { description: "No content" };
    }
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      operationId: `${op.method}${op.path.replace(/[{}]/g, "").replace(/[/-](\w)/g, (_, c: string) => c.toUpperCase())}`,
      security: SECURITY[op.security],
      ...(op.roles ? { "x-roles": op.roles } : {}),
      ...(op.addition ? { "x-contract-addition": true } : {}),
      parameters: params,
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${op.body}` } } } } } : {}),
      responses: res,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Aangan Studio phone-enquiry API",
      version: "1.0.0",
      description:
        "Backend contract for the Aangan Studio phone-enquiry MVP. Demo data and sample business rules; simulated calls are labelled. UUID ids, UTC ISO-8601 timestamps, INR in integer paise. Errors use { code, message, request_id, details }. No endpoint returns customer-facing prices.",
    },
    servers: [{ url: "http://localhost:3000", description: "Local" }],
    tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        staffJwt: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Supabase Auth access token (JWKS ES256/RS256 or legacy HS256). Roles come from public.staff, not token claims." },
        voiceServiceToken: { type: "http", scheme: "bearer", description: "VOICE_TOOL_SECRET (server-to-server)" },
        callId: { type: "apiKey", in: "header", name: "X-Aangan-Call-Id" },
        callToken: { type: "apiKey", in: "header", name: "X-Aangan-Call-Token", description: "Per-call token from the incoming webhook response" },
        webhookSignature: { type: "apiKey", in: "header", name: "X-VaaniVoice-Signature", description: "sha256=<hex HMAC-SHA256 of the raw body>; the simulated provider uses X-Aangan-Signature" },
        dispatchSecret: { type: "http", scheme: "bearer", description: "DISPATCH_SECRET or CRON_SECRET" },
      },
      schemas: { ...components(requests, "input"), ...components(responses, "output") },
    },
  };
}

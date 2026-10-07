import { randomUUID } from "node:crypto";
import * as bookingsRoute from "@/app/api/v1/leads/[id]/bookings/route";
import * as slotsRoute from "@/app/api/v1/booking-slots/route";
import * as captureRoute from "@/app/internal/voice/tools/capture-facts/route";
import * as escalateRoute from "@/app/internal/voice/tools/escalate-to-human/route";
import * as evaluateRoute from "@/app/internal/voice/tools/evaluate-qualification/route";
import * as handoffRoute from "@/app/internal/voice/tools/request-handoff/route";
import * as incomingRoute from "@/app/webhooks/voice/[provider]/incoming/route";
import * as statusRoute from "@/app/webhooks/voice/[provider]/status/route";
import { env } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { ApiError } from "@/lib/http/errors";
import { runDispatcher } from "@/lib/jobs/handlers";
import type { DispatchResult } from "@/lib/jobs/outbox";
import { signVaaniBody } from "@/lib/providers/vaani";
import { ensureEphemeralDemoSecrets, now } from "@/lib/runtime";
import type { Scenario } from "./scenario";
import { getScenario } from "./scenarios";

// Simulated phone call. Drives the REAL route handlers in-process (signed webhooks, call-bound
// voice tools, booking API) exactly as a voice platform would, using recorded Gemini-shaped
// fixtures. Everything it creates is flagged simulated; it never reaches live providers.

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export interface SimulationStep {
  step: string;
  http_status: number;
  detail: Record<string, unknown>;
}

export interface SimulationResult {
  label: string;
  scenario: string;
  simulated: true;
  provider: "simulated";
  provider_call_id: string;
  call_id: string | null;
  lead_id: string | null;
  transcript: Array<{ seq: number; speaker: "agent" | "caller"; text: string }>;
  steps: SimulationStep[];
  dispatch: DispatchResult[];
  expected: Scenario["expected"];
}

const STUDIO_NUMBER = "+912000000000"; // synthetic
const base = () => env.appBaseUrl().replace(/\/$/, "");

async function invoke(handler: Handler, method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string>; params?: Record<string, string> } = {}) {
  const raw = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const req = new Request(`${base()}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1", ...(opts.headers ?? {}) },
    body: raw,
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function arrivalFor(s: Scenario, totalSeconds: number): Date {
  const t = now();
  if (!s.arrival_ist) return new Date(t.getTime() - totalSeconds * 1000 - 5000);
  const [h, m] = s.arrival_ist.split(":").map(Number);
  const istDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(t);
  let at = new Date(`${istDay}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`);
  if (at.getTime() + totalSeconds * 1000 > t.getTime()) at = new Date(at.getTime() - 86400000);
  return at;
}

export async function runScenarioById(db: Db, id: string, opts: { runJobs: boolean }): Promise<SimulationResult> {
  const scenario = getScenario(id);
  if (!scenario) throw new ApiError(404, "unknown_scenario", `No simulated scenario named ${id}`);
  return runScenario(db, scenario, opts);
}

export async function runScenario(db: Db, s: Scenario, opts: { runJobs: boolean; duplicateStatusEvent?: boolean }): Promise<SimulationResult> {
  ensureEphemeralDemoSecrets();
  const webhookSecret = env.simulatedWebhookSecret()!;
  const toolSecret = env.voiceToolSecret()!;
  const providerCallId = `sim-${s.id}-${randomUUID().slice(0, 8)}`;
  const turnSeconds = 25;
  const bookingSeconds = s.booking ? 60 : 0;
  const plannedTurns = s.ending.after_turn !== undefined ? s.ending.after_turn + 1 : s.turns.length;
  const total = 3 + plannedTurns * turnSeconds + (s.ending.after_turn === undefined ? 30 + bookingSeconds : 4);
  const arrival = arrivalFor(s, total);
  const at = (offsetS: number) => new Date(arrival.getTime() + offsetS * 1000).toISOString();
  const steps: SimulationStep[] = [];
  const transcript: SimulationResult["transcript"] = [];
  const result: SimulationResult = {
    label: "SIMULATED CALL · demo data and sample business rules",
    scenario: s.id,
    simulated: true,
    provider: "simulated",
    provider_call_id: providerCallId,
    call_id: null,
    lead_id: null,
    transcript,
    steps,
    dispatch: [],
    expected: s.expected,
  };

  const signed = async (handler: Handler, path: string, event: Record<string, unknown>) => {
    const raw = JSON.stringify(event);
    return invoke(handler, "POST", path, { raw, headers: { "x-aangan-signature": signVaaniBody(raw, webhookSecret) }, params: { provider: "simulated" } });
  };

  // 1. Incoming call webhook.
  const incoming = await signed(incomingRoute.POST as Handler, "/webhooks/voice/simulated/incoming", {
    id: `evt_${providerCallId}_incoming`,
    type: "call.incoming",
    created: Math.floor(arrival.getTime() / 1000),
    data: {
      call_id: providerCallId,
      from: s.caller_phone,
      to: STUDIO_NUMBER,
      arrived_at: arrival.toISOString(),
      answered_at: at(1),
      language: "en",
      disclosure_given: true,
      recording_consent: s.recording_consent,
      simulation_scenario: s.id,
    },
  });
  steps.push({ step: "webhook.incoming", http_status: incoming.status, detail: { call_id: incoming.body.call_id, policy_version: incoming.body.agent_context?.policy_version } });
  if (incoming.status !== 200) return result;
  const callId: string = incoming.body.call_id;
  result.call_id = callId;
  result.lead_id = incoming.body.lead_id;
  const voiceHeaders = {
    authorization: `Bearer ${toolSecret}`,
    "x-aangan-call-id": callId,
    "x-aangan-call-token": incoming.body.tool_session.call_token,
  };
  const tool = (handler: Handler, path: string, body: unknown) => invoke(handler, "POST", `/internal/voice/tools/${path}`, { body, headers: voiceHeaders });

  const ctx = incoming.body.agent_context;
  let agentLine = [ctx.disclosure, ctx.first_question].filter(Boolean).join(" ");
  let lastNext: { kind: string; evidence_id: string | null } | null = null;
  let seq = 0;
  let clock = 2;
  let interrupted = false;

  // 2. Discovery turns.
  for (let i = 0; i < s.turns.length; i++) {
    const turn = s.turns[i];
    const agentSeq = seq++;
    const callerSeq = seq++;
    const utterances = [
      { seq: agentSeq, speaker: "agent", text: agentLine, spoken_at: at(clock) },
      { seq: callerSeq, speaker: "caller", text: turn.caller, spoken_at: at(clock + 10) },
    ];
    clock += turnSeconds;
    transcript.push({ seq: agentSeq, speaker: "agent", text: agentLine }, { seq: callerSeq, speaker: "caller", text: turn.caller });
    const confirmations =
      (turn.confirms || turn.rejects) && lastNext?.kind === "confirm" && lastNext.evidence_id
        ? [{ evidence_id: lastNext.evidence_id, confirmed: Boolean(turn.confirms), utterance_seq: callerSeq }]
        : [];
    const cap = await tool(captureRoute.POST as Handler, "capture-facts", { utterances, confirmations });
    steps.push({
      step: `tool.capture_facts[${i}]`,
      http_status: cap.status,
      detail: { next: cap.body.next?.field ?? null, next_kind: cap.body.next?.kind ?? null, escalations: (cap.body.escalations ?? []).map((e: { kind: string }) => e.kind), extraction: cap.body.extraction, code: cap.body.code },
    });
    lastNext = cap.body.next ?? null;
    agentLine = (cap.body.say ?? []).join(" ");
    if (turn.escalate) {
      const esc = await tool(escalateRoute.POST as Handler, "escalate-to-human", { kind: turn.escalate, utterance_seq: callerSeq });
      steps.push({ step: "tool.escalate_to_human", http_status: esc.status, detail: { kind: turn.escalate, task_id: esc.body.task_id } });
    }
    if (s.ending.after_turn === i) {
      interrupted = true;
      break;
    }
  }

  // 3. Qualification, booking and handoff.
  const closing: Array<{ speaker: "agent" | "caller"; text: string }> = [];
  if (!interrupted) {
    if (agentLine) closing.push({ speaker: "agent", text: agentLine });
    const ev = await tool(evaluateRoute.POST as Handler, "evaluate-qualification", {});
    steps.push({ step: "tool.evaluate_qualification", http_status: ev.status, detail: { decision: ev.body.decision, reasons: ev.body.reasons, booking_eligible: ev.body.booking_eligible } });
    closing.push({ speaker: "agent", text: (ev.body.say ?? []).join(" ") });

    if (ev.body.booking_eligible && s.booking) {
      const slots = await invoke(slotsRoute.GET as Handler, "GET", `/api/v1/booking-slots?lead_id=${result.lead_id}`, { headers: voiceHeaders });
      steps.push({ step: "api.booking_slots", http_status: slots.status, detail: { offered: (slots.body.slots ?? []).length, mode: slots.body.event_type?.mode } });
      const offered: Array<{ start: string; label: string }> = slots.body.slots ?? [];
      if (offered.length) closing.push({ speaker: "agent", text: `I can offer ${offered.map((o) => o.label).join(", or ")}.` });

      if (s.booking.action === "decline") {
        closing.push({ speaker: "caller", text: s.booking.caller_reply });
        const dec = await invoke(bookingsRoute.POST as Handler, "POST", `/api/v1/leads/${result.lead_id}/bookings`, {
          body: { decision: "decline", idempotency_key: `decline-${providerCallId}`, reason: "caller preferred a callback" },
          headers: voiceHeaders,
          params: { id: result.lead_id! },
        });
        steps.push({ step: "api.booking_decline", http_status: dec.status, detail: { status: dec.body.booking?.status } });
        closing.push({ speaker: "agent", text: (dec.body.say ?? []).join(" ") });
      } else if (offered.length) {
        let choice = offered[Math.min(s.booking.slot_index, offered.length - 1)];
        closing.push({ speaker: "caller", text: s.booking.caller_reply });
        closing.push({ speaker: "agent", text: String(ctx.booking_read_back ?? "").replace("{slot_label}", choice.label) });
        closing.push({ speaker: "caller", text: "Yes, please." });
        if (s.booking.take_conflicting_slot_first) {
          // Another caller takes the slot between the offer and the booking (race condition).
          await db.query(
            `insert into public.mock_remote_objects (provider, object_kind, remote_id, lookup_key, payload) values ('calcom', 'slot_taken', $1, $2, '{"by":"another simulated caller"}')`,
            [`sim_slot_${randomUUID().slice(0, 12)}`, choice.start],
          );
        }
        let book = await invoke(bookingsRoute.POST as Handler, "POST", `/api/v1/leads/${result.lead_id}/bookings`, {
          body: { decision: "book", slot_start: choice.start, caller_confirmed: true, idempotency_key: `book-${providerCallId}-1` },
          headers: voiceHeaders,
          params: { id: result.lead_id! },
        });
        steps.push({ step: "api.booking_create", http_status: book.status, detail: { status: book.body.booking?.status ?? book.body.code, slot: choice.start } });
        if (book.status === 409 && book.body.code === "slot_unavailable" && book.body.details?.alternatives?.length) {
          const alt = book.body.details.alternatives[0];
          closing.push({ speaker: "agent", text: `${(book.body.details.say ?? []).join(" ")} The next available time is ${alt.label}.` });
          closing.push({ speaker: "caller", text: "That works, yes please book it." });
          choice = alt;
          book = await invoke(bookingsRoute.POST as Handler, "POST", `/api/v1/leads/${result.lead_id}/bookings`, {
            body: { decision: "book", slot_start: alt.start, caller_confirmed: true, idempotency_key: `book-${providerCallId}-2` },
            headers: voiceHeaders,
            params: { id: result.lead_id! },
          });
          steps.push({ step: "api.booking_create_retry", http_status: book.status, detail: { status: book.body.booking?.status ?? book.body.code, slot: alt.start, confirmed: book.body.booking?.confirmed } });
        }
        // Only a provider-confirmed booking is announced as booked; otherwise the pending script is used.
        closing.push({ speaker: "agent", text: (book.body.say ?? book.body.details?.say ?? []).join(" ") });
      }
    }
    const ho = await tool(handoffRoute.POST as Handler, "request-handoff", {});
    steps.push({ step: "tool.request_handoff", http_status: ho.status, detail: { recipient_kind: ho.body.recipient_kind, delivery: ho.body.delivery } });
    closing.push({ speaker: "agent", text: (ho.body.say ?? []).join(" ") });

    const lines = closing.filter((l) => l.text.trim().length > 0).map((l) => ({ seq: seq++, speaker: l.speaker, text: l.text, spoken_at: at(clock++) }));
    for (const l of lines) transcript.push({ seq: l.seq, speaker: l.speaker, text: l.text });
    if (lines.length) {
      const rec = await tool(captureRoute.POST as Handler, "capture-facts", { utterances: lines, extract: false });
      steps.push({ step: "tool.capture_facts[closing]", http_status: rec.status, detail: { recorded: lines.length } });
    }
  }

  // 4. Call ends.
  const endedAt = at(Math.max(clock + 2, 5));
  const statusEvent = {
    id: `evt_${providerCallId}_ended`,
    type: "call.completed",
    created: Math.floor(new Date(endedAt).getTime() / 1000),
    data: {
      call_id: providerCallId,
      status: "completed",
      ended_at: endedAt,
      duration_seconds: Math.round((new Date(endedAt).getTime() - new Date(at(1)).getTime()) / 1000),
      end_reason: interrupted ? s.ending.reason : "agent_completed",
    },
  };
  const ended = await signed(statusRoute.POST as Handler, "/webhooks/voice/simulated/status", statusEvent);
  steps.push({ step: "webhook.status", http_status: ended.status, detail: { status: ended.body.status, end_reason: statusEvent.data.end_reason } });
  if (opts.duplicateStatusEvent !== false) {
    const dup = await signed(statusRoute.POST as Handler, "/webhooks/voice/simulated/status", statusEvent);
    steps.push({ step: "webhook.status_duplicate_delivery", http_status: dup.status, detail: { duplicate: dup.body.duplicate } });
  }

  // 5. Durable jobs (finalise, handoff email, CRM), bounded.
  if (opts.runJobs) {
    for (let i = 0; i < 5; i++) {
      const r = await runDispatcher(db, { limit: 25, timeBudgetMs: 15000, trigger: "simulation" });
      result.dispatch.push(r);
      if (r.remaining_ready === 0) break;
    }
  }
  return result;
}

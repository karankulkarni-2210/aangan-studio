import type { Db } from "@/lib/db/types";
import { isAffirmation, isNegation } from "@/lib/domain/detectors";
import { normaliseNumbers } from "@/lib/domain/parsers";
import { inspectSpeech } from "@/lib/domain/speech-guard";
import { ApiError } from "@/lib/http/errors";
import type { VoiceBinding } from "@/lib/http/route";
import { log } from "@/lib/log";
import { now } from "@/lib/runtime";
import { createBooking, listSlots } from "@/lib/services/bookings";
import { agentContext, FALLBACK_SCRIPT, processVoiceEvent } from "@/lib/services/calls";
import { isWebsiteVoiceTest, WEBSITE_VOICE_TEST } from "./test-session";
import { getPolicyById, type PolicyRecord } from "@/lib/services/policies";
import { captureFacts, evaluateForCall, requestHandoff } from "@/lib/services/voice-tools";

// Live phone conversation driven through Vaani's "Bring Your Own LLM" WebSocket. Vaani handles
// audio; on every caller turn it sends the full transcript and speaks exactly what this returns.
// Every line comes from the server: discovery questions, approved scripts and booking read-backs,
// and passes the pricing/commitment guard. Gemini only extracts facts (via capture-facts).

export interface TranscriptMessage {
  role: string;
  content: string;
}

type Phase = "discovery" | "booking_yesno" | "booking_choose" | "booking_confirm" | "closing";
interface SlotOut {
  start: string;
  end: string;
  label: string;
}

const CLARIFY = "Sorry, I didn't quite catch that. Could you say that again?";
const GOODBYE = "Thank you for calling Aangan Studio. Goodbye.";
const DECLINE_RE = /\b(not now|no thanks|no thank you|later|don't|do not|skip|not interested)\b/i;

function safe(text: string): string {
  const g = inspectSpeech(text);
  if (!g.blocked) return text;
  log.error("bridge_speech_blocked", { codes: g.codes });
  return FALLBACK_SCRIPT;
}

function offerLine(slots: SlotOut[]): string {
  return `I can offer ${slots.map((s) => s.label).join(", or ")}. Which works best for you?`;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Picks a slot from the caller's words: weekday and/or time first, then "first/second/third". */
export function chooseSlot(text: string, offered: SlotOut[]): SlotOut | null {
  if (offered.length === 0) return null;
  const s = normaliseNumbers(text);
  let candidates = offered;
  const day = WEEKDAYS.find((d) => s.includes(d));
  if (day) candidates = candidates.filter((o) => o.label.toLowerCase().includes(day));
  const t = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/.exec(s);
  if (t) {
    const hour = Number(t[1]);
    const minute = t[2] ? Number(t[2]) : null;
    const byTime = candidates.filter((o) => {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: false }).formatToParts(new Date(o.start));
      const h24 = Number(parts.find((p) => p.type === "hour")?.value);
      const m = Number(parts.find((p) => p.type === "minute")?.value);
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return (hour === h24 || hour === h12) && (minute === null || minute === m);
    });
    if (byTime.length) candidates = byTime;
  }
  if (candidates.length === 1 && (day || t)) return candidates[0];
  const ordinal = /\b(first|1st|earliest)\b/.test(s) ? 0 : /\b(second|2nd|middle)\b/.test(s) ? 1 : /\b(third|3rd)\b/.test(s) ? 2 : /\b(last|latest)\b/.test(s) ? candidates.length - 1 : null;
  if (ordinal !== null && candidates[ordinal]) return candidates[ordinal];
  return candidates.length === 1 && (day || t) ? candidates[0] : null;
}

export class Conversation {
  private voice: VoiceBinding | null = null;
  private policy: PolicyRecord | null = null;
  private opening = { disclosure: FALLBACK_SCRIPT, firstQuestion: null as string | null };
  private phase: Phase = "discovery";
  private recorded = 0;
  private lastNext: { kind: string; evidence_id: string | null } | null = null;
  private offered: SlotOut[] = [];
  private chosen: SlotOut | null = null;
  private pendingAgent: string | null = null;
  private readonly startedAt = now();
  private ended = false;

  constructor(
    private readonly db: Db,
    readonly providerCallId: string,
    private readonly reqBody: Record<string, unknown> | null,
  ) {
    this.provider = isWebsiteVoiceTest(reqBody) ? "simulated" : "vaani";
  }

  /** Website voice tests are recorded as simulated calls: mock calendar, CRM and email. */
  private readonly provider: "vaani" | "simulated";

  get callId() {
    return this.voice?.callId ?? null;
  }

  /** Registers the call (idempotent: a Vaani `call_started` webhook may have created it first). */
  async start(): Promise<void> {
    if (this.voice) return;
    const at = now().toISOString();
    const res = await processVoiceEvent(
      this.db,
      this.provider,
      {
        id: `vaani:${this.providerCallId}:byol_connected`,
        type: "call.incoming",
        created: Math.floor(Date.now() / 1000),
        data: {
          call_id: this.providerCallId,
          from: typeof this.reqBody?.contact_number === "string" ? this.reqBody.contact_number : null,
          arrived_at: at,
          answered_at: at,
          language: typeof this.reqBody?.primary_language === "string" ? this.reqBody.primary_language.slice(0, 10) : undefined,
          disclosure_given: true,
          ...(this.provider === "simulated" ? { simulation_scenario: WEBSITE_VOICE_TEST } : {}),
        },
      },
      { source: "byol_connect" },
    );
    this.voice = { callId: res.callId, leadId: res.leadId, provider: this.provider, isSimulated: this.provider === "simulated", finalized: false };
    this.policy = await this.db.tx(async (tx) => {
      const { rows } = await tx.query(`select policy_id from public.calls where id = $1`, [res.callId]);
      return getPolicyById(tx, rows[0]?.policy_id ?? null);
    });
    const ctx = agentContext(res).agent_context as { disclosure?: string; first_question?: string | null };
    this.opening = { disclosure: ctx.disclosure ?? FALLBACK_SCRIPT, firstQuestion: ctx.first_question ?? null };
  }

  /** Handles one `response_required` turn and returns what the agent should say. */
  async respond(transcript: TranscriptMessage[]): Promise<{ content: string; endCall: boolean }> {
    await this.start();
    try {
      const out = await this.turn(transcript);
      const content = safe(out.lines.filter((l) => l && l.trim()).join(" ") || CLARIFY);
      this.pendingAgent = content;
      if (out.endCall) this.ended = true;
      return { content, endCall: out.endCall };
    } catch (err) {
      log.error("bridge_turn_failed", { call_id: this.voice?.callId, error: err });
      return { content: CLARIFY, endCall: false };
    }
  }

  private async turn(transcript: TranscriptMessage[]): Promise<{ lines: string[]; endCall: boolean }> {
    const voice = this.voice!;
    const msgs = transcript
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "agent")
      .map((m) => ({ speaker: m.role === "user" ? ("caller" as const) : ("agent" as const), text: String(m.content ?? "").slice(0, 2000) }))
      .filter((m) => m.text.trim().length > 0);
    if (msgs.length < this.recorded) this.recorded = msgs.length; // transcript was trimmed upstream
    const fresh = msgs.slice(this.recorded).map((m, i) => ({ seq: this.recorded + i, speaker: m.speaker, text: m.text, spoken_at: now().toISOString() }));
    if (fresh.some((m) => m.speaker === "agent" && m.text === this.pendingAgent)) this.pendingAgent = null;
    this.recorded = msgs.length;
    const latestCaller = [...fresh].reverse().find((m) => m.speaker === "caller") ?? null;

    if (!msgs.some((m) => m.speaker === "caller")) {
      if (fresh.length) await captureFacts(this.db, voice, { utterances: fresh, confirmations: [], extract: false });
      const hasGreeting = msgs.some((m) => m.speaker === "agent");
      return { lines: hasGreeting ? [this.opening.firstQuestion ?? ""] : [this.opening.disclosure, this.opening.firstQuestion ?? ""], endCall: false };
    }

    if (this.phase === "closing") {
      await captureFacts(this.db, voice, { utterances: fresh, confirmations: [], extract: false });
      return { lines: [GOODBYE], endCall: true };
    }

    if (this.phase === "discovery") {
      const confirmations =
        this.lastNext?.kind === "confirm" && this.lastNext.evidence_id && latestCaller && (isAffirmation(latestCaller.text) || isNegation(latestCaller.text))
          ? [{ evidence_id: this.lastNext.evidence_id, confirmed: isAffirmation(latestCaller.text), utterance_seq: latestCaller.seq }]
          : [];
      const cap = await captureFacts(this.db, voice, { utterances: fresh, confirmations, extract: true });
      this.lastNext = cap.next;
      if (cap.next.kind !== "complete") return { lines: cap.say, endCall: false };
      const ev = await evaluateForCall(this.db, voice);
      if (ev.booking_eligible) {
        this.phase = "booking_yesno";
        return { lines: [...cap.say, ...ev.say], endCall: false };
      }
      return this.close([...cap.say, ...ev.say]);
    }

    // Booking phases: record the caller's words without fact extraction.
    await captureFacts(this.db, voice, { utterances: fresh, confirmations: [], extract: false });
    const text = latestCaller?.text ?? "";
    const scripts = this.policy?.config.scripts;

    if (this.phase === "booking_yesno") {
      if (isNegation(text) || DECLINE_RE.test(text)) return this.decline();
      if (!isAffirmation(text) && !/\b(book|consultation|yes|sure|okay|ok)\b/i.test(text)) return { lines: [scripts?.booking_offer ?? CLARIFY], endCall: false };
      const slots = await listSlots(this.db, { staff: null, voice }, {});
      this.offered = (slots.slots as SlotOut[]).slice(0, this.policy?.config.booking.max_slots_offered ?? 3);
      if (!slots.eligible || this.offered.length === 0) return this.close([scripts?.booking_pending ?? FALLBACK_SCRIPT]);
      this.phase = "booking_choose";
      return { lines: [offerLine(this.offered)], endCall: false };
    }

    if (this.phase === "booking_choose") {
      if (DECLINE_RE.test(text) || /^(no|nope)\b/i.test(text.trim())) return this.decline();
      const pick = chooseSlot(text, this.offered);
      if (!pick) return { lines: [`Which of those times works for you: ${this.offered.map((o) => o.label).join(", or ")}?`], endCall: false };
      this.chosen = pick;
      this.phase = "booking_confirm";
      return { lines: [(scripts?.booking_read_back ?? "To confirm, you'd like a consultation on {slot_label}. Shall I book it?").replace("{slot_label}", pick.label)], endCall: false };
    }

    // booking_confirm
    if (isNegation(text)) {
      this.phase = "booking_choose";
      return { lines: [offerLine(this.offered)], endCall: false };
    }
    if (!isAffirmation(text)) return { lines: [`Shall I book ${this.chosen!.label}?`], endCall: false };
    try {
      const res = await createBooking(
        this.db,
        { staff: null, voice },
        voice.leadId!,
        { decision: "book", slot_start: this.chosen!.start, caller_confirmed: true, idempotency_key: `byol-${this.providerCallId}-${this.chosen!.start}`.slice(0, 100) },
        `byol:${this.providerCallId}`,
      );
      // Confirmed only with a provider booking id; otherwise the pending script is spoken.
      return this.close(res.body.say);
    } catch (err) {
      if (err instanceof ApiError && err.code === "slot_unavailable") {
        const details = err.details as { say?: string[]; alternatives?: SlotOut[] };
        this.offered = details.alternatives ?? [];
        if (this.offered.length === 0) return this.close([scripts?.booking_pending ?? FALLBACK_SCRIPT]);
        this.phase = "booking_choose";
        return { lines: [...(details.say ?? []), offerLine(this.offered)], endCall: false };
      }
      const say = err instanceof ApiError ? ((err.details as { say?: string[] } | null)?.say ?? [scripts?.booking_pending ?? FALLBACK_SCRIPT]) : [scripts?.booking_pending ?? FALLBACK_SCRIPT];
      return this.close(say);
    }
  }

  private async decline(): Promise<{ lines: string[]; endCall: boolean }> {
    const res = await createBooking(this.db, { staff: null, voice: this.voice }, this.voice!.leadId!, { decision: "decline", idempotency_key: `byol-decline-${this.providerCallId}`.slice(0, 100), reason: "caller declined on call" }, `byol:${this.providerCallId}`);
    return this.close(res.body.say);
  }

  /** Requests the (after-call) handoff and ends the conversation politely. */
  private async close(lines: string[]): Promise<{ lines: string[]; endCall: boolean }> {
    const ho = await requestHandoff(this.db, this.voice!, {}, `byol:${this.providerCallId}`);
    this.phase = "closing";
    return { lines: [...lines, ...ho.say, GOODBYE], endCall: true };
  }

  /** WebSocket closed: record the last spoken line and mark the call ended (finalisation follows). */
  async finish(reason: string): Promise<void> {
    if (!this.voice) return;
    try {
      if (this.pendingAgent) {
        await captureFacts(this.db, this.voice, { utterances: [{ seq: this.recorded, speaker: "agent", text: this.pendingAgent, spoken_at: now().toISOString() }], confirmations: [], extract: false });
        this.pendingAgent = null;
      }
    } catch (err) {
      log.warn("bridge_final_line_not_recorded", { call_id: this.voice.callId, error: err });
    }
    const ended = now();
    await processVoiceEvent(
      this.db,
      this.provider,
      {
        id: `vaani:${this.providerCallId}:byol_closed`,
        type: "call.completed",
        created: Math.floor(ended.getTime() / 1000),
        data: {
          call_id: this.providerCallId,
          status: "completed",
          ended_at: ended.toISOString(),
          duration_seconds: Math.max(0, Math.round((ended.getTime() - this.startedAt.getTime()) / 1000)),
          end_reason: this.ended ? "agent_completed" : reason,
        },
      },
      { source: "byol_close" },
    );
  }
}

import { z } from "zod";
import { safeEqual } from "@/lib/auth/crypto";
import { env } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { badRequest, unauthorized, unavailable } from "@/lib/http/errors";
import { redact } from "@/lib/log";
import { now } from "@/lib/runtime";
import { processVoiceEvent, type VoiceEvent } from "@/lib/services/calls";

// Vaani AI (app.vaanivoice.ai) call-event webhooks, per docs.vaanivoice.ai/guides/webhook-setup
// (checked 2026-10-10): JSON POSTs with `event` + `room_name`; call_postprocessing nests details
// under `data`. Vaani documents NO signature, so the endpoint is authenticated with a long random
// token in the URL (`?token=VAANI_WEBHOOK_SECRET`) and every event is deduplicated per room+event.
// The room name is the same identifier the BYOL bridge receives as the call id.

const vaaniEventSchema = z
  .object({
    event: z.string().min(1).max(80),
    room_name: z.string().max(200).optional(),
    call_id: z.string().max(200).optional(),
    status: z.string().max(40).optional(),
    phone_number: z.string().max(40).optional(),
    call_duration: z.number().nonnegative().optional(),
    end_reason: z.string().max(120).optional(),
    error: z.string().max(200).optional(),
    data: z
      .object({
        room_name: z.string().max(200).optional(),
        call_duration: z.number().nonnegative().optional(),
        end_reason: z.string().max(120).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type VaaniEvent = z.infer<typeof vaaniEventSchema>;

/** Maps a Vaani event onto the normalised call-event contract. Null = recorded but no call-state change. */
export function mapVaaniEvent(p: VaaniEvent, at: Date): VoiceEvent | null {
  const room = p.room_name ?? p.data?.room_name;
  if (!room) return null;
  const base = { id: `vaani:${room}:${p.event}`, created: Math.floor(at.getTime() / 1000) };
  const iso = at.toISOString();
  const endReason = (p.end_reason ?? p.data?.end_reason)?.slice(0, 60);
  switch (p.event) {
    case "call_started":
      return { ...base, type: "call.status", data: { call_id: room, status: "ringing", from: p.phone_number ?? null, arrived_at: iso } };
    case "user_picked_up_at":
      return { ...base, type: "call.answered", data: { call_id: room, answered_at: iso } };
    case "call_ended":
      return {
        ...base,
        type: "call.completed",
        data: { call_id: room, status: "completed", ended_at: iso, end_reason: endReason, duration_seconds: p.call_duration !== undefined ? Math.round(p.call_duration) : undefined },
      };
    case "call_postprocessing": {
      const ms = p.data?.call_duration ?? p.call_duration;
      return {
        ...base,
        type: "call.completed",
        data: { call_id: room, status: "completed", end_reason: endReason, duration_seconds: ms !== undefined ? Math.round(ms / 1000) : undefined },
      };
    }
    case "call_rejected":
      return { ...base, type: "call.failed", data: { call_id: room, status: "busy", ended_at: iso, end_reason: "rejected" } };
    case "call_no_answer":
      return { ...base, type: "call.failed", data: { call_id: room, status: "no_answer", ended_at: iso, end_reason: "no_answer" } };
    case "call_failed":
      return { ...base, type: "call.failed", data: { call_id: room, status: "failed", ended_at: iso, end_reason: (p.error ?? "failed").slice(0, 60) } };
    default:
      return null; // e.g. human_transfer_*: stored for audit, no state change
  }
}

/** Shared by the Next.js webhook route and the bridge's webhook endpoint. */
export async function handleVaaniWebhook(db: Db, raw: string, token: string | null) {
  const secret = env.vaaniWebhookSecret();
  if (!secret) throw unavailable("webhook_not_configured", "VAANI_WEBHOOK_SECRET is not configured");
  if (!token || !safeEqual(token, secret)) throw unauthorized("Invalid webhook token");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw badRequest("invalid_json", "Webhook body is not valid JSON");
  }
  const parsed = vaaniEventSchema.safeParse(payload);
  if (!parsed.success) throw badRequest("invalid_event", "Expected a Vaani call event with `event` and `room_name`");
  const at = now();
  const mapped = mapVaaniEvent(parsed.data, at);
  if (!mapped) {
    const room = parsed.data.room_name ?? parsed.data.data?.room_name ?? "unknown";
    await db.query(
      `insert into public.provider_events (provider, event_id, event_type, provider_call_id, occurred_at, payload_redacted, processing_status, processed_at)
       values ('vaani', $1, $2, $3, $4, $5, 'processed', $4) on conflict (provider, event_id) do nothing`,
      [`vaani:${room}:${parsed.data.event}`, parsed.data.event, room, at, JSON.stringify(redact(payload))],
    );
    return { accepted: true, mapped: false, event: parsed.data.event };
  }
  const result = await processVoiceEvent(db, "vaani", mapped, payload);
  return { accepted: true, mapped: true, event: parsed.data.event, call_id: result.callId, lead_id: result.leadId, status: result.status, duplicate: result.duplicate, stale: result.stale };
}

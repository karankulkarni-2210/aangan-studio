import { z } from "zod";
import { env } from "@/lib/config/env";
import { VOICE_PROVIDERS, type VoiceProvider } from "@/lib/domain/enums";
import { ApiError, badRequest, notFound, unauthorized, unavailable } from "@/lib/http/errors";
import type { RouteContext } from "@/lib/http/route";
import { redact } from "@/lib/log";
import { verifyVaaniSignature } from "@/lib/providers/vaani";
import { now } from "@/lib/runtime";
import { handleVaaniWebhook } from "@/lib/voice/vaani-events";
import { agentContext, processVoiceEvent, voiceEventSchema } from "./calls";

// Provider-authenticated, deduplicated voice webhooks.
//  * vaani (Vaani AI, app.vaanivoice.ai): unsigned JSON events, authenticated by `?token=` =
//    VAANI_WEBHOOK_SECRET; mapped in src/lib/voice/vaani-events.ts.
//  * simulated: X-Aangan-Signature = "sha256=" + HMAC-SHA256(SIMULATED_VOICE_WEBHOOK_SECRET, raw body).
//    The simulated provider does not exist in live mode.
// Replay protection: event-id dedupe plus an age window on the signed `created` timestamp.

const MAX_EVENT_AGE_S = 24 * 3600;
const envelopeSchema = z.object({ id: z.string().min(1).max(200), type: z.string().min(1).max(80), created: z.number().int() });

export async function handleVoiceWebhook(ctx: RouteContext, endpoint: "incoming" | "status") {
  const provider = ctx.params.provider as VoiceProvider;
  if (!VOICE_PROVIDERS.includes(provider)) throw notFound("Voice provider");
  if (provider === "simulated" && env.appMode() === "live") throw notFound("Voice provider");

  // Vaani AI posts its own (unsigned) event shape to either endpoint; authenticated by URL token.
  if (provider === "vaani") return handleVaaniWebhook(ctx.db, await ctx.rawBody(), ctx.url.searchParams.get("token"));

  const secret = env.simulatedWebhookSecret();
  if (!secret) throw unavailable("webhook_not_configured", "Webhook secret for the simulated provider is not configured");
  const raw = await ctx.rawBody();
  if (!verifyVaaniSignature(raw, ctx.req.headers.get("x-aangan-signature"), secret)) throw unauthorized("Invalid webhook signature");

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw badRequest("invalid_json", "Webhook body is not valid JSON");
  }
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) throw badRequest("invalid_envelope", "Expected { id, type, created, data }");
  const age = now().getTime() / 1000 - envelope.data.created;
  if (age > MAX_EVENT_AGE_S || age < -300) throw new ApiError(400, "event_outside_window", "Event timestamp is outside the accepted window");

  const parsed = voiceEventSchema.safeParse(payload);
  if (!parsed.success) {
    // Signed but unmappable (e.g. an undocumented Vaani `data` shape): keep it, never guess.
    await ctx.db.query(
      `insert into public.provider_events (provider, event_id, event_type, occurred_at, payload_redacted, processing_status, processed_at)
       values ($1, $2, $3, $4, $5, 'failed', $6) on conflict (provider, event_id) do nothing`,
      [provider, envelope.data.id, envelope.data.type, new Date(envelope.data.created * 1000), JSON.stringify(redact(payload)), now()],
    );
    return new Response(JSON.stringify({ accepted: true, mapped: false, reason: "event data did not match the normalised call-event contract" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }
  const event = parsed.data;
  if ((endpoint === "incoming") !== (event.type === "call.incoming")) {
    throw badRequest("wrong_endpoint", endpoint === "incoming" ? "Only call.incoming is accepted here" : "Send call.incoming to /incoming");
  }
  const result = await processVoiceEvent(ctx.db, provider, event, payload);
  if (endpoint === "incoming") return agentContext(result);
  return { call_id: result.callId, lead_id: result.leadId, status: result.status, duplicate: result.duplicate, stale: result.stale };
}

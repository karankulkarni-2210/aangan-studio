import { env } from "@/lib/config/env";
import { hmacHex, safeEqual } from "@/lib/auth/crypto";

// Vaani AI (app.vaanivoice.ai; docs.vaanivoice.ai, checked 2026-10-10).
//  * REST: https://api.vaanivoice.ai, header `X-API-Key: vaani_…` (agents, trigger-call,
//    call-history, transcript/{call_id}, call_details/{call_id}).
//  * Live conversation: "Bring Your Own LLM" WebSocket. Vaani opens <ws_url>/<call_id> per call
//    and sends `response_required` turns; our bridge (src/bridge/server.ts) replies with
//    server-approved speech. See src/lib/voice/conversation.ts.
//  * Call events: unsigned webhooks (see src/lib/voice/vaani-events.ts).
//
// The HMAC helpers below sign the SIMULATED provider's webhooks (header X-Aangan-Signature).

export function verifyVaaniSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  return safeEqual(m[1].toLowerCase(), hmacHex(secret, rawBody));
}

export function signVaaniBody(rawBody: string, secret: string): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

/** Read-only: call details (transcript, entities, evaluation) for reconciliation or review. */
export async function getVaaniCallDetails(callId: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const cfg = env.vaani();
  if (!cfg.apiKey) throw new Error("VAANI_API_KEY is not configured");
  const res = await fetchImpl(`${cfg.baseUrl}/api/call_details/${encodeURIComponent(callId)}`, {
    headers: { "X-API-Key": cfg.apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Vaani call_details HTTP ${res.status}`);
  return res.json();
}

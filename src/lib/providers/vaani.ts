import { env } from "@/lib/config/env";
import { hmacHex, safeEqual } from "@/lib/auth/crypto";

// Vaani Labs. Verified against vaanilabs.in/docs on 2026-10-07 (OpenAPI v1):
//  * Public API: browser voice sessions (POST /api/public/v1/voicebot/session -> ws_url, ws_token).
//    Agents/flows are configured in the Vaani dashboard; the API has NO documented server-side
//    tool/function calling and NO documented inbound telephony or phone-number routing.
//  * Webhooks: call.completed, call.failed, meeting.ended, lead.created, usage.charged.
//    Envelope { id: "evt_...", type, created (unix s), data }. The shape of `data` is not documented.
//    Signature header X-VaaniVoice-Signature: "sha256=" + hex(HMAC-SHA256(secret, raw body)).
//    No timestamp is signed; replay protection relies on event-id dedupe plus a `created` age check.
// Consequently the live voice -> business-tool loop is a documented GAP: the tool endpoints are
// exercised by the simulated provider until Vaani exposes tool calls or a bridge is built.

export function verifyVaaniSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  return safeEqual(m[1].toLowerCase(), hmacHex(secret, rawBody));
}

export function signVaaniBody(rawBody: string, secret: string): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

/** Mints a short-lived browser voice session (5-minute token). Not used by the phone path. */
export async function createVoicebotSession(fetchImpl: typeof fetch = fetch): Promise<{ ws_url: string; expires_at: unknown }> {
  const cfg = env.vaani();
  if (!cfg.apiKey) throw new Error("VAANI_API_KEY is not configured");
  const res = await fetchImpl(`${cfg.baseUrl}/api/public/v1/voicebot/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(cfg.flowId ? { flow_id: cfg.flowId } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Vaani session HTTP ${res.status}`);
  return (await res.json()) as { ws_url: string; expires_at: unknown };
}

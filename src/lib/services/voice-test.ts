import { env } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { ApiError } from "@/lib/http/errors";
import { getActivePolicy } from "./policies";

// Starts an in-browser Vaani WebRTC session with the studio's agent (demo mode only). The session
// is marked as a website test in its metadata, so the bridge records it as a simulated call:
// it never creates real calendar bookings, CRM deals or emails.

export async function startVoiceTest(db: Db) {
  if (env.appMode() !== "demo") throw new ApiError(404, "demo_unavailable", "The live voice test is only available in the demo");
  const cfg = env.vaani();
  const agentId = process.env.VAANI_AGENT_ID?.trim();
  if (!cfg.apiKey || !agentId) throw new ApiError(503, "voice_test_not_configured", "The live voice test is not configured on this deployment");

  // The agent's replies come from our voice bridge; if it is offline, say so before starting a call.
  const health = process.env.BRIDGE_HEALTH_URL?.trim();
  if (health) {
    const up = await fetch(health, { signal: AbortSignal.timeout(4000), cache: "no-store" }).then((r) => r.ok, () => false);
    if (!up) throw new ApiError(503, "voice_bridge_offline", "The live voice assistant is offline right now. Try a sample enquiry instead, or try again later.");
  }

  const policy = await db.tx((tx) => getActivePolicy(tx));
  const body = {
    agent_id: agentId,
    medium: "webrtc",
    metadata: { aangan_test: true, source: "website" },
    primary_language: "en",
    welcome_message: policy?.config.scripts.disclosure ?? "Hello, you've reached Aangan Studio.",
    welcome_interruptible: true,
    bg_noise_enabled: false,
  };
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/trigger-call/`, {
      method: "POST",
      headers: { "X-API-Key": cfg.apiKey, "X-Agent-Id": agentId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(502, "voice_provider_unavailable", "Vaani could not be reached. Try again in a moment.");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const out = (json.output as Record<string, unknown> | undefined) ?? json;
  if (!res.ok || typeof out.token !== "string" || typeof out.connection_url !== "string") {
    throw new ApiError(502, "voice_provider_failed", `Vaani did not start the session (HTTP ${res.status})`);
  }
  return { token: out.token, connection_url: out.connection_url, room_name: typeof out.room_name === "string" ? out.room_name : null, simulated: true as const };
}

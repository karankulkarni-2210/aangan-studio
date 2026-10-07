import { randomUUID } from "node:crypto";
import * as captureRoute from "@/app/internal/voice/tools/capture-facts/route";
import * as incomingRoute from "@/app/webhooks/voice/[provider]/incoming/route";
import * as statusRoute from "@/app/webhooks/voice/[provider]/status/route";
import { signVaaniBody } from "@/lib/providers/vaani";
import { now } from "@/lib/runtime";
import { call } from "./http";

export function signedWebhook(handler: unknown, path: string, event: unknown, opts: { secret?: string; provider?: string; header?: string } = {}) {
  const raw = JSON.stringify(event);
  const provider = opts.provider ?? "simulated";
  const secret = opts.secret ?? process.env.SIMULATED_VOICE_WEBHOOK_SECRET!;
  const header = opts.header ?? (provider === "vaani" ? "x-vaanivoice-signature" : "x-aangan-signature");
  return call(handler, "POST", path, { raw, headers: { [header]: signVaaniBody(raw, secret) }, params: { provider } });
}

export function incomingEvent(providerCallId: string, extra: Record<string, unknown> = {}, at: Date = now()) {
  return {
    id: `evt_${providerCallId}_in`,
    type: "call.incoming",
    created: Math.floor(at.getTime() / 1000),
    data: { call_id: providerCallId, from: "+919000009999", to: "+912000000000", arrived_at: at.toISOString(), answered_at: at.toISOString(), ...extra },
  };
}

export function endedEvent(providerCallId: string, extra: Record<string, unknown> = {}, at: Date = now()) {
  return {
    id: `evt_${providerCallId}_end`,
    type: "call.completed",
    created: Math.floor(at.getTime() / 1000),
    data: { call_id: providerCallId, status: "completed", ended_at: at.toISOString(), duration_seconds: 95, end_reason: "agent_completed", ...extra },
  };
}

/** Starts a simulated call and returns the call-bound tool headers. */
export async function startCall(opts: { scenario?: string; from?: string } = {}) {
  const pcid = `test-${randomUUID().slice(0, 8)}`;
  const res = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", incomingEvent(pcid, { simulation_scenario: opts.scenario, from: opts.from ?? "+919000009999" }));
  if (res.status !== 200) throw new Error(`incoming failed ${res.status} ${JSON.stringify(res.body)}`);
  const headers = {
    authorization: `Bearer ${process.env.VOICE_TOOL_SECRET}`,
    "x-aangan-call-id": res.body.call_id,
    "x-aangan-call-token": res.body.tool_session.call_token,
  };
  let seq = 0;
  return {
    providerCallId: pcid,
    callId: res.body.call_id as string,
    leadId: res.body.lead_id as string,
    headers,
    incoming: res.body,
    /** Agent line + caller line through capture-facts. */
    async say(callerText: string, agentText = "Could you tell me more?", extra: Record<string, unknown> = {}) {
      const a = seq++;
      const c = seq++;
      return call(captureRoute.POST, "POST", "/internal/voice/tools/capture-facts", {
        body: { utterances: [{ seq: a, speaker: "agent", text: agentText }, { seq: c, speaker: "caller", text: callerText }], ...extra },
        headers,
      });
    },
    nextSeq: () => seq,
    async end(extra: Record<string, unknown> = {}) {
      return signedWebhook(statusRoute.POST, "/webhooks/voice/simulated/status", endedEvent(pcid, extra));
    },
  };
}

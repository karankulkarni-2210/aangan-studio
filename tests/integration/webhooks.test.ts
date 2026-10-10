import { beforeEach, describe, expect, it } from "vitest";
import * as incomingRoute from "@/app/webhooks/voice/[provider]/incoming/route";
import * as statusRoute from "@/app/webhooks/voice/[provider]/status/route";
import type { Db } from "@/lib/db/types";
import { consumeRateLimit } from "@/lib/http/route";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";
import { endedEvent, incomingEvent, signedWebhook } from "../helpers/voice";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("voice webhooks", () => {
  it("rejects a bad signature", async () => {
    const res = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", incomingEvent("bad-sig"), { secret: "wrong-secret-wrong-secret-wrong-secret" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "unauthorized", request_id: expect.any(String) });
  });

  it("rejects an unsigned request and an unknown provider", async () => {
    const res = await call(incomingRoute.POST, "POST", "/webhooks/voice/simulated/incoming", { body: incomingEvent("unsigned"), params: { provider: "simulated" } });
    expect(res.status).toBe(401);
    const other = await signedWebhook(incomingRoute.POST, "/webhooks/voice/twilio/incoming", incomingEvent("x"), { provider: "twilio" });
    expect(other.status).toBe(404);
  });

  it("deduplicates retried events (one provider event, one call, same tool token)", async () => {
    const ev = incomingEvent("dup-1");
    const a = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", ev);
    const b = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", ev);
    expect(a.status).toBe(200);
    expect(b.body).toMatchObject({ call_id: a.body.call_id, duplicate: true });
    expect(b.body.tool_session.call_token).toBe(a.body.tool_session.call_token);
    const { rows } = await db.query(`select (select count(*)::int from public.provider_events) as events, (select count(*)::int from public.calls) as calls, (select count(*)::int from public.leads) as leads`);
    expect(rows[0]).toEqual({ events: 1, calls: 1, leads: 1 });
  });

  it("out-of-order events never regress a completed call", async () => {
    const end = await signedWebhook(statusRoute.POST, "/webhooks/voice/simulated/status", endedEvent("ooo-1"));
    expect(end.body.status).toBe("completed");
    const late = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", incomingEvent("ooo-1"));
    expect(late.status).toBe(200);
    const answered = await signedWebhook(statusRoute.POST, "/webhooks/voice/simulated/status", { id: "evt_ooo_ans", type: "call.answered", created: Math.floor(Date.now() / 1000), data: { call_id: "ooo-1" } });
    expect(answered.body).toMatchObject({ status: "completed", stale: true });
    const { rows } = await db.query(`select status, arrived_at is not null as has_arrival from public.calls where provider_call_id = 'ooo-1'`);
    expect(rows[0]).toEqual({ status: "completed", has_arrival: true });
    const { rows: ev } = await db.query(`select processing_status from public.provider_events where event_id = 'evt_ooo_ans'`);
    expect(ev[0].processing_status).toBe("ignored_stale");
  });

  it("rejects events outside the replay window", async () => {
    const old = incomingEvent("old-1", {}, new Date(Date.now() - 3 * 86400000));
    const res = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", old);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("event_outside_window");
  });

  it("Vaani AI events need the URL token; unknown events are stored without changing state", async () => {
    process.env.VAANI_WEBHOOK_SECRET = "v".repeat(48);
    const post = (token: string, body: unknown) =>
      call(statusRoute.POST, "POST", `/webhooks/voice/vaani/status?token=${token}`, { body, params: { provider: "vaani" } });
    expect((await post("wrong", { event: "call_started", room_name: "room-1" })).status).toBe(401);
    const started = await post("v".repeat(48), { event: "call_started", room_name: "room-1", status: "dialing", phone_number: "+919000001111" });
    expect(started.body).toMatchObject({ accepted: true, mapped: true, status: "ringing" });
    const transfer = await post("v".repeat(48), { event: "human_transfer_initiated", room_name: "room-1", transfer_type: "warm" });
    expect(transfer.body).toMatchObject({ accepted: true, mapped: false });
    const ended = await post("v".repeat(48), { event: "call_ended", room_name: "room-1", call_duration: 42.5, end_reason: "user_hangup" });
    expect(ended.body).toMatchObject({ mapped: true, status: "completed" });
    const again = await post("v".repeat(48), { event: "call_ended", room_name: "room-1", call_duration: 42.5 });
    expect(again.body.duplicate).toBe(true);
    const { rows } = await db.query(`select status, from_number, duration_seconds from public.calls where provider_call_id = 'room-1'`);
    expect(rows[0]).toEqual({ status: "completed", from_number: "+919000001111", duration_seconds: 43 });
  });

  it("enforces the body-size limit", async () => {
    const huge = { ...incomingEvent("big-1"), padding: "x".repeat(40 * 1024) };
    const res = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", huge);
    expect(res.status).toBe(413);
  });

  it("rate-limits per principal with Retry-After", async () => {
    await consumeRateLimit(db, "test-key", 2);
    await consumeRateLimit(db, "test-key", 2);
    await expect(consumeRateLimit(db, "test-key", 2)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("the simulated provider does not exist in live mode", async () => {
    process.env.APP_MODE = "live";
    const res = await signedWebhook(incomingRoute.POST, "/webhooks/voice/simulated/incoming", incomingEvent("live-1"));
    // Live mode without full configuration fails closed before routing.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("configuration_incomplete");
  });
});

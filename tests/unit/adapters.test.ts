import { beforeEach, describe, expect, it } from "vitest";
import { runExtraction } from "@/lib/ai/extractor";
import { createGeminiExtractor, GeminiError } from "@/lib/ai/gemini";
import { createCalcomAdapter } from "@/lib/providers/calcom";
import { createHubspotAdapter } from "@/lib/providers/hubspot";
import { createResendAdapter } from "@/lib/providers/resend";
import { signVaaniBody, verifyVaaniSignature } from "@/lib/providers/vaani";
import { configureTestEnv } from "../helpers/env";

// Live adapters exercised against a stubbed fetch: request shape, headers, versions and error
// mapping. No network access and no real credentials.

type Captured = { url: string; init: RequestInit };
function stub(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const header = (c: Captured, name: string) => new Headers(c.init.headers).get(name);
const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

beforeEach(() => {
  configureTestEnv();
  Object.assign(process.env, {
    CALCOM_API_KEY: "cal_test_x", CALCOM_EVENT_TYPE_ID: "4242",
    HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PIPELINE_ID: "default", HUBSPOT_DEALSTAGE_ID: "appointmentscheduled",
    RESEND_API_KEY: "re_test", RESEND_FROM: "Aangan Demo <leads@aangan-demo.example>",
    GEMINI_API_KEY: "test-gemini-key",
  });
});

describe("Cal.com adapter", () => {
  it("pins per-endpoint API versions and maps slots", async () => {
    const s = stub([{ status: 200, body: { status: "success", data: { "2026-10-08": [{ start: "2026-10-08T11:00:00.000+05:30", end: "2026-10-08T11:45:00.000+05:30" }] } } }]);
    const r = await createCalcomAdapter(s.fetchImpl).getSlots({ start: new Date("2026-10-08T00:00:00Z"), end: new Date("2026-10-09T00:00:00Z"), durationMinutes: 45, timeZone: "Asia/Kolkata" });
    expect(header(s.calls[0], "cal-api-version")).toBe("2024-09-04");
    expect(s.calls[0].url).toContain("eventTypeId=4242");
    expect(r).toEqual({ status: "ok", data: [{ start: "2026-10-08T05:30:00.000Z", end: "2026-10-08T06:15:00.000Z" }] });
  });

  it("creates bookings with our reconciliation key and only accepts `accepted`", async () => {
    const s = stub([{ status: 201, body: { status: "success", data: { uid: "bk_1", status: "accepted" } } }, { status: 201, body: { status: "success", data: { uid: "bk_2", status: "pending" } } }]);
    const cal = createCalcomAdapter(s.fetchImpl);
    const req = { start: "2026-10-08T05:30:00.000Z", durationMinutes: 45, timeZone: "Asia/Kolkata", attendee: { name: "Demo Caller", email: null, phone: "+919000000101" }, bookingKey: "key-1", metadata: { aangan_lead_id: "L1" } };
    expect(await cal.createBooking(req)).toEqual({ status: "ok", data: { uid: "bk_1" } });
    expect(header(s.calls[0], "cal-api-version")).toBe("2026-02-25");
    const body = JSON.parse(String(s.calls[0].init.body));
    expect(body).toMatchObject({ eventTypeId: 4242, attendee: { name: "Demo Caller", phoneNumber: "+919000000101" }, metadata: { aangan_booking_key: "key-1" } });
    expect(body.attendee.email).toBeUndefined();
    expect((await cal.createBooking(req)).status).toBe("failed");
  });

  it("maps unavailability to conflict, and timeouts/5xx to ambiguous", async () => {
    const s = stub([{ status: 400, body: { error: { message: "no_available_users_found_error" } } }, timeout(), { status: 503, body: {} }]);
    const cal = createCalcomAdapter(s.fetchImpl);
    const req = { start: "x", durationMinutes: 45, timeZone: "Asia/Kolkata", attendee: { name: "n", email: null, phone: null }, bookingKey: "k", metadata: {} };
    expect((await cal.createBooking(req)).status).toBe("conflict");
    expect((await cal.createBooking(req)).status).toBe("ambiguous");
    expect((await cal.createBooking(req)).status).toBe("ambiguous");
  });

  it("reconciles by listing bookings and matching metadata", async () => {
    const s = stub([{ status: 200, body: { data: [{ uid: "other", metadata: { aangan_booking_key: "nope" } }, { uid: "mine", status: "accepted", metadata: { aangan_booking_key: "key-9" } }] } }]);
    const r = await createCalcomAdapter(s.fetchImpl).findBooking({ bookingKey: "key-9", start: "2026-10-08T05:30:00.000Z", attendeeName: "Demo Caller", attendeeEmail: null });
    expect(header(s.calls[0], "cal-api-version")).toBe("2026-05-01");
    expect(s.calls[0].url).toContain("attendeeName=Demo+Caller");
    expect(r).toEqual({ status: "ok", data: { uid: "mine" } });
  });
});

describe("HubSpot adapter", () => {
  it("matches an existing contact before creating one", async () => {
    const s = stub([{ status: 200, body: { results: [{ id: "77" }] } }]);
    const r = await createHubspotAdapter(s.fetchImpl).upsertContact({ name: "Demo Caller", phone: "+919000000101", email: null, leadId: "L1" });
    expect(r).toEqual({ status: "ok", data: { id: "77", created: false } });
    expect(JSON.parse(String(s.calls[0].init.body)).filterGroups[0].filters[0]).toEqual({ propertyName: "phone", operator: "EQ", value: "+919000000101" });
  });

  it("recovers the id from a duplicate-contact 409", async () => {
    const s = stub([{ status: 200, body: { results: [] } }, { status: 409, body: { message: "Contact already exists. Existing ID: 991" } }]);
    const r = await createHubspotAdapter(s.fetchImpl).upsertContact({ name: null, phone: null, email: "a@example.com", leadId: "L1" });
    expect(r).toEqual({ status: "ok", data: { id: "991", created: false } });
  });

  it("upserts one deal per lead on the unique property and associates the contact", async () => {
    const s = stub([{ status: 200, body: { results: [{ id: "555", new: true }] } }, { status: 200, body: {} }]);
    const r = await createHubspotAdapter(s.fetchImpl).upsertDeal({ leadId: "lead-uuid", dealName: "AGN-1001", contactId: "77", description: "d" });
    expect(r).toEqual({ status: "ok", data: { id: "555", created: true } });
    expect(s.calls[0].url).toMatch(/\/crm\/v3\/objects\/deals\/batch\/upsert$/);
    expect(JSON.parse(String(s.calls[0].init.body)).inputs[0]).toMatchObject({ id: "lead-uuid", idProperty: "aangan_lead_id", properties: { pipeline: "default", dealstage: "appointmentscheduled" } });
    expect(s.calls[1]).toMatchObject({ url: expect.stringMatching(/\/crm\/v4\/objects\/deals\/555\/associations\/default\/contacts\/77$/), init: expect.objectContaining({ method: "PUT" }) });
  });

  it("treats a timed-out write as ambiguous", async () => {
    const s = stub([timeout()]);
    expect((await createHubspotAdapter(s.fetchImpl).upsertDeal({ leadId: "l", dealName: "d", contactId: "c", description: "" })).status).toBe("ambiguous");
  });
});

describe("Resend adapter", () => {
  it("sends with Idempotency-Key and the required User-Agent", async () => {
    const s = stub([{ status: 200, body: { id: "email_1" } }]);
    const r = await createResendAdapter(s.fetchImpl).send({ to: "asha.demo@aangan-demo.example", subject: "s", text: "t", html: "<p>t</p>", idempotencyKey: "handoff/abc", tags: { lead_id: "x-y" } });
    expect(r).toEqual({ status: "ok", data: { id: "email_1" } });
    expect(header(s.calls[0], "idempotency-key")).toBe("handoff/abc");
    expect(header(s.calls[0], "user-agent")).toMatch(/aangan/);
    expect(JSON.parse(String(s.calls[0].init.body))).toMatchObject({ from: "Aangan Demo <leads@aangan-demo.example>", to: ["asha.demo@aangan-demo.example"] });
  });

  it("classifies idempotency conflicts and rate limits", async () => {
    const s = stub([{ status: 409, body: { name: "concurrent_idempotent_requests" } }, { status: 409, body: { name: "invalid_idempotent_request" } }, { status: 429, body: { name: "rate_limit_exceeded" } }]);
    const resend = createResendAdapter(s.fetchImpl);
    const msg = { to: "x@example.com", subject: "s", text: "t", html: "h", idempotencyKey: "k", tags: {} };
    expect(await resend.send(msg)).toMatchObject({ status: "failed", retriable: true });
    expect(await resend.send(msg)).toMatchObject({ status: "failed", retriable: false });
    expect(await resend.send(msg)).toMatchObject({ status: "failed", retriable: true });
  });
});

describe("Gemini extractor", () => {
  const req = { policy: null, utterances: [{ seq: 1, speaker: "caller" as const, text: "We need office interiors in Baner." }], knownFacts: {}, lastPromptedField: null, lastPromptKind: null, scenario: null, turnIndex: 0, now: new Date() };
  const valid = { intent: "new_project", intent_confidence: 0.9, facts: [], requests: [], proposed_route: "continue_discovery", ambiguity_flags: [] };

  it("requests schema-constrained JSON with a configurable model and reads usage", async () => {
    process.env.GEMINI_MODEL = "gemini-3.8-flash";
    const s = stub([{ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(valid) }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120, thoughtsTokenCount: 40 } } }]);
    const run = await createGeminiExtractor(s.fetchImpl).extract(req);
    expect(s.calls[0].url).toContain("/models/gemini-3.8-flash:generateContent");
    expect(header(s.calls[0], "x-goog-api-key")).toBe("test-gemini-key");
    const body = JSON.parse(String(s.calls[0].init.body));
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: expect.objectContaining({ type: "object" }) });
    expect(body.systemInstruction.parts[0].text).toMatch(/untrusted DATA/);
    expect(body.contents[0].parts[0].text).toContain("<transcript_data>");
    expect(run).toMatchObject({ mode: "live", extractor: "gemini-3.8-flash", usage: { inputTokens: 900, outputTokens: 120, thinkingTokens: 40, estimated: false } });
  });

  it("rejects schema-invalid output", async () => {
    const s = stub([{ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: "buy_now", facts: "all" }) }] } }] } }]);
    await expect(createGeminiExtractor(s.fetchImpl).extract(req)).rejects.toBeInstanceOf(GeminiError);
  });

  it("falls back to the heuristic extractor and flags the run as degraded", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw timeout();
    }) as typeof fetch;
    try {
      const run = await runExtraction(req, { simulated: false });
      expect(run).toMatchObject({ extractor: "heuristic", degraded: true, mode: "mock" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Vaani webhook signature", () => {
  it("verifies sha256=<hex HMAC of raw body> in constant time", () => {
    const body = JSON.stringify({ id: "evt_1", type: "call.completed", created: 1, data: {} });
    const sig = signVaaniBody(body, "secret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyVaaniSignature(body, sig, "secret")).toBe(true);
    expect(verifyVaaniSignature(body + " ", sig, "secret")).toBe(false);
    expect(verifyVaaniSignature(body, "sha256=00", "secret")).toBe(false);
    expect(verifyVaaniSignature(body, null, "secret")).toBe(false);
  });
});

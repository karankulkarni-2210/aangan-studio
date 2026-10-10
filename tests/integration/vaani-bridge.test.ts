import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startBridge, type Bridge } from "@/bridge/server";
import type { Db } from "@/lib/db/types";
import { inspectSpeech } from "@/lib/domain/speech-guard";
import { runDispatcher } from "@/lib/jobs/handlers";
import { chooseSlot } from "@/lib/voice/conversation";
import { createTestDb } from "../helpers/db";

const TOKEN = "b".repeat(48);
let db: Db;
let bridge: Bridge;

beforeEach(async () => {
  db = await createTestDb();
  process.env.VAANI_BYOL_TOKEN = TOKEN;
  process.env.VAANI_WEBHOOK_SECRET = "w".repeat(48);
  bridge = await startBridge({ port: 0, db, runDispatcher: false });
});
afterEach(async () => bridge.close());

type Frame = Record<string, unknown>;

/** Minimal Vaani BYOL client: sends response_required turns with the growing transcript. */
async function connect(callId: string, token = TOKEN) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/vaani/byol/${callId}`, { headers: { authorization: `Bearer ${token}` } });
  const frames: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w && f.response_type === "response") w(f);
    else frames.push(f);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
  const transcript: Array<{ role: string; content: string }> = [{ role: "system", content: "Vaani agent system prompt" }];
  let id = 0;
  return {
    frames,
    transcript,
    async say(caller: string | null): Promise<{ content: string; end_call?: boolean }> {
      if (caller) transcript.push({ role: "user", content: caller });
      const reply = new Promise<Frame>((resolve) => waiters.push(resolve));
      ws.send(JSON.stringify({ interaction_type: "response_required", response_id: ++id, call_id: callId, transcript, req_body: null }));
      const f = await reply;
      expect(f.response_id).toBe(id);
      transcript.push({ role: "assistant", content: String(f.content) });
      return f as { content: string; end_call?: boolean };
    },
    close: () => new Promise<void>((resolve) => { ws.once("close", () => resolve()); ws.close(); }),
  };
}

const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};

describe("Vaani BYOL bridge", () => {
  it("rejects connections without the BYOL token", async () => {
    await expect(connect("room-x", "wrong")).rejects.toThrow(/401/);
  });

  it("accepts Vaani's Test Connection on the bare URL without recording anything", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/vaani/byol`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [] }));
    await waitFor(async () => frames.some((f) => f.response_type === "response"));
    expect(frames.map((f) => f.interaction_type ?? f.response_type)).toEqual(["config", "greeting", "response"]);
    ws.close();
    const { rows } = await db.query(`select count(*)::int as n from public.calls`);
    expect(rows[0].n).toBe(0);
  });

  it("takes the caller's correction instead of asking the same question again", async () => {
    const c = await connect("room-correct");
    await c.say(null);
    await c.say("We need full home interiors for our flat in Baner.");
    await c.say("It's about 1,200 square feet, carpet area.");
    // Correcting the read-back replaces the earlier figure and reads the new one back.
    expect((await c.say("No, it is 1,500 square feet, carpet area.")).content).toMatch(/Just to confirm, that is about 1,500 square feet/);
    expect((await c.say("Yes.")).content).toMatch(/When would you need the project complete/);
    expect((await c.say("We'd like it all done in about four months.")).content).toMatch(/your name/);
    // Two different names in one turn: the caller corrected themselves, so the latest one is kept.
    c.transcript.push({ role: "user", content: "My name is Rittik." });
    const r = await c.say("No, my name is Hrithik.");
    expect(r.content).not.toMatch(/two different answers/);
    expect(r.content).toMatch(/good time .* call you back/);
    await c.close();
    const { rows } = await db.query(
      `select e.field, e.value from public.field_evidence e join public.calls c on c.lead_id = e.lead_id
        where c.provider_call_id = 'room-correct' and e.field in ('contact_name', 'area') and e.confirmation_status not in ('superseded', 'rejected')`,
    );
    expect(rows.filter((x) => x.field === "contact_name").map((x) => x.value.text)).toEqual(["Hrithik"]);
    expect(rows.filter((x) => x.field === "area").every((x) => x.value.sqft === 1500)).toBe(true);
  });

  it("runs a real (non-simulated) call end to end: discovery, qualification, booking, handoff", async () => {
    const c = await connect("room-happy");
    expect(c.frames.map((f) => f.interaction_type)).toEqual(["config", "greeting"]);
    const lines: string[] = [];
    const turn = async (text: string | null) => {
      const r = await c.say(text);
      lines.push(r.content);
      return r;
    };
    expect((await turn(null)).content).toMatch(/automated assistant.*What are you looking to do/);
    expect((await turn("We need full home interiors for our flat in Baner.")).content).toMatch(/how large is the space/);
    expect((await turn("It's about 1,200 square feet, carpet area.")).content).toMatch(/Just to confirm, that is about 1,200 square feet, carpet area/);
    expect((await turn("Yes, that's right.")).content).toMatch(/When would you need the project complete/);
    expect((await turn("We'd like it all done in about four months. Our budget is around 15 lakh.")).content).toMatch(/your name/);
    expect((await turn("My name is Ananya Joshi.")).content).toMatch(/good time .* call you back/);
    expect((await turn("Weekday evenings after six.")).content).toMatch(/book a consultation/);
    expect((await turn("Yes please.")).content).toMatch(/^I can offer .+\. Which works best for you\?$/);
    expect((await turn("The first one works.")).content).toMatch(/^To confirm, you'd like a consultation on .+\. Shall I book it\?$/);
    const last = await turn("Yes, please book it.");
    expect(last.content).toMatch(/Your consultation is booked for .+Goodbye\.$/);
    expect(last.end_call).toBe(true);
    for (const l of lines) expect(inspectSpeech(l).blocked, l).toBe(false);

    await c.close();
    await waitFor(async () => (await db.query(`select status from public.calls where provider_call_id = 'room-happy'`)).rows[0]?.status === "completed");
    await runDispatcher(db, { trigger: "test" });
    const { rows } = await db.query(
      `select l.is_simulated, l.qualification_status, l.discovery_status, l.booking_status, l.handoff_status, c.provider
         from public.leads l join public.calls c on c.lead_id = l.id where c.provider_call_id = 'room-happy'`,
    );
    expect(rows[0]).toEqual({ is_simulated: false, qualification_status: "qualified", discovery_status: "complete", booking_status: "confirmed", handoff_status: "sent", provider: "vaani" });
    const { rows: utt } = await db.query(`select count(*)::int as n from public.utterances u join public.calls c on c.id = u.call_id where c.provider_call_id = 'room-happy'`);
    expect(utt[0].n).toBe(c.transcript.length - 1); // every caller and agent line recorded (system prompt excluded)
  });

  it("answers a price question with the approved script and a human task, never a price", async () => {
    const c = await connect("room-price");
    await c.say(null);
    const r = await c.say("How much do you charge per square foot for a 2BHK?");
    expect(r.content).toMatch(/Pricing depends on the site, the materials you choose, and the scope/);
    expect(inspectSpeech(r.content).blocked).toBe(false);
    const { rows } = await db.query(`select t.kind from public.human_tasks t join public.calls c on c.lead_id = t.lead_id where c.provider_call_id = 'room-price'`);
    expect(rows.map((x) => x.kind)).toContain("pricing_request");
    await c.close();
  });

  it("accepts Vaani call events on the bridge webhook with the URL token", async () => {
    const url = (t: string) => `http://127.0.0.1:${bridge.port}/vaani/webhook?token=${t}`;
    const post = (t: string, body: unknown) => fetch(url(t), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("nope", { event: "call_started", room_name: "room-w" })).status).toBe(401);
    const ok = await post("w".repeat(48), { event: "call_started", room_name: "room-w", phone_number: "+919000002222" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ mapped: true, status: "ringing" });
    expect((await fetch(`http://127.0.0.1:${bridge.port}/health`)).status).toBe(200);
  });
});

describe("slot choice from caller speech", () => {
  const slots = [
    { start: "2026-10-12T05:30:00.000Z", end: "", label: "Monday, 12 October at 11:00 am" },
    { start: "2026-10-12T09:00:00.000Z", end: "", label: "Monday, 12 October at 2:30 pm" },
    { start: "2026-10-13T05:30:00.000Z", end: "", label: "Tuesday, 13 October at 11:00 am" },
  ];
  it.each([
    ["The first one works.", 0],
    ["second please", 1],
    ["2:30 is good", 1],
    ["Tuesday at eleven", 2],
    ["the last one", 2],
  ])("%s", (text, idx) => {
    expect(chooseSlot(text, slots)).toBe(slots[idx as number]);
  });
  it("asks again when the choice is ambiguous", () => {
    expect(chooseSlot("eleven", slots)).toBeNull();
    expect(chooseSlot("hmm, not sure", slots)).toBeNull();
  });
});

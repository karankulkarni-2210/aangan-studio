"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { describeError, type DemoScenarioList, type LeadDetail, type SimulationResult } from "./api";
import { Chip, Dialog, ErrorState, Icon, Skeleton, StatusChip, useResource, useToast } from "./components";
import { CRM, DELIVERY, LEAD_BOOKING, QUAL } from "./format";
import { useSession } from "./session";
import { DEMO_PERSONAS } from "./shell";

// "Try a sample enquiry": runs one of the backend's simulated calls end to end (saved lead,
// qualification, consultation, CRM/email in mock mode, designer handoff). Always labelled
// "Simulated call"; simulated leads never reach live providers.

const FEATURED = ["suitable_home", "missing_budget", "unsupported_construction", "price_only", "interrupted_call"];
const FRIENDLY: Record<string, string> = {
  suitable_home: "Suitable home-interior enquiry",
  missing_budget: "Missing-budget enquiry",
  unsupported_construction: "Unsupported-service enquiry",
  price_only: "Pricing request",
  interrupted_call: "Interrupted call",
};

export function SampleEnquiryButton({ onDone }: { onDone?: () => void }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  if (!me || me.app_mode !== "demo") return null;
  const allowed = me.role === "admin" || me.role === "front_desk";
  return (
    <>
      <button type="button" className="btn primary lg" onClick={() => setOpen(true)} disabled={!allowed} title={allowed ? undefined : "Switch to Founder or Front desk to run a sample enquiry"}>
        <Icon name="phone" /> Try a sample enquiry
      </button>
      <SampleEnquiryDialog open={open} onClose={() => setOpen(false)} onDone={onDone} />
    </>
  );
}

function SampleEnquiryDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const scenarios = useResource(open ? () => api<DemoScenarioList>("/api/v1/demo/calls").then((r) => r.data) : null, [open]);
  const [choice, setChoice] = useState("suitable_home");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ sim: SimulationResult; lead: LeadDetail | null } | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const { data: sim } = await api<SimulationResult>("/api/v1/demo/calls", { method: "POST", body: { scenario: choice, run_jobs: true } });
      const lead = sim.lead_id ? (await api<LeadDetail>(`/api/v1/leads/${sim.lead_id}`)).data : null;
      setResult({ sim, lead });
      toast("Simulated call finished and saved.");
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  };
  const close = () => {
    setResult(null);
    setError(null);
    onClose();
  };

  const list = scenarios.data?.data ?? [];
  const featured = FEATURED.map((id) => list.find((s) => s.id === id)).filter(Boolean) as DemoScenarioList["data"];
  const others = list.filter((s) => !FEATURED.includes(s.id));

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={result ? "Simulated call complete" : "Try a sample enquiry"}
      subtitle={
        <>
          <Chip tone="terra">Simulated call</Chip> Runs the real backend workflow with a scripted caller. Nothing is sent to real customers, calendars or CRM, and it does not show that live phone answering has been verified.
        </>
      }
      footer={
        result ? (
          <>
            <button type="button" className="btn" onClick={() => setResult(null)}>Run another</button>
            {result.sim.lead_id ? (
              <Link className="btn primary" href={`/enquiries/${result.sim.lead_id}`} onClick={close}>
                Open the saved lead <Icon name="arrow" size={16} />
              </Link>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn primary" onClick={run} disabled={running || !list.length}>
              {running ? "Running simulated call…" : "Run simulated call"}
            </button>
          </>
        )
      }
    >
      {error ? <div style={{ marginBottom: 12 }}><ErrorState error={error} /></div> : null}
      {result ? (
        <SimulationSummary sim={result.sim} lead={result.lead} />
      ) : scenarios.loading ? (
        <div className="stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={64} />)}</div>
      ) : scenarios.error ? (
        <ErrorState error={scenarios.error} onRetry={scenarios.reload} />
      ) : (
        <div className="stack">
        <LiveVoiceTest />
        <div className="small muted" style={{ marginTop: 4 }}>Or run a scripted caller:</div>
        <div className="stack" role="radiogroup" aria-label="Sample enquiry">
          {featured.map((s) => (
            <ScenarioOption key={s.id} s={s} title={FRIENDLY[s.id] ?? s.title} selected={choice === s.id} onSelect={() => setChoice(s.id)} />
          ))}
          {others.length ? (
            <details className="disclosure">
              <summary>More scenarios ({others.length})</summary>
              <div className="stack" style={{ marginTop: 10 }}>
                {others.map((s) => (
                  <ScenarioOption key={s.id} s={s} title={s.title} selected={choice === s.id} onSelect={() => setChoice(s.id)} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
        </div>
      )}
    </Dialog>
  );
}

/** Live in-browser voice call with the real assistant (Vaani WebRTC), recorded as a test call. */
function LiveVoiceTest() {
  const { api } = useSession();
  const [state, setState] = useState<"idle" | "connecting" | "live" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [leadId, setLeadId] = useState<string | null>(null);
  const room = useRef<{ disconnect: () => Promise<void> } | null>(null);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (state !== "live") return;
    const t = setInterval(() => setSeconds(Math.round((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [state]);
  useEffect(() => () => void room.current?.disconnect(), []);

  const findLead = async () => {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const { data } = await api<{ data: Array<{ id: string; intake_at: string }> }>("/api/v1/leads?simulated=true&page_size=5");
      setLeadId(data.data.find((l) => new Date(l.intake_at).getTime() >= startedAt.current - 60_000)?.id ?? null);
    } catch {
      setLeadId(null);
    }
  };

  const start = async () => {
    setError(null);
    setLeadId(null);
    setState("connecting");
    try {
      const { data } = await api<{ token: string; connection_url: string }>("/api/v1/demo/voice-session", { method: "POST" });
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const r = new Room();
      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.dataset.aanganVoice = "1";
          document.body.appendChild(el);
        }
      });
      r.on(RoomEvent.Disconnected, () => {
        document.querySelectorAll("[data-aangan-voice]").forEach((el) => el.remove());
        room.current = null;
        setState("ended");
        void findLead();
      });
      await r.connect(data.connection_url, data.token);
      await r.localParticipant.setMicrophoneEnabled(true);
      room.current = r;
      startedAt.current = Date.now();
      setSeconds(0);
      setState("live");
    } catch (err) {
      await room.current?.disconnect().catch(() => undefined);
      setState("idle");
      setError((err as Error).name === "NotAllowedError" ? "Microphone access was blocked. Allow the microphone in your browser and try again." : describeError(err).detail);
    }
  };

  return (
    <div className="card stack" style={{ background: "var(--accent-soft)", borderColor: "#cfdcd5", gap: 10 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="metric-icon" style={{ background: "var(--card)" }} aria-hidden="true"><Icon name="phone" /></span>
        <div className="grow">
          <strong style={{ fontWeight: 500 }}>Talk to the assistant (live voice)</strong>
          <div className="small muted">Speak to the real assistant in your browser, as a caller would. It is recorded as a test call: no real bookings, CRM records or emails.</div>
        </div>
      </div>
      {error ? <div className="note bad small" role="alert">{error}</div> : null}
      {state === "live" ? (
        <div className="row wrap between">
          <span className="row small" style={{ gap: 8 }}><span className="chip ok"><span className="dot" aria-hidden="true" />Connected</span> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} · speak now</span>
          <button type="button" className="btn danger sm" onClick={() => void room.current?.disconnect()}>End call</button>
        </div>
      ) : state === "ended" ? (
        <div className="row wrap between">
          <span className="small">Call ended.{leadId ? " The enquiry was saved." : " Saving the enquiry…"}</span>
          <span className="row">
            {leadId ? <Link className="btn sm primary" href={`/enquiries/${leadId}`}>Open the saved lead</Link> : null}
            <button type="button" className="btn sm" onClick={start}>Call again</button>
          </span>
        </div>
      ) : (
        <div>
          <button type="button" className="btn primary" onClick={start} disabled={state === "connecting"}>
            <Icon name="phone" size={18} /> {state === "connecting" ? "Connecting…" : "Start voice call"}
          </button>
          <span className="tiny muted" style={{ marginLeft: 10 }}>Needs your microphone.</span>
        </div>
      )}
    </div>
  );
}

function ScenarioOption({ s, title, selected, onSelect }: { s: { id: string; description: string }; title: string; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} aria-pressed={selected} className="scenario" onClick={onSelect}>
      <span className="metric-icon" style={{ width: 34, height: 34 }} aria-hidden="true"><Icon name="phone" size={17} /></span>
      <span className="grow">
        <strong style={{ fontWeight: 500 }}>{title}</strong>
        <span className="small muted" style={{ display: "block" }}>{s.description}</span>
      </span>
      {selected ? <Icon name="check" size={18} /> : null}
    </button>
  );
}

/** Demo step: sign in as the handoff's recipient and open the lead to accept it. */
function AcceptAs({ leadId, recipient, kind }: { leadId: string; recipient: string | null; kind: string }) {
  const { switchPersona } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const persona = kind === "designer" ? DEMO_PERSONAS.find((p) => p.name && recipient?.includes(p.name)) : DEMO_PERSONAS.find((p) => p.id === "front_desk");
  if (!persona) return null;
  return (
    <div className="note info stack" style={{ gap: 8 }}>
      <span>Next: the handoff is waiting for <strong>{recipient ?? "the front desk"}</strong>. Switch to their view to accept it; the Overview updates with each step.</span>
      <button type="button" className="btn sm" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await switchPersona(persona.id);
          router.push(`/enquiries/${leadId}`);
        } finally {
          setBusy(false);
        }
      }}>
        {busy ? "Switching…" : `Switch to ${persona.label} and open the lead`}
      </button>
    </div>
  );
}

function SimulationSummary({ sim, lead }: { sim: SimulationResult; lead: LeadDetail | null }) {
  const booking = lead?.bookings[0];
  const handoff = lead?.handoffs[0];
  return (
    <div className="stack lg">
      <div className="grid two-col-even">
        <div className="stack">
          <div className="row wrap">
            <Chip tone="terra">Simulated call</Chip>
            {lead ? <span className="small muted">Saved as {lead.lead.reference}</span> : <span className="small muted">No lead was created</span>}
          </div>
          {lead ? (
            <dl className="kv">
              <dt>Qualification</dt>
              <dd><StatusChip map={QUAL} value={lead.lead.qualification_status} /></dd>
              <dt>Consultation</dt>
              <dd>
                <StatusChip map={LEAD_BOOKING} value={lead.lead.booking_status} />
                {booking ? <div className="tiny muted">Simulated booking (mock calendar)</div> : null}
              </dd>
              <dt>CRM</dt>
              <dd><StatusChip map={CRM} value={lead.lead.crm_status} /> <span className="tiny muted">mock HubSpot</span></dd>
              <dt>Designer email</dt>
              <dd>{handoff ? <><StatusChip map={DELIVERY} value={handoff.delivery_status} /> <span className="tiny muted">to {handoff.recipient_name ?? "front-desk queue"}</span></> : <span className="muted">None</span>}</dd>
            </dl>
          ) : null}
          {lead && handoff?.ack_required ? <AcceptAs leadId={lead.lead.id} recipient={handoff.recipient_name} kind={handoff.recipient_kind} /> : null}
        </div>
        <div>
          <div className="small muted" style={{ marginBottom: 8 }}>Transcript</div>
          <div className="transcript" style={{ maxHeight: 320 }}>
            {sim.transcript.map((t) => (
              <div key={t.seq} className={`bubble ${t.speaker}`}>
                <span className="who">{t.speaker === "agent" ? "Assistant" : "Caller (scripted)"}</span>
                {t.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

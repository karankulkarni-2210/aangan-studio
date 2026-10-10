"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DemoScenarioList, LeadDetail, SimulationResult } from "./api";
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
      )}
    </Dialog>
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { describeError, type Integrations, type PolicyDraftResponse, type PolicyList, type PolicyPublishResponse, type StaffList } from "@/ui/api";
import { CardSkeleton, Chip, EmptyState, ErrorState, Icon, useResource, useToast } from "@/ui/components";
import { ESCALATION, fmtLakh, fmtWhen, humanize, PROVIDER, ROLE, serviceLabel } from "@/ui/format";
import { useSession } from "@/ui/session";

type Rule = { id: string; type: string; description: string; field?: string; comparison?: string; threshold?: number; on_fail: string };
type Config = {
  label: string;
  services: Array<{ id: string; name: string; supported: boolean; aliases: string[] }>;
  service_area: { label: string; city: string; accepted_locations: string[]; known_outside_locations: string[] };
  qualification_rules: Rule[];
  escalation: Record<string, { say: string; assign_role: string }>;
  operations: { staffed_hours: { days: number[]; open: string; close: string }; response_target_seconds: number; front_desk_queue_email: string; handoff: { ack_deadline_minutes: number; escalate_overdue_to: string } };
  booking: { enabled: boolean; duration_minutes: number; horizon_days: number; max_slots_offered: number };
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function SettingsPage() {
  const { me } = useSession();
  const allowed = me?.role === "admin" || me?.role === "front_desk";
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-lede">Studio rules, the team, and the services the assistant depends on.</p>
        </div>
      </div>
      {!allowed ? (
        <div className="card">
          <EmptyState title="Managed by the studio">Settings are maintained by the founder and front desk. You are signed in as {me?.display_name} ({ROLE[me?.role ?? "designer"]}).</EmptyState>
        </div>
      ) : (
        <div className="stack lg">
          <PolicySection />
          <RosterSection />
          <IntegrationsSection />
        </div>
      )}
    </>
  );
}

function PolicySection() {
  const { api, me } = useSession();
  const toast = useToast();
  const policies = useResource(() => api<PolicyList>("/api/v1/policies").then((r) => r.data), []);
  const active = policies.data?.data.find((p) => p.id === policies.data?.readiness.active_policy_id) ?? null;
  const config = active?.config as unknown as Config | undefined;
  const editable = me?.role === "admin" && !me.sandbox;
  const [draft, setDraft] = useState<Config | null>(null);
  const [result, setResult] = useState<PolicyDraftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (config) setDraft(structuredClone(config));
  }, [config]);
  const changed = useMemo(() => Boolean(draft && config && JSON.stringify(draft) !== JSON.stringify(config)), [draft, config]);

  if (policies.error) return <ErrorState error={policies.error} onRetry={policies.reload} />;
  if (!policies.data) return <CardSkeleton lines={6} />;
  if (!active || !config || !draft) return <div className="card"><EmptyState title="No active policy">Publish a policy before taking calls; until then the assistant only takes a message.</EmptyState></div>;

  const saveDraft = async () => {
    setBusy("draft");
    setError(null);
    setResult(null);
    try {
      const { data } = await api<PolicyDraftResponse>("/api/v1/policies", { method: "POST", body: { config: { ...(active.config as object), ...draft } } });
      setResult(data);
      toast(data.validation.ok ? `Draft v${data.policy.version} saved and validated.` : `Draft v${data.policy.version} saved with issues to fix.`, data.validation.ok ? "ok" : "bad");
    } catch (err) {
      setError(describeError(err).detail);
    } finally {
      setBusy(null);
    }
  };
  const publish = async () => {
    if (!result) return;
    setBusy("publish");
    setError(null);
    try {
      const { data } = await api<PolicyPublishResponse>(`/api/v1/policies/${result.policy.id}/publish`, { method: "POST" });
      toast(`Policy v${data.version} is now active for new calls.`);
      setResult(null);
      policies.reload();
    } catch (err) {
      setError(describeError(err).detail);
    } finally {
      setBusy(null);
    }
  };
  const setRule = (id: string, threshold: number) => setDraft((d) => d && { ...d, qualification_rules: d.qualification_rules.map((r) => (r.id === id ? { ...r, threshold } : r)) });

  return (
    <section className="card stack lg" aria-labelledby="policy-h">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div>
          <h2 id="policy-h" className="section-title">Services and qualification rules</h2>
          <div className="small muted">Active: policy v{active.version} · {active.label}{active.published_at ? ` · published ${fmtWhen(active.published_at)}` : ""}</div>
        </div>
        <div className="row wrap">
          {active.is_demo ? <Chip tone="warn">Sample business rules</Chip> : null}
          <Chip tone="ok">Prices never in the assistant&apos;s context</Chip>
        </div>
      </div>
      {!editable ? (
        <div className="note info small">
          {me?.sandbox ? "The demo sandbox shows the rules but cannot change them, because they apply to real calls." : "Only the administrator can change these rules."} Changes are made as a validated draft, then published.
        </div>
      ) : null}

      <div className="grid two-col-even">
        <div className="stack">
          <h3 className="small" style={{ fontWeight: 500 }}>Services</h3>
          {draft.services.map((s) => (
            <label key={s.id} className="check" style={{ alignItems: "center" }}>
              <input type="checkbox" checked={s.supported} disabled={!editable} onChange={(e) => setDraft((d) => d && { ...d, services: d.services.map((x) => (x.id === s.id ? { ...x, supported: e.target.checked } : x)) })} />
              <span className="grow">{s.name}<span className="tiny muted" style={{ display: "block" }}>{s.aliases.length} phrases recognised</span></span>
              <Chip tone={s.supported ? "ok" : "neutral"}>{s.supported ? "Offered" : "Not offered"}</Chip>
            </label>
          ))}
          <div className="small muted">Service area: {draft.service_area.label} ({draft.service_area.accepted_locations.length} localities accepted)</div>
        </div>
        <div className="stack">
          <h3 className="small" style={{ fontWeight: 500 }}>Qualification rules</h3>
          {draft.qualification_rules.map((r) => (
            <div key={r.id} className="stack" style={{ gap: 4 }}>
              <div className="small">{r.description.replace(/\s*\([\d,]+ paise\)/g, "")}</div>
              <div className="row wrap tiny muted" style={{ gap: 8 }}>
                <span>If not met: {r.on_fail === "not_fit" ? "not a fit" : "sent to review"}</span>
                {r.type === "number_threshold" && r.field !== "area" ? (
                  <label className="row" style={{ gap: 6 }}>
                    <span>Threshold</span>
                    {r.field === "budget" ? (
                      <>
                        <input className="input" style={{ width: 110, minHeight: 32 }} type="number" min={0} step={1} disabled={!editable} value={Math.round((r.threshold ?? 0) / 1e7)} onChange={(e) => setRule(r.id, Math.max(0, Number(e.target.value)) * 1e7)} aria-label="Minimum stated budget in lakh" />
                        <span>lakh ({fmtLakh(r.threshold ?? 0)})</span>
                      </>
                    ) : (
                      <>
                        <input className="input" style={{ width: 90, minHeight: 32 }} type="number" min={0} disabled={!editable} value={r.threshold ?? 0} onChange={(e) => setRule(r.id, Math.max(0, Number(e.target.value)))} aria-label={`${humanize(r.field)} threshold`} />
                        <span>{r.field === "timeline" ? "months" : ""}</span>
                      </>
                    )}
                  </label>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <hr className="divider" style={{ margin: 0 }} />
      <div className="grid two-col-even">
        <div className="stack">
          <h3 className="small" style={{ fontWeight: 500 }}>Office hours (IST)</h3>
          <div className="row wrap" role="group" aria-label="Staffed days">
            {DAYS.map((label, i) => {
              const on = draft.operations.staffed_hours.days.includes(i);
              return (
                <button key={label} type="button" className="btn sm" aria-pressed={on} disabled={!editable} style={on ? { background: "var(--accent-soft)", borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                  onClick={() => setDraft((d) => d && { ...d, operations: { ...d.operations, staffed_hours: { ...d.operations.staffed_hours, days: on ? d.operations.staffed_hours.days.filter((x) => x !== i) : [...d.operations.staffed_hours.days, i].sort() } } })}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="row wrap">
            <label className="field"><span>Opens</span><input className="input" type="time" disabled={!editable} value={draft.operations.staffed_hours.open} onChange={(e) => setDraft((d) => d && { ...d, operations: { ...d.operations, staffed_hours: { ...d.operations.staffed_hours, open: e.target.value } } })} /></label>
            <label className="field"><span>Closes</span><input className="input" type="time" disabled={!editable} value={draft.operations.staffed_hours.close} onChange={(e) => setDraft((d) => d && { ...d, operations: { ...d.operations, staffed_hours: { ...d.operations.staffed_hours, close: e.target.value } } })} /></label>
          </div>
        </div>
        <div className="stack">
          <h3 className="small" style={{ fontWeight: 500 }}>Escalation</h3>
          <label className="field" style={{ maxWidth: 260 }}>
            <span>Designer must accept within (minutes)</span>
            <input className="input" type="number" min={5} disabled={!editable} value={draft.operations.handoff.ack_deadline_minutes} onChange={(e) => setDraft((d) => d && { ...d, operations: { ...d.operations, handoff: { ...d.operations.handoff, ack_deadline_minutes: Math.max(5, Number(e.target.value)) } } })} />
          </label>
          <div className="tiny muted">Overdue handoffs go to the {humanize(draft.operations.handoff.escalate_overdue_to)}. Response target: {Math.round(draft.operations.response_target_seconds / 60)} minutes.</div>
          <ul className="small stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 6 }}>
            {Object.entries(draft.escalation).map(([k, v]) => (
              <li key={k}><strong style={{ fontWeight: 500 }}>{ESCALATION[k] ?? humanize(k)}</strong> → {ROLE[v.assign_role] ?? humanize(v.assign_role)}<div className="tiny muted">Assistant says: &ldquo;{v.say}&rdquo;</div></li>
            ))}
          </ul>
        </div>
      </div>

      {editable ? (
        <div className="stack">
          {result ? (
            result.validation.ok ? (
              <div className="note ok small">Draft v{result.policy.version} passed validation. Publishing makes it active for new calls; calls already in progress keep the rules they started with.</div>
            ) : (
              <div className="note bad small" role="alert">
                Draft v{result.policy.version} cannot be published until these are fixed:
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{result.validation.issues.map((i) => <li key={`${i.path}-${i.code}`}>{i.path}: {i.message}</li>)}</ul>
              </div>
            )
          ) : null}
          {error ? <div className="field-error" role="alert">{error}</div> : null}
          <div className="row wrap">
            <button type="button" className="btn" disabled={!changed || busy !== null} onClick={() => { setDraft(structuredClone(config)); setResult(null); }}>Discard changes</button>
            <button type="button" className="btn" disabled={!changed || busy !== null} onClick={saveDraft}>{busy === "draft" ? "Validating…" : "Save as draft"}</button>
            <button type="button" className="btn primary" disabled={!result?.validation.ok || busy !== null} onClick={publish}>{busy === "publish" ? "Publishing…" : "Publish draft"}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RosterSection() {
  const { api } = useSession();
  const staff = useResource(() => api<StaffList>("/api/v1/staff").then((r) => r.data), []);
  const policies = useResource(() => api<PolicyList>("/api/v1/policies").then((r) => r.data), []);
  const active = policies.data?.data.find((p) => p.id === policies.data?.readiness.active_policy_id);
  const queue = (active?.config as unknown as Config | undefined)?.operations.front_desk_queue_email;
  return (
    <section className="card flush" aria-labelledby="roster-h">
      <div className="card-head" style={{ padding: "20px 22px 0" }}>
        <div>
          <h2 id="roster-h" className="section-title">Designer roster and handoff recipients</h2>
          <div className="small muted">Handoffs go only to approved staff on this list, never to an address a caller gives.</div>
        </div>
        {queue ? <Chip tone="outline">Front-desk queue: {queue}</Chip> : null}
      </div>
      {staff.error ? <div style={{ padding: 22 }}><ErrorState error={staff.error} onRetry={staff.reload} /></div> : !staff.data ? (
        <div className="stack" style={{ padding: 22 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 36 }} />)}</div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Services</th><th>Receives handoffs</th><th>Status</th></tr></thead>
            <tbody>
              {staff.data.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.display_name}<div className="tiny muted">{s.email}</div></td>
                  <td className="small">{ROLE[s.role]}</td>
                  <td className="small">{s.services.length ? s.services.map(serviceLabel).join(", ") : <span className="muted">Any</span>}</td>
                  <td>{s.approved_for_handoff ? <Chip tone="ok">Approved</Chip> : <Chip>No</Chip>}</td>
                  <td>{s.active ? <Chip tone="ok" dot>Active</Chip> : <Chip dot>Inactive</Chip>}{s.is_demo ? <> <Chip tone="terra">Demo</Chip></> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tiny muted" style={{ margin: 0, padding: "12px 22px 18px" }}>
        There is no roster-editing API yet: staff are added or removed by an administrator in Supabase (table <code>public.staff</code>).
      </p>
    </section>
  );
}

function IntegrationsSection() {
  const { api } = useSession();
  const i = useResource(() => api<Integrations>("/api/v1/integrations").then((r) => r.data), []);
  return (
    <section className="stack" aria-labelledby="int-h">
      <div className="row wrap between">
        <div>
          <h2 id="int-h" className="section-title">Integrations</h2>
          <div className="small muted">Status only. Keys are kept on the server and never shown here.</div>
        </div>
        {i.data ? <Chip tone={i.data.app_mode === "live" ? "ok" : "warn"} dot>App mode: {i.data.app_mode === "live" ? "Live" : "Demo"} · simulated leads always use mocks</Chip> : null}
      </div>
      {i.error ? <ErrorState error={i.error} onRetry={i.reload} /> : !i.data ? (
        <div className="grid three-col">{[0, 1, 2].map((k) => <CardSkeleton key={k} />)}</div>
      ) : (
        <div className="grid three-col">
          {i.data.integrations.map((p) => (
            <article key={p.provider} className="card stack" style={{ gap: 10 }}>
              <div className="row between">
                <h3 className="card-title" style={{ fontSize: 19 }}>{PROVIDER[p.provider]}</h3>
                <Chip tone={p.mode === "live" ? "ok" : p.mode === "mock" ? "info" : "bad"} dot>{p.mode === "live" ? "Live" : p.mode === "mock" ? "Mock" : "Not configured"}</Chip>
              </div>
              <div className="small">{p.capability}</div>
              <dl className="kv tiny">
                <dt>Configured</dt>
                <dd>{p.missing_env.length === 0 ? "Yes" : <>Missing: {p.missing_env.map((n) => <code key={n} style={{ marginRight: 4 }}>{n}</code>)}</>}</dd>
                <dt>Last success</dt>
                <dd>{p.health?.last_success_at ? fmtWhen(p.health.last_success_at) : "Not recorded"}</dd>
                <dt>Last error</dt>
                <dd>{p.health?.last_error_at ? <span style={{ color: "var(--bad)" }}>{fmtWhen(p.health.last_error_at)}</span> : "None"}</dd>
                <dt>Pending / failed</dt>
                <dd>{p.health ? `${p.health.pending} / ${p.health.failed}` : "Not available"}</dd>
              </dl>
              {p.gaps.length ? (
                <details className="disclosure tiny">
                  <summary>Known limitations ({p.gaps.length})</summary>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{p.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {i.data?.jobs.some((j) => j.status === "dead") ? (
        <div className="note bad small"><Icon name="alert" size={16} /> Some background jobs stopped retrying. See Activity &amp; Costs for details.</div>
      ) : null}
    </section>
  );
}

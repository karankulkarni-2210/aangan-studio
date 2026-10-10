"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { qs, type LeadList, type StaffList } from "@/ui/api";
import { Chip, EmptyState, ErrorState, Icon, SimulatedTag, StatusChip, useResource } from "@/ui/components";
import { fmtInt, fmtWhen, initials, LEAD_BOOKING, nextAction, placeLabel, QUAL, serviceLabel } from "@/ui/format";
import { useSession } from "@/ui/session";

const DATE_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "1", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];
const ATTENTION: Record<string, string> = {
  ack_overdue: "Acceptance overdue",
  handoff_failed: "Handoff failed",
  discovery_incomplete: "Details incomplete",
  open_escalations: "Open follow-ups",
};

export default function EnquiriesPage() {
  const { api, me } = useSession();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [qualification, setQualification] = useState("");
  const [owner, setOwner] = useState("");
  const [booking, setBooking] = useState("");
  const [days, setDays] = useState("");
  const [attention, setAttention] = useState("");
  const [source, setSource] = useState<"all" | "true" | "false">("all");
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);

  // Filters can arrive from Overview links (?qualification=…&attention=…).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("qualification")) setQualification(sp.get("qualification")!);
    if (sp.get("attention") && ATTENTION[sp.get("attention")!]) setAttention(sp.get("attention")!);
    if (sp.get("owner")) setOwner(sp.get("owner")!);
    setReady(true);
  }, []);
  useEffect(() => setPage(1), [qualification, owner, days, attention, source]);

  const canSeeRoster = me?.role === "admin" || me?.role === "front_desk";
  const staff = useResource(canSeeRoster ? () => api<StaffList>("/api/v1/staff").then((r) => r.data) : null, [canSeeRoster]);
  const from = days ? new Date(Date.now() - Number(days) * 86400000).toISOString() : undefined;
  const leads = useResource(
    ready
      ? () =>
          api<LeadList>(`/api/v1/leads${qs({ qualification, owner, from, attention, simulated: me?.sandbox ? undefined : source, page, page_size: 50 })}`).then((r) => r.data)
      : null,
    [ready, qualification, owner, days, attention, source, page],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (leads.data?.data ?? []).filter((l) => {
      if (booking && l.booking_status !== booking) return false;
      if (!q) return true;
      return [l.contact_name, l.reference, l.location_city, l.location_locality, serviceLabel(l.service_type), l.owner?.display_name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [leads.data, search, booking]);

  const clear = () => {
    setSearch("");
    setQualification("");
    setOwner("");
    setBooking("");
    setDays("");
    setAttention("");
    setSource("all");
  };
  const filtered = Boolean(search || qualification || owner || booking || days || attention || source !== "all");
  const designers = (staff.data?.data ?? []).filter((s) => s.active && s.role === "designer");

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Enquiries</h1>
          <p className="page-lede">Every phone enquiry, with what the caller said and what happens next.</p>
        </div>
        {leads.data ? <span className="small muted">{fmtInt(leads.data.pagination.total)} {leads.data.pagination.total === 1 ? "enquiry" : "enquiries"}{me?.sandbox ? " · simulated only" : ""}</span> : null}
      </div>

      <section className="card stack" aria-label="Filters" style={{ marginBottom: 16 }}>
        <div className="filters">
          <label className="field">
            <span>Search</span>
            <input className="input" type="search" placeholder="Name, reference, area or designer" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label className="field">
            <span>Qualification</span>
            <select className="select" value={qualification} onChange={(e) => setQualification(e.target.value)}>
              <option value="">All</option>
              <option value="qualified">Qualified</option>
              <option value="needs_review">Needs review</option>
              <option value="not_fit">Not fit</option>
              <option value="pending">Pending</option>
            </select>
          </label>
          <label className="field">
            <span>Owner</span>
            <select className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">{me?.role === "designer" ? "My leads" : "Anyone"}</option>
              <option value="me">Assigned to me</option>
              {canSeeRoster ? <option value="unassigned">Unassigned</option> : null}
              {designers.map((s) => (
                <option key={s.id} value={s.id}>{s.display_name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Consultation</span>
            <select className="select" value={booking} onChange={(e) => setBooking(e.target.value)}>
              <option value="">Any</option>
              {Object.entries(LEAD_BOOKING).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Received</span>
            <select className="select" value={days} onChange={(e) => setDays(e.target.value)}>
              {DATE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="row wrap between">
          <div className="row wrap">
            {attention ? (
              <Chip tone="accent">
                {ATTENTION[attention]}
                <button type="button" className="link-btn" aria-label="Remove follow-up filter" onClick={() => setAttention("")} style={{ textDecoration: "none" }}>×</button>
              </Chip>
            ) : null}
            {!me?.sandbox ? (
              <label className="row small">
                <span className="muted">Source</span>
                <select className="select" value={source} onChange={(e) => setSource(e.target.value as typeof source)} style={{ minHeight: 34, width: "auto" }}>
                  <option value="all">Live and simulated</option>
                  <option value="false">Live calls only</option>
                  <option value="true">Simulated only</option>
                </select>
              </label>
            ) : (
              <Chip tone="terra">Demo sandbox: simulated enquiries only</Chip>
            )}
          </div>
          {filtered ? <button type="button" className="link-btn" onClick={clear}>Clear filters</button> : null}
        </div>
      </section>

      <section className="card flush" aria-label="Enquiry list">
        {leads.error ? (
          <div style={{ padding: 22 }}><ErrorState error={leads.error} onRetry={leads.reload} /></div>
        ) : !leads.data ? (
          <div className="stack" style={{ padding: 22 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 44 }} />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={filtered ? "No enquiries match these filters" : "No enquiries yet"} action={filtered ? <button type="button" className="btn" onClick={clear}>Clear filters</button> : undefined}>
            {filtered ? "Try widening the date range or clearing a filter." : "Enquiries appear here as soon as a call starts. In the demo, use Try a sample enquiry on the Overview."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Project</th>
                  <th>Qualification</th>
                  <th>Consultation</th>
                  <th>Designer</th>
                  <th>Received</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const a = nextAction(l);
                  return (
                    <tr key={l.id} className="clickable" onClick={() => router.push(`/enquiries/${l.id}`)}>
                      <td>
                        <div className="person">
                          <span className="avatar" aria-hidden="true">{initials(l.contact_name)}</span>
                          <div style={{ minWidth: 0 }}>
                            <Link className="row-link" href={`/enquiries/${l.id}`} onClick={(e) => e.stopPropagation()}>{l.contact_name ?? "Unnamed caller"}</Link>
                            <div className="tiny muted row" style={{ gap: 6 }}>{l.reference}{l.is_simulated ? <SimulatedTag simulated compact /> : null}</div>
                          </div>
                        </div>
                      </td>
                      <td className="small">{serviceLabel(l.service_type)}<div className="muted">{placeLabel(l.location_city, l.location_locality)}</div></td>
                      <td><StatusChip map={QUAL} value={l.qualification_status} /></td>
                      <td><StatusChip map={LEAD_BOOKING} value={l.booking_status} /></td>
                      <td className="small">{l.owner?.display_name ?? <span className="muted">Unassigned</span>}</td>
                      <td className="small nowrap">{fmtWhen(l.intake_at)}</td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <Chip tone={a.tone}>{a.label}</Chip>
                          {l.injection_suspected ? <span title="Unusual instructions in caller speech; review before relying on it"><Icon name="shield" size={16} label="Review flagged" /></span> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {leads.data && leads.data.pagination.total_pages > 1 ? (
          <div className="row between" style={{ padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
            <span className="small muted">Page {leads.data.pagination.page} of {leads.data.pagination.total_pages}</span>
            <div className="row">
              <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <button type="button" className="btn sm" disabled={page >= leads.data.pagination.total_pages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

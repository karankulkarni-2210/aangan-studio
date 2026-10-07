/**
 * Reproducible end-to-end demo (SIMULATED calls, demo data and sample business rules).
 *
 *   npm run demo                      # embedded Postgres in memory, nothing external
 *   npm run demo -- --database-url=postgres://...   # an already-migrated and seeded database
 *
 * Writes demo-output/ (report.md, transcripts, email previews, dashboard JSON). Never places calls,
 * sends email, books calendars or writes to a CRM: simulated leads always use mock providers.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

for (const k of ["GEMINI_API_KEY", "CALCOM_API_KEY", "HUBSPOT_ACCESS_TOKEN", "RESEND_API_KEY", "VAANI_API_KEY"]) delete process.env[k];
process.env.APP_MODE = "demo";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
for (const k of ["DEMO_JWT_SECRET", "VOICE_TOOL_SECRET", "DISPATCH_SECRET", "SIMULATED_VOICE_WEBHOOK_SECRET"]) {
  process.env[k] = process.env[k] ?? randomBytes(32).toString("hex");
}

const OUT = path.resolve(process.cwd(), "demo-output");

async function main() {
  const { createPgliteDb } = await import("../src/lib/db/pglite");
  const { createPostgresDb } = await import("../src/lib/db/postgres");
  const { setDb } = await import("../src/lib/runtime");
  const { demoSeedSql } = await import("../src/lib/seed/demo");
  const { runScenario } = await import("../src/lib/simulation/runner");
  const { listScenarios } = await import("../src/lib/simulation/scenarios");
  const { mintDemoToken } = await import("../src/lib/auth/demo-token");
  const { inspectSpeech } = await import("../src/lib/domain/speech-guard");
  const leadRoute = await import("../src/app/api/v1/leads/[id]/route");
  const ackRoute = await import("../src/app/api/v1/leads/[id]/acknowledgements/route");
  const outcomeRoute = await import("../src/app/api/v1/leads/[id]/outcomes/route");
  const dashboardRoute = await import("../src/app/api/v1/dashboard/route");
  const integrationsRoute = await import("../src/app/api/v1/integrations/route");

  const dbUrl = process.argv.find((a) => a.startsWith("--database-url="))?.split("=").slice(1).join("=");
  const db = dbUrl ? createPostgresDb(dbUrl) : await createPgliteDb();
  if (!dbUrl) await db.exec(demoSeedSql());
  setDb(db);

  type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  const api = async (handler: unknown, method: string, p: string, opts: { token?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string> } = {}) => {
    const res = await (handler as H)(
      new Request(`http://localhost:3000${p}`, {
        method,
        headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { params: Promise.resolve(opts.params ?? {}) },
    );
    return { status: res.status, body: await res.json() };
  };
  const staffToken = async (email: string) => {
    const { rows } = await db.query(`select auth_user_id from public.staff where email = $1`, [email]);
    return mintDemoToken(rows[0].auth_user_id);
  };
  const admin = await staffToken("nikhil.demo@aangan-demo.example");

  fs.rmSync(OUT, { recursive: true, force: true });
  for (const d of ["transcripts", "emails", "leads"]) fs.mkdirSync(path.join(OUT, d), { recursive: true });

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  };

  console.log("\nAangan Studio: SIMULATED phone-enquiry demo (demo data and sample business rules)\n");
  const results = [];
  for (const scenario of listScenarios()) {
    const r = await runScenario(db, scenario, { runJobs: true });
    results.push({ scenario, r });
    fs.writeFileSync(
      path.join(OUT, "transcripts", `${scenario.id}.txt`),
      [`SIMULATED CALL: ${scenario.title}`, `Lead ${r.lead_id}`, "", ...r.transcript.map((l) => `${l.speaker.toUpperCase().padEnd(6)} ${l.text}`)].join("\n") + "\n",
    );
  }

  // Main flow walkthrough on the suitable-home enquiry.
  const main = results.find((x) => x.scenario.id === "suitable_home")!.r;
  const detail = await api(leadRoute.GET, "GET", `/api/v1/leads/${main.lead_id}`, { token: admin, params: { id: main.lead_id! } });
  const d = detail.body;
  check("Simulated Vaani enquiry saved as a lead in Supabase schema", detail.status === 200 && d.lead.is_simulated === true, d.lead.reference);
  check("Gemini classification fixture validated against caller quotes", d.evidence.every((e: { quote: string | null }) => Boolean(e.quote)), `${d.evidence.length} evidence items`);
  check("Deterministic qualification against pinned policy v1", d.qualification.current?.decision === "qualified" && d.qualification.current?.policy_version === 1, d.qualification.current?.decision);
  check("Pricing question escalated to a human with no price spoken", d.escalation_flags.pricing_requested && main.transcript.filter((l) => l.speaker === "agent").every((l) => !inspectSpeech(l.text).blocked));
  const booking = d.bookings.find((b: { status: string }) => b.status === "confirmed");
  check("Slot conflict handled, then consultation confirmed by (simulated) Cal.com", Boolean(booking?.confirmed) && d.bookings.some((b: { status: string }) => b.status === "conflict"), booking?.provider_booking_uid);
  const deal = d.crm_sync.find((s: { object_kind: string }) => s.object_kind === "deal");
  check("HubSpot contact + open deal created (simulated)", deal?.status === "succeeded" && deal.remote_id.startsWith("sim_"), deal?.remote_id);
  const handoff = d.handoffs.find((h: { purpose: string }) => h.purpose === "designer_handoff");
  check("Resend handoff preview rendered and (simulated) delivered", handoff?.delivery_status === "simulated" && Boolean(handoff.preview), handoff?.recipient_name);
  fs.writeFileSync(path.join(OUT, "emails", "suitable_home_designer_handoff.txt"), `Subject: ${handoff.preview.subject}\nTo: ${handoff.recipient_name}\n\n${handoff.preview.text}\n`);

  const { rows: owner } = await db.query(`select s.email from public.leads l join public.staff s on s.id = l.owner_staff_id where l.id = $1`, [main.lead_id]);
  const designer = await staffToken(owner[0].email);
  const other = await staffToken(owner[0].email === "asha.demo@aangan-demo.example" ? "vikram.demo@aangan-demo.example" : "asha.demo@aangan-demo.example");
  const ackPath = `/api/v1/leads/${main.lead_id}/acknowledgements`;
  const denied = await api(ackRoute.POST, "POST", ackPath, { token: other, params: { id: main.lead_id! } });
  const ack1 = await api(ackRoute.POST, "POST", ackPath, { token: designer, params: { id: main.lead_id! } });
  const ack2 = await api(ackRoute.POST, "POST", ackPath, { token: designer, params: { id: main.lead_id! } });
  check("Designer acknowledgement (other designer denied; repeat is idempotent)", denied.status === 404 && ack1.status === 201 && ack2.status === 200 && ack2.body.already_acknowledged, `${denied.status}/${ack1.status}/${ack2.status}`);
  const nowIso = new Date().toISOString();
  const contacted = await api(outcomeRoute.POST, "POST", `/api/v1/leads/${main.lead_id}/outcomes`, { token: designer, params: { id: main.lead_id! }, body: { outcome: "contacted", occurred_at: nowIso } });
  const won = await api(outcomeRoute.POST, "POST", `/api/v1/leads/${main.lead_id}/outcomes`, {
    token: designer,
    params: { id: main.lead_id! },
    headers: { "idempotency-key": "demo-won-1" },
    body: { outcome: "won", occurred_at: nowIso, contract_value_paise: 110_000_000, reason: "Synthetic demo outcome" },
  });
  check("Outcomes appended (contacted, then won with synthetic confirmed contract value)", contacted.status === 201 && won.status === 201);

  // Other scenarios against their expected outcomes.
  for (const { scenario, r } of results) {
    const { rows } = await db.query(`select qualification_status, discovery_status, booking_status, crm_status, open_escalations from public.leads where id = $1`, [r.lead_id]);
    const l = rows[0];
    const { rows: hs } = await db.query(`select purpose from public.handoffs where lead_id = $1 and purpose <> 'ack_escalation'`, [r.lead_id]);
    const ok =
      l.qualification_status === scenario.expected.decision &&
      l.discovery_status === scenario.expected.discovery_status &&
      l.booking_status === scenario.expected.booking_status &&
      (l.crm_status === "synced") === scenario.expected.crm_synced &&
      (hs[0]?.purpose ?? null) === scenario.expected.handoff_purpose;
    check(`Scenario ${scenario.id}`, ok, `${l.qualification_status}, discovery ${l.discovery_status}, booking ${l.booking_status}, handoff ${hs[0]?.purpose ?? "none"}, CRM ${l.crm_status}`);
    const det = await api(leadRoute.GET, "GET", `/api/v1/leads/${r.lead_id}`, { token: admin, params: { id: r.lead_id! } });
    fs.writeFileSync(path.join(OUT, "leads", `${scenario.id}.json`), JSON.stringify(det.body, null, 2));
    for (const h of det.body.handoffs.filter((x: { preview: unknown }) => x.preview)) {
      fs.writeFileSync(path.join(OUT, "emails", `${scenario.id}_${h.purpose}.txt`), `Subject: ${h.preview.subject}\nTo: ${h.recipient_name}\n\n${h.preview.text}\n`);
    }
  }

  const dash = await api(dashboardRoute.GET, "GET", "/api/v1/dashboard", { token: admin });
  const integ = await api(integrationsRoute.GET, "GET", "/api/v1/integrations", { token: admin });
  fs.writeFileSync(path.join(OUT, "dashboard.json"), JSON.stringify(dash.body, null, 2));
  fs.writeFileSync(path.join(OUT, "integrations.json"), JSON.stringify(integ.body, null, 2));
  const m = dash.body.metrics;
  const c = dash.body.costs;
  check("Dashboard labels simulated data and demo rules", dash.body.data_labels.contains_simulated_data && dash.body.data_labels.demo_policy === true);
  check("Dashboard includes operating cost and pending acknowledgements", typeof c.total_operating_paise === "number" && typeof m.handoffs.pending_acknowledgements === "number", `₹${(c.total_operating_paise / 100).toFixed(2)}; ${m.handoffs.pending_acknowledgements} pending`);

  const rupees = (p: number | null) => (p === null ? "n/a" : `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const report = [
    "# Aangan Studio demo run",
    "",
    `> SIMULATED CALLS · demo data and sample business rules · synthetic/placeholder rates. Generated ${new Date().toISOString()}.`,
    "> Simulated telephony is not a live phone integration. Bookings, CRM records and emails below were produced by mock providers.",
    "",
    "## Checks",
    "",
    "| Result | Check | Detail |",
    "|---|---|---|",
    ...checks.map((x) => `| ${x.ok ? "PASS" : "FAIL"} | ${x.name} | ${x.detail.replace(/\|/g, "/")} |`),
    "",
    "## Dashboard (period: last 30 days)",
    "",
    `- Five-minute response: ${m.five_minute_response.numerator}/${m.five_minute_response.denominator} (${m.five_minute_response.rate === null ? "n/a" : `${Math.round(m.five_minute_response.rate * 100)}%`}); p50 ${m.response_time_seconds.p50}s, p95 ${m.response_time_seconds.p95}s`,
    `- Calls ${m.calls.total} (after hours ${m.calls.after_hours}); unique leads ${m.leads.unique}; discovery complete ${m.leads.discovery_complete}, incomplete ${m.leads.discovery_incomplete}`,
    `- Qualification: qualified ${m.qualification.qualified}, needs review ${m.qualification.needs_review}, not fit ${m.qualification.not_fit}`,
    `- Human tasks by kind: ${Object.entries(m.human_tasks).map(([k, v]) => `${k} ${(v as { raised: number }).raised}`).join(", ")}`,
    `- Handoffs delivered ${m.handoffs.delivered} (simulated ${m.handoffs.delivered_simulated}), failed ${m.handoffs.failed}, pending acknowledgements ${m.handoffs.pending_acknowledgements}`,
    `- Consultations confirmed ${m.consultations.confirmed}, declined ${m.consultations.declined}, conflicts ${m.consultations.conflicts}`,
    `- Cohort: ${m.cohort_conversion.leads} leads, won ${m.cohort_conversion.won}, unknown ${m.cohort_conversion.unknown} (observation complete: ${m.cohort_conversion.observation_complete})`,
    `- Confirmed contract value ${rupees(m.confirmed_contract_value.paise)}: ${m.confirmed_contract_value.note}`,
    "",
    "## Costs (estimated; synthetic placeholders unless invoiced)",
    "",
    `Total operating ${rupees(c.total_operating_paise)} · cost per qualified lead ${rupees(c.cost_per_qualified_lead_paise)} · development tools excluded ${rupees(c.excluded_development_paise)}`,
    "",
    "| Provider | Category | Basis | Amount | Synthetic rates | Simulated usage | Bundled qty |",
    "|---|---|---|---|---|---|---|",
    ...c.lines.map((l: { provider: string; category: string; basis: string; amount_paise: number; synthetic_rates: boolean; includes_simulated_usage: boolean; bundled_quantity: number }) =>
      `| ${l.provider} | ${l.category} | ${l.basis} | ${rupees(l.amount_paise)} | ${l.synthetic_rates ? "yes" : "no"} | ${l.includes_simulated_usage ? "yes" : "no"} | ${l.bundled_quantity || ""} |`),
    "",
    `FX assumptions: ${c.currency_assumptions.map((f: { currency: string; fx_rate_to_inr: number; fx_source: string }) => `${f.currency}→INR ${f.fx_rate_to_inr} (${f.fx_source})`).join("; ")}`,
    "",
    "## Integrations",
    "",
    ...integ.body.integrations.map((i: { provider: string; mode: string; gaps: string[] }) => `- **${i.provider}**: ${i.mode}${i.gaps.length ? `; gaps: ${i.gaps.join(" ")}` : ""}`),
    "",
    "Files: transcripts/, emails/, leads/*.json, dashboard.json, integrations.json.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "report.md"), report);
  const failed = checks.filter((x) => !x.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed. Report: ${path.relative(process.cwd(), path.join(OUT, "report.md"))}\n`);
  await db.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

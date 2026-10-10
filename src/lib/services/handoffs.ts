import { env } from "@/lib/config/env";
import type { Db, Queryable } from "@/lib/db/types";
import type { HandoffPurpose } from "@/lib/domain/enums";
import { ApiError, forbidden, notFound } from "@/lib/http/errors";
import type { StaffActor } from "@/lib/http/route";
import { enqueue, PermanentJobError, RetryableJobError, type Job } from "@/lib/jobs/outbox";
import { getProviders } from "@/lib/providers/registry";
import { now } from "@/lib/runtime";
import { audit } from "./audit";
import { getPolicyById, type PolicyRecord } from "./policies";
import { openTask, resolveTasks } from "./tasks";
import { recordUsage } from "./usage";

// Designer handoff via email (Resend). Recipients come ONLY from the approved roster or the
// policy's front-desk queue address. Delivery and acknowledgement are separate states: an email
// that was delivered is not an accepted lead.

export function leadUrl(leadId: string): string {
  return env.leadUrlTemplate().replace("{lead_id}", encodeURIComponent(leadId));
}

async function pickDesigner(q: Queryable, serviceType: string | null) {
  const { rows } = await q.query<{ id: string; email: string; display_name: string }>(
    `select id, email, display_name from public.staff
      where role = 'designer' and active and approved_for_handoff
        and (cardinality(services) = 0 or $1::text = any(services))
      order by last_assigned_at nulls first, display_name
      limit 1 for update`,
    [serviceType],
  );
  return rows[0] ?? null;
}

/**
 * Creates the handoff appropriate to the lead's current qualification (idempotent per purpose)
 * and enqueues delivery. Returns null when no handoff applies (e.g. not_fit without a request).
 */
export async function ensureHandoff(
  q: Queryable,
  leadId: string,
  policy: PolicyRecord | null,
  requestedBy: "system" | "voice_agent" | "staff",
  forcePurpose?: HandoffPurpose,
): Promise<{ id: string; purpose: HandoffPurpose; created: boolean } | null> {
  const { rows } = await q.query(`select * from public.leads where id = $1 for update`, [leadId]);
  const lead = rows[0];
  let purpose: HandoffPurpose | null = forcePurpose ?? null;
  if (!purpose) {
    if (lead.qualification_status === "qualified") purpose = "designer_handoff";
    else if (lead.qualification_status === "needs_review" || lead.qualification_status === "pending") purpose = "front_desk_review";
    else if (lead.handoff_requested_at || lead.open_escalations.some((k: string) => ["complaint", "human_requested", "urgent"].includes(k))) purpose = "front_desk_review";
  }
  if (!purpose || !policy) return null;

  let recipient: { kind: "designer" | "front_desk_queue"; staffId: string | null; email: string } = {
    kind: "front_desk_queue",
    staffId: null,
    email: policy.config.operations.front_desk_queue_email,
  };
  if (purpose === "designer_handoff") {
    const existing = lead.owner_staff_id
      ? (await q.query(`select id, email from public.staff where id = $1 and active and approved_for_handoff and role = 'designer'`, [lead.owner_staff_id])).rows[0]
      : null;
    const designer = existing ?? (await pickDesigner(q, lead.service_type));
    if (designer) recipient = { kind: "designer", staffId: designer.id, email: designer.email };
    else purpose = "front_desk_review"; // no approved designer available: front desk assigns manually
  }

  const dedupe = `lead:${leadId}:${purpose}`;
  const { rows: ins } = await q.query<{ id: string }>(
    `insert into public.handoffs (lead_id, purpose, dedupe_key, recipient_kind, recipient_staff_id, recipient_email, requested_by, ack_required)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (dedupe_key) do nothing returning id`,
    [leadId, purpose, dedupe, recipient.kind, recipient.staffId, recipient.email, requestedBy, purpose !== "ack_escalation"],
  );
  if (!ins[0]) {
    const { rows: ex } = await q.query<{ id: string }>(`select id from public.handoffs where dedupe_key = $1`, [dedupe]);
    return { id: ex[0].id, purpose, created: false };
  }
  if (recipient.kind === "designer") {
    await q.query(`update public.staff set last_assigned_at = $2 where id = $1`, [recipient.staffId, now()]);
    // RLS lets a designer see only leads they own, so the recipient must be the owner.
    await q.query(`update public.leads set owner_staff_id = $2 where id = $1`, [leadId, recipient.staffId]);
  }
  await q.query(
    `update public.leads set handoff_status = case when handoff_status in ('acknowledged', 'sent') then handoff_status else 'pending' end where id = $1`,
    [leadId],
  );
  await enqueue(q, "handoff.send", { handoff_id: ins[0].id }, `handoff.send:${ins[0].id}`, { maxAttempts: 6 });
  await audit(q, { actor_kind: "system", action: "handoff.created", entity_type: "handoff", entity_id: ins[0].id, after: { lead_id: leadId, purpose, recipient_kind: recipient.kind } });
  return { id: ins[0].id, purpose, created: true };
}

// ---------------------------------------------------------------------------------------------
// Email rendering: deterministic, from structured fields only (no model free text).

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function maskPhone(p: string | null): string {
  if (!p) return "not captured";
  const digits = p.replace(/\D/g, "");
  return digits.length < 6 ? "captured (see lead page)" : `${p.slice(0, 3)} •••• ${digits.slice(-2)} (full number on the lead page)`;
}

export async function renderHandoffEmail(q: Queryable, handoffId: string) {
  const { rows } = await q.query(
    `select h.*, l.reference, l.is_simulated, l.fact_status, l.qualification_status, l.qualification_reasons, l.missing_fields,
            l.open_escalations, l.caller_phone, l.booking_status, l.policy_id, l.id as lead_id
       from public.handoffs h join public.leads l on l.id = h.lead_id where h.id = $1`,
    [handoffId],
  );
  const h = rows[0];
  const policy = await getPolicyById(q, h.policy_id);
  const { rows: booking } = await q.query(
    `select status, slot_start, mode from public.bookings where lead_id = $1 and status in ('confirmed', 'pending_reconciliation', 'declined') order by created_at desc limit 1`,
    [h.lead_id],
  );
  const facts = h.fact_status as Record<string, { status: string; display: string | null }>;
  const fact = (f: string, label: string) => {
    const x = facts[f];
    const value = !x || x.status === "missing" ? "not captured" : x.display ?? x.status;
    const note = x?.status === "confirmed" ? " (confirmed by caller)" : x?.status === "unconfirmed" ? " (UNCONFIRMED)" : x?.status === "contradictory" ? " (CONTRADICTORY: check transcript)" : "";
    return `${label}: ${value}${note}`;
  };
  const labels: string[] = [];
  if (h.is_simulated) labels.push("SIMULATED CALL");
  if (policy?.is_demo !== false) labels.push("DEMO DATA AND SAMPLE BUSINESS RULES");
  const prefix = labels.length ? `[${h.is_simulated ? "SIMULATED" : "DEMO RULES"}] ` : "";
  const service = facts.service?.display && facts.service.status !== "missing" ? facts.service.display : "Enquiry";
  const subject =
    h.purpose === "designer_handoff"
      ? `${prefix}Qualified enquiry ${h.reference}: ${service}`
      : h.purpose === "ack_escalation"
        ? `${prefix}Unacknowledged handoff ${h.reference}`
        : `${prefix}Enquiry for review ${h.reference}`;

  const reasons = (h.qualification_reasons as Array<{ rule_id: string; result: string; effect: string }>).map(
    (r) => `${r.rule_id}: ${r.result}${r.effect !== "none" ? ` -> ${r.effect}` : ""}`,
  );
  const TASK_LABELS: Record<string, string> = {
    pricing_request: "PRICING REQUESTED: confirm pricing after reviewing scope. No price was given to the caller; do not send prices through automated channels.",
    commitment_request: "COMMITMENT REQUESTED: the caller asked for a commitment (cost, date, discount, tax or terms); none was made.",
    complaint: "COMPLAINT: a person must follow up.",
    human_requested: "PERSON REQUESTED: the caller asked to speak to someone.",
    urgent: "URGENT: the caller described this as urgent.",
    callback: "CALLBACK: the call ended before discovery was complete; call the caller back.",
    needs_review: "REVIEW: qualification needs a human decision (see rules below).",
    booking_pending: "BOOKING NOT CONFIRMED: check the calendar and call the caller.",
    injection_review: "CHECK TRANSCRIPT: the caller's speech contained instruction-like text (treated as data).",
    integration_failure: "INTEGRATION FAILURE: see the lead page.",
    ack_overdue: "OVERDUE: the handoff was not accepted in time.",
    agent_price_utterance: "AGENT SPEECH FLAGGED: review the transcript.",
  };
  const escalations = (h.open_escalations as string[]).map((k) => TASK_LABELS[k] ?? k.replace(/_/g, " ").toUpperCase());
  const b = booking[0];
  const bookingLine = !b
    ? "Consultation: not booked"
    : b.status === "confirmed"
      ? `Consultation: CONFIRMED for ${new Date(b.slot_start).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST${b.mode === "mock" ? " (simulated Cal.com booking)" : ""}`
      : b.status === "declined"
        ? "Consultation: caller declined to book"
        : "Consultation: booking NOT confirmed (pending reconciliation); front desk is following up";
  const url = leadUrl(h.lead_id);
  const deadline = policy?.config.operations.handoff.ack_deadline_minutes;
  const lines = [
    ...(labels.length ? [labels.join(" · "), ""] : []),
    `Lead ${h.reference} · ${String(h.qualification_status).replace("_", " ")}${policy ? ` (policy v${policy.version}${policy.is_demo ? ", demo" : ""})` : ""}`,
    `Open and accept the lead (sign-in required): ${url}`,
    "",
    "Project",
    fact("service", "- Type"),
    fact("location", "- Location"),
    fact("area", "- Area"),
    fact("budget", "- Budget (caller's own figure, not a quote)"),
    fact("timeline", "- Start"),
    fact("contact_name", "- Name"),
    fact("callback_preference", "- Callback"),
    `- Phone: ${maskPhone(h.caller_phone)}`,
    "",
    bookingLine,
    "",
    `Qualification rules: ${reasons.length ? reasons.join("; ") : "none evaluated"}`,
    `Missing information: ${(h.missing_fields as string[]).length ? (h.missing_fields as string[]).join(", ") : "none"}`,
    ...(escalations.length ? ["", "Human follow-up needed:", ...escalations.map((e) => `- ${e}`)] : []),
    "",
    deadline ? `Please accept this lead within ${deadline} minutes${policy?.is_demo ? " (demo setting)" : ""}. Email delivery is not acknowledgement.` : "Please accept this lead on the lead page.",
    "The full transcript is available on the lead page to authorised staff only.",
  ];
  const text = lines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${lines
    .map((l) => (l === "" ? "<br>" : `<div>${esc(l).replace(esc(url), `<a href="${esc(url)}">${esc(url)}</a>`)}</div>`))
    .join("")}</div>`;
  return { subject, text, html, recipient: h.recipient_email as string, policy, handoff: h };
}

// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recipientStillApproved(q: Queryable, h: Record<string, any>, policy: PolicyRecord | null) {
  if (h.recipient_kind === "designer") {
    const { rows } = await q.query(`select email from public.staff where id = $1 and active and approved_for_handoff`, [h.recipient_staff_id]);
    return rows[0]?.email === h.recipient_email;
  }
  return policy?.config.operations.front_desk_queue_email === h.recipient_email;
}

export async function sendHandoffJob(db: Db, job: Job): Promise<void> {
  const handoffId = String(job.payload.handoff_id);
  const prepared = await db.tx(async (tx) => {
    const { rows } = await tx.query(`select h.*, l.is_simulated from public.handoffs h join public.leads l on l.id = h.lead_id where h.id = $1 for update`, [handoffId]);
    const h = rows[0];
    if (!h) throw new PermanentJobError("handoff not found");
    if (h.delivery_status === "sent" || h.delivery_status === "simulated") return null;
    const rendered = await renderHandoffEmail(tx, handoffId);
    // Pilot redirect (DESIGNER_HANDOFF_EMAIL) applies to live sends only; the email names the
    // intended roster recipient so the redirect is never mistaken for the real routing.
    const live = getProviders(db, { simulated: h.is_simulated }).email.mode === "live";
    const redirect = live ? env.handoffRedirectEmail() : undefined;
    if (redirect && redirect !== rendered.recipient) {
      const note = `PILOT REDIRECT: intended for ${rendered.recipient}; delivered to ${redirect} (DESIGNER_HANDOFF_EMAIL).`;
      rendered.text = `${note}\n\n${rendered.text}`;
      rendered.html = `<div style="font-family:system-ui,sans-serif;font-size:14px"><strong>${esc(note)}</strong></div><br>${rendered.html}`;
    }
    // Retries must resend the identical payload under the same Idempotency-Key, otherwise Resend
    // rejects them (409 invalid_idempotent_request) after a first attempt that may have delivered.
    const email = h.subject && h.body_text && h.body_html ? { ...rendered, subject: h.subject, text: h.body_text, html: h.body_html } : rendered;
    const to = redirect ?? rendered.recipient;
    if (!(await recipientStillApproved(tx, h, email.policy))) {
      await tx.query(`update public.handoffs set delivery_status = 'failed', last_error = 'recipient no longer approved' where id = $1`, [handoffId]);
      await openTask(tx, { lead_id: h.lead_id, kind: "integration_failure", assigned_role: "front_desk", summary: "Handoff recipient is no longer on the approved roster; reassign manually.", dedupe_key: `handoff:${handoffId}:recipient` });
      return null;
    }
    await tx.query(
      `update public.handoffs set subject = $2, body_text = $3, body_html = $4, delivery_status = 'sending', attempts = attempts + 1 where id = $1`,
      [handoffId, email.subject, email.text, email.html],
    );
    return { h, email, to };
  });
  if (!prepared) return;
  const { h, email, to } = prepared;

  const providers = getProviders(db, { simulated: h.is_simulated });
  const result = await providers.email.send({
    to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    idempotencyKey: `handoff/${handoffId}/${h.recipient_staff_id ?? "queue"}`,
    tags: { lead_id: h.lead_id, purpose: h.purpose },
  });

  const finalAttempt = job.attempts >= job.max_attempts;
  await db.tx(async (tx) => {
    if (result.status === "ok") {
      const sentAt = now();
      const deadlineMin = email.policy?.config.operations.handoff.ack_deadline_minutes ?? null;
      const deadline = deadlineMin && h.ack_required ? new Date(sentAt.getTime() + deadlineMin * 60000) : null;
      const mode = providers.email.mode === "live" ? "live" : "mock";
      await tx.query(
        `update public.handoffs set delivery_status = $2, delivery_mode = $3, provider_message_id = $4, sent_at = $5, ack_deadline_at = $6, last_error = null where id = $1`,
        [handoffId, mode === "live" ? "sent" : "simulated", mode, result.data.id, sentAt, deadline],
      );
      await tx.query(`update public.leads set handoff_status = case when handoff_status = 'acknowledged' then handoff_status else 'sent' end where id = $1`, [h.lead_id]);
      if (deadline && h.purpose !== "ack_escalation") {
        await enqueue(tx, "handoff.ack_check", { handoff_id: handoffId }, `handoff.ack_check:${handoffId}:${sentAt.getTime()}`, { runAfter: deadline });
      }
      await recordUsage(tx, {
        provider: "resend",
        category: "notification",
        meter: "email",
        quantity: 1,
        unit: "email",
        occurredAt: sentAt,
        leadId: h.lead_id,
        isSimulated: h.is_simulated,
        dedupeKey: `usage:resend:${handoffId}:${result.data.id}`,
        resourceRef: result.data.id,
      });
      return;
    }
    const permanent = (result.status === "failed" && !result.retriable) || finalAttempt;
    await tx.query(`update public.handoffs set delivery_status = $2, last_error = $3 where id = $1`, [
      handoffId,
      permanent ? "failed" : "queued",
      result.message.slice(0, 300),
    ]);
    if (permanent) {
      await tx.query(`update public.leads set handoff_status = case when handoff_status = 'acknowledged' then handoff_status else 'failed' end where id = $1`, [h.lead_id]);
      await openTask(tx, {
        lead_id: h.lead_id,
        kind: "integration_failure",
        assigned_role: "front_desk",
        summary: `Handoff email failed (${result.message.slice(0, 120)}). Contact the ${h.recipient_kind === "designer" ? "designer" : "front desk"} directly.`,
        dedupe_key: `handoff:${handoffId}:delivery_failed`,
      });
    }
  });
  if (result.status !== "ok") {
    const permanent = (result.status === "failed" && !result.retriable) || finalAttempt;
    if (permanent) throw new PermanentJobError(`email delivery failed: ${result.message}`);
    throw new RetryableJobError(`email delivery failed: ${result.message}`);
  }
}

export async function ackCheckJob(db: Db, job: Job): Promise<void> {
  const handoffId = String(job.payload.handoff_id);
  await db.tx(async (tx) => {
    const { rows } = await tx.query(`select h.*, l.policy_id from public.handoffs h join public.leads l on l.id = h.lead_id where h.id = $1 for update`, [handoffId]);
    const h = rows[0];
    if (!h || !h.ack_required || h.acknowledged_at || h.ack_overdue_at) return;
    // A re-targeted handoff has a new deadline (and its own check job).
    if (!h.ack_deadline_at || new Date(h.ack_deadline_at).getTime() > now().getTime()) return;
    await tx.query(`update public.handoffs set ack_overdue_at = $2 where id = $1`, [handoffId, now()]);
    await tx.query(`update public.leads set ack_overdue = true where id = $1`, [h.lead_id]);
    await openTask(tx, {
      lead_id: h.lead_id,
      kind: "ack_overdue",
      assigned_role: "front_desk",
      summary: `Handoff to ${h.recipient_kind === "designer" ? "the assigned designer" : "the front-desk queue"} was not accepted by the deadline.`,
      dedupe_key: `handoff:${handoffId}:ack_overdue`,
    });
    const policy = await getPolicyById(tx, h.policy_id);
    if (h.recipient_kind === "designer") await ensureHandoff(tx, h.lead_id, policy, "system", "ack_escalation");
  });
}

// ---------------------------------------------------------------------------------------------

export async function acknowledgeLead(db: Db, staff: StaffActor, leadId: string, requestId: string) {
  return db.tx(async (tx) => {
    // Visibility is decided by row-level security for this staff member.
    const visible = await tx.asStaff(staff.auth_user_id, (q) => q.query(`select id from public.leads where id = $1`, [leadId]));
    if (!visible.rows[0]) throw notFound("Lead");
    const { rows } = await tx.query(
      `select * from public.handoffs where lead_id = $1 and purpose in ('designer_handoff', 'front_desk_review') and ack_required
       order by case purpose when 'designer_handoff' then 0 else 1 end, created_at desc limit 1 for update`,
      [leadId],
    );
    const h = rows[0];
    if (!h) throw new ApiError(409, "no_pending_handoff", "This lead has no handoff to acknowledge");
    const { rows: owner } = await tx.query(`select owner_staff_id from public.leads where id = $1`, [leadId]);
    const allowed =
      staff.role === "admin" ||
      (h.recipient_kind === "designer" && staff.role === "designer" && (h.recipient_staff_id === staff.id || owner[0].owner_staff_id === staff.id)) ||
      (h.recipient_kind === "front_desk_queue" && staff.role === "front_desk");
    if (!allowed) throw forbidden("Only the assigned recipient (or an administrator) can accept this handoff");
    if (h.acknowledged_at) {
      return { handoff_id: h.id, acknowledged_at: h.acknowledged_at, acknowledged_by: h.acknowledged_by, already_acknowledged: true };
    }
    const at = now();
    await tx.query(`update public.handoffs set acknowledged_at = $2, acknowledged_by = $3 where id = $1`, [h.id, at, staff.id]);
    await tx.query(
      `update public.leads set handoff_status = 'acknowledged', ack_overdue = false, version = version + 1,
         owner_staff_id = case when owner_staff_id is null and $2 = 'designer' then $3 else owner_staff_id end
       where id = $1`,
      [leadId, staff.role, staff.id],
    );
    // An earlier front-desk review handoff is superseded once the designer has accepted.
    if (h.purpose === "designer_handoff") {
      await tx.query(
        `update public.handoffs set ack_required = false, last_error = coalesce(last_error, 'superseded: designer accepted the lead')
         where lead_id = $1 and id <> $2 and purpose = 'front_desk_review' and acknowledged_at is null`,
        [leadId, h.id],
      );
    }
    await resolveTasks(tx, leadId, "ack_overdue", staff.id, "Handoff acknowledged");
    await audit(tx, { actor_kind: "staff", actor_staff_id: staff.id, action: "handoff.acknowledged", entity_type: "handoff", entity_id: h.id, after: { lead_id: leadId, latency_seconds: h.sent_at ? Math.round((at.getTime() - new Date(h.sent_at).getTime()) / 1000) : null }, request_id: requestId });
    return { handoff_id: h.id, acknowledged_at: at.toISOString(), acknowledged_by: staff.id, already_acknowledged: false };
  });
}

/**
 * Keeps the open designer handoff aligned with lead ownership after a human reassignment.
 * New owner is an approved designer: the handoff is re-targeted and re-sent to them.
 * Otherwise (front desk/admin, or unassigned): the open designer handoff is superseded.
 */
export async function retargetDesignerHandoff(q: Queryable, leadId: string, newOwnerId: string | null): Promise<"retargeted" | "superseded" | "none"> {
  const { rows } = await q.query(
    `select id, recipient_staff_id from public.handoffs
      where lead_id = $1 and purpose = 'designer_handoff' and ack_required and acknowledged_at is null for update`,
    [leadId],
  );
  const h = rows[0];
  if (!h || h.recipient_staff_id === newOwnerId) return "none";
  const { rows: d } = newOwnerId
    ? await q.query(`select id, email from public.staff where id = $1 and role = 'designer' and active and approved_for_handoff`, [newOwnerId])
    : { rows: [] as Array<{ id: string; email: string }> };
  if (d[0]) {
    await q.query(
      `update public.handoffs set recipient_staff_id = $2, recipient_email = $3, delivery_status = 'queued', delivery_mode = null,
         provider_message_id = null, sent_at = null, ack_deadline_at = null, ack_overdue_at = null, subject = null, body_text = null,
         body_html = null, attempts = 0, last_error = 're-targeted after reassignment'
       where id = $1`,
      [h.id, d[0].id, d[0].email],
    );
    await q.query(`update public.leads set handoff_status = 'pending', ack_overdue = false where id = $1`, [leadId]);
    await enqueue(q, "handoff.send", { handoff_id: h.id }, `handoff.send:${h.id}:${d[0].id}`, { maxAttempts: 6 });
    await resolveTasks(q, leadId, "ack_overdue", null, "Lead reassigned to another designer");
    return "retargeted";
  }
  await q.query(`update public.handoffs set ack_required = false, last_error = 'superseded: lead reassigned' where id = $1`, [h.id]);
  await q.query(`update public.leads set ack_overdue = false where id = $1`, [leadId]);
  await resolveTasks(q, leadId, "ack_overdue", null, "Lead reassigned");
  return "superseded";
}

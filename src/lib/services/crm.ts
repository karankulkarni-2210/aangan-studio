import type { Db, Queryable } from "@/lib/db/types";
import { enqueue, PermanentJobError, RetryableJobError, type Job } from "@/lib/jobs/outbox";
import { getProviders } from "@/lib/providers/registry";
import type { ProviderResult } from "@/lib/providers/types";
import { now } from "@/lib/runtime";
import { openTask } from "./tasks";

// HubSpot sync: match/create a contact, then one OPEN deal per qualified project. Remote IDs are
// stored per object so retries never re-create them. A qualified enquiry is an open deal, not won
// revenue; won/lost outcomes are tracked in outcome_events, separately from qualification.
// CRM failures never block the email handoff (separate jobs) and never lose the lead.

export async function enqueueCrmSync(q: Queryable, leadId: string): Promise<void> {
  await q.query(`update public.leads set crm_status = case when crm_status = 'synced' then crm_status else 'pending' end where id = $1`, [leadId]);
  await enqueue(q, "crm.sync", { lead_id: leadId }, `crm.sync:${leadId}`, { maxAttempts: 6 });
}

async function syncRow(db: Db, leadId: string, kind: "contact" | "deal", mode: "live" | "mock") {
  await db.query(
    `insert into public.integration_syncs (lead_id, provider, object_kind, mode, status) values ($1, 'hubspot', $2, $3, 'pending')
     on conflict (lead_id, provider, object_kind) do nothing`,
    [leadId, kind, mode],
  );
  const { rows } = await db.query(`select * from public.integration_syncs where lead_id = $1 and provider = 'hubspot' and object_kind = $2`, [leadId, kind]);
  return rows[0];
}

async function record<T extends { id: string }>(db: Db, leadId: string, kind: string, result: ProviderResult<T>) {
  if (result.status === "ok") {
    await db.query(
      `update public.integration_syncs set status = 'succeeded', remote_id = $3, attempts = attempts + 1, last_attempt_at = $4, succeeded_at = $4, last_error = null
       where lead_id = $1 and provider = 'hubspot' and object_kind = $2`,
      [leadId, kind, result.data.id, now()],
    );
    return;
  }
  await db.query(
    `update public.integration_syncs set status = $3, attempts = attempts + 1, last_attempt_at = $4, last_error = $5
     where lead_id = $1 and provider = 'hubspot' and object_kind = $2`,
    [leadId, kind, result.status === "ambiguous" ? "ambiguous" : "failed", now(), result.message.slice(0, 300)],
  );
}

export async function crmSyncJob(db: Db, job: Job): Promise<void> {
  const leadId = String(job.payload.lead_id);
  const { rows } = await db.query(`select * from public.leads where id = $1`, [leadId]);
  const lead = rows[0];
  if (!lead) throw new PermanentJobError("lead not found");
  const crm = getProviders(db, { simulated: lead.is_simulated }).crm;
  const mode = crm.mode === "live" ? "live" : "mock";
  const finalAttempt = job.attempts >= job.max_attempts;

  const fail = async (message: string, permanent: boolean) => {
    if (permanent || finalAttempt) {
      await db.query(`update public.leads set crm_status = 'failed' where id = $1`, [leadId]);
      await db.tx((tx) =>
        openTask(tx, { lead_id: leadId, kind: "integration_failure", assigned_role: "admin", summary: `HubSpot sync failed: ${message.slice(0, 150)}. The lead is safe in Supabase; retry or create the deal manually.`, dedupe_key: `crm:${leadId}:failed` }),
      );
      throw new PermanentJobError(message);
    }
    throw new RetryableJobError(message);
  };

  // Contact: reuse a stored id; otherwise match-or-create (an ambiguous create is retried search-first).
  const contactRow = await syncRow(db, leadId, "contact", mode);
  let contactId: string | null = contactRow.status === "succeeded" ? contactRow.remote_id : null;
  if (!contactId) {
    const r = await crm.upsertContact({ name: lead.contact_name, phone: lead.caller_phone, email: lead.contact_email, leadId });
    await record(db, leadId, "contact", r);
    if (r.status !== "ok") return fail(`contact: ${r.message}`, r.status === "failed" && !r.retriable);
    contactId = r.data.id;
  }

  // Deal: idempotent upsert keyed on our lead id.
  const dealRow = await syncRow(db, leadId, "deal", mode);
  if (dealRow.status !== "succeeded") {
    const dealName = `${lead.reference} ${lead.service_type ?? "enquiry"}${lead.location_locality || lead.location_city ? ` (${lead.location_locality ?? lead.location_city})` : ""}`;
    const description = `Qualified phone enquiry ${lead.reference}. Open deal: not won revenue.${lead.is_simulated ? " SIMULATED." : ""}`;
    const r = await crm.upsertDeal({ leadId, dealName, contactId, description });
    await record(db, leadId, "deal", r);
    if (r.status !== "ok") return fail(`deal: ${r.message}`, r.status === "failed" && !r.retriable);
  }
  await db.query(`update public.leads set crm_status = 'synced' where id = $1`, [leadId]);
}

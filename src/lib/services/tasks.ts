import type { Queryable } from "@/lib/db/types";
import type { HumanTaskKind, Role } from "@/lib/domain/enums";

// Human tasks: every escalation, review and exception that needs a person. The dashboard shows
// them as pending until a human resolves them; automation never marks them resolved.

export interface TaskInput {
  lead_id: string | null;
  call_id?: string | null;
  kind: HumanTaskKind;
  assigned_role: Role;
  assigned_staff_id?: string | null;
  summary: string;
  evidence_utterance_id?: string | null;
  dedupe_key: string;
  due_at?: Date | null;
}

/** Idempotent: the same dedupe key never creates a second task. Returns the task id. */
export async function openTask(q: Queryable, t: TaskInput): Promise<{ id: string; created: boolean }> {
  const { rows } = await q.query<{ id: string }>(
    `insert into public.human_tasks (lead_id, call_id, kind, assigned_role, assigned_staff_id, summary, evidence_utterance_id, dedupe_key, due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (dedupe_key) do nothing returning id`,
    [t.lead_id, t.call_id ?? null, t.kind, t.assigned_role, t.assigned_staff_id ?? null, t.summary.slice(0, 500), t.evidence_utterance_id ?? null, t.dedupe_key, t.due_at ?? null],
  );
  if (rows[0]) {
    if (t.lead_id) await refreshLeadEscalations(q, t.lead_id);
    return { id: rows[0].id, created: true };
  }
  const { rows: existing } = await q.query<{ id: string }>(`select id from public.human_tasks where dedupe_key = $1`, [t.dedupe_key]);
  return { id: existing[0].id, created: false };
}

export async function resolveTasks(q: Queryable, leadId: string, kind: HumanTaskKind, staffId: string | null, note: string): Promise<void> {
  await q.query(
    `update public.human_tasks set status = 'resolved', resolved_at = now(), resolved_by = $3, resolution_note = $4
     where lead_id = $1 and kind = $2 and status = 'open'`,
    [leadId, kind, staffId, note],
  );
  await refreshLeadEscalations(q, leadId);
}

export async function refreshLeadEscalations(q: Queryable, leadId: string): Promise<void> {
  await q.query(
    `update public.leads set open_escalations = coalesce((
       select array_agg(distinct kind order by kind) from public.human_tasks where lead_id = $1 and status = 'open'
     ), '{}') where id = $1`,
    [leadId],
  );
}

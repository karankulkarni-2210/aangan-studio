import type { Queryable } from "@/lib/db/types";

export interface AuditInput {
  actor_kind: "staff" | "system" | "voice_service" | "provider";
  actor_staff_id?: string | null;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  before?: unknown;
  after?: unknown;
  request_id?: string | null;
}

/** Append-only audit trail (UPDATE/DELETE are rejected by a trigger). */
export async function audit(q: Queryable, a: AuditInput): Promise<void> {
  await q.query(
    `insert into public.audit_events (actor_kind, actor_staff_id, action, entity_type, entity_id, before, after, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      a.actor_kind,
      a.actor_staff_id ?? null,
      a.action,
      a.entity_type,
      a.entity_id ?? null,
      a.before === undefined ? null : JSON.stringify(a.before),
      a.after === undefined ? null : JSON.stringify(a.after),
      a.request_id ?? null,
    ],
  );
}

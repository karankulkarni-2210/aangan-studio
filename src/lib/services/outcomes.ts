import { z } from "zod";
import type { Db } from "@/lib/db/types";
import { OUTCOMES } from "@/lib/domain/enums";
import { badRequest, notFound } from "@/lib/http/errors";
import type { StaffActor } from "@/lib/http/route";
import { now } from "@/lib/runtime";
import { audit } from "./audit";

// Append-only outcome history. Confirmed contract value is recorded only for `won` and is not
// collected revenue or attributable profit.

export const outcomeBodySchema = z
  .object({
    outcome: z.enum(OUTCOMES),
    occurred_at: z.string().datetime({ offset: true }),
    source: z.enum(["manual", "calcom", "system"]).default("manual"),
    contract_value_paise: z.number().int().positive().max(1e13).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export async function appendOutcome(db: Db, staff: StaffActor, leadId: string, body: z.infer<typeof outcomeBodySchema>, idempotencyKey: string | null, requestId: string) {
  if (body.contract_value_paise !== undefined && body.outcome !== "won") {
    throw badRequest("contract_value_only_for_won", "contract_value_paise may only be supplied with outcome=won");
  }
  const occurred = new Date(body.occurred_at);
  if (occurred.getTime() > now().getTime() + 5 * 60000) throw badRequest("occurred_in_future", "occurred_at cannot be in the future");
  if (body.source !== "manual" && staff.role !== "admin") throw badRequest("source_not_allowed", "Only administrators may record non-manual sources");

  return db.tx(async (tx) => {
    const visible = await tx.asStaff(staff.auth_user_id, (q) => q.query(`select id from public.leads where id = $1`, [leadId]));
    if (!visible.rows[0]) throw notFound("Lead");
    const key = idempotencyKey ? `staff:${staff.id}:${idempotencyKey}` : null;
    if (key) {
      const { rows } = await tx.query(`select * from public.outcome_events where idempotency_key = $1`, [key]);
      if (rows[0]) return { outcome: rows[0], replay: true };
    }
    const { rows } = await tx.query(
      `insert into public.outcome_events (lead_id, outcome, occurred_at, source, contract_value_paise, reason, recorded_by, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [leadId, body.outcome, occurred, body.source, body.contract_value_paise ?? null, body.reason ?? null, staff.id, key],
    );
    // Current outcome = latest by occurred_at (late entries are allowed and land in order).
    await tx.query(
      `update public.leads set outcome_status = (
         select outcome from public.outcome_events where lead_id = $1 order by occurred_at desc, created_at desc limit 1
       ), version = version + 1 where id = $1`,
      [leadId],
    );
    await audit(tx, { actor_kind: "staff", actor_staff_id: staff.id, action: "outcome.appended", entity_type: "lead", entity_id: leadId, after: { outcome: body.outcome, occurred_at: body.occurred_at, contract_value_paise: body.contract_value_paise ?? null }, request_id: requestId });
    return { outcome: rows[0], replay: false };
  });
}

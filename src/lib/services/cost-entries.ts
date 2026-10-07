import { z } from "zod";
import type { Db } from "@/lib/db/types";
import { COST_CATEGORIES } from "@/lib/domain/enums";
import { badRequest } from "@/lib/http/errors";
import type { StaffActor } from "@/lib/http/route";
import { audit } from "./audit";

// Invoiced costs for reconciliation. The supplier currency and FX assumption are preserved; the
// dashboard uses the invoice instead of the estimate for the overlapping period.

export const costEntrySchema = z
  .object({
    provider: z.string().min(2).max(40),
    category: z.enum(COST_CATEGORIES),
    amount_micros: z.number().int().min(0).max(1e15),
    currency: z.string().regex(/^[A-Z]{3}$/),
    fx_rate_to_inr: z.number().positive().max(10000),
    fx_source: z.string().min(3).max(200),
    period_start: z.string().datetime({ offset: true }),
    period_end: z.string().datetime({ offset: true }),
    invoice_ref: z.string().min(1).max(120),
    operating_cost: z.boolean().default(true),
    description: z.string().max(300).optional(),
  })
  .strict();

export async function recordInvoice(db: Db, staff: StaffActor, body: z.infer<typeof costEntrySchema>, requestId: string) {
  if (new Date(body.period_end) <= new Date(body.period_start)) throw badRequest("invalid_period", "period_end must be after period_start");
  return db.tx(async (tx) => {
    const amountPaise = Math.round((body.amount_micros * body.fx_rate_to_inr) / 10_000);
    const { rows } = await tx.query(
      `insert into public.usage_events (provider, category, entry_kind, description, currency, amount_micros, fx_rate_to_inr, fx_source, amount_paise,
         cost_basis, operating_cost, reconciliation_status, invoice_ref, occurred_at, period_start, period_end, dedupe_key, created_by)
       values ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,'invoiced',$9,'reconciled',$10,$11,$11,$12,$13,$14)
       on conflict (dedupe_key) do nothing returning id, amount_paise`,
      [body.provider, body.category, body.description ?? null, body.currency, body.amount_micros, body.fx_rate_to_inr, body.fx_source, amountPaise,
        body.operating_cost, body.invoice_ref, new Date(body.period_start), new Date(body.period_end), `invoice:${body.provider}:${body.invoice_ref}`, staff.id],
    );
    if (!rows[0]) throw badRequest("duplicate_invoice", "This invoice reference is already recorded for the provider");
    await audit(tx, { actor_kind: "staff", actor_staff_id: staff.id, action: "cost.invoice_recorded", entity_type: "usage_event", entity_id: rows[0].id, after: { provider: body.provider, invoice_ref: body.invoice_ref, amount_paise: amountPaise }, request_id: requestId });
    return { id: rows[0].id, amount_paise: rows[0].amount_paise, cost_basis: "invoiced" };
  });
}

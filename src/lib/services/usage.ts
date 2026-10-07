import type { Queryable } from "@/lib/db/types";
import type { CostCategory } from "@/lib/domain/enums";

// Usage ledger. Amounts are computed from the effective rate card in the SUPPLIER currency
// (integer micros) and converted to integer paise with the rate card's recorded FX assumption.
// Usage without a rate card is stored with NULL amounts (unpriced), never as free.
// Bundled meters (e.g. speech inside a voice-minute bundle) are recorded for transparency at zero
// with `bundled_in`, so they are never counted twice.

export interface UsageInput {
  provider: string;
  category: CostCategory;
  meter: string;
  quantity: number;
  unit: string;
  occurredAt: Date;
  callId?: string | null;
  leadId?: string | null;
  isSimulated: boolean;
  dedupeKey: string;
  description?: string;
  resourceRef?: string | null;
}

export async function recordUsage(q: Queryable, u: UsageInput): Promise<void> {
  const { rows } = await q.query(
    `select * from public.rate_cards
      where provider = $1 and meter = $2 and billing = 'per_unit' and effective_from <= $3::date
        and (effective_to is null or effective_to >= $3::date)
      order by effective_from desc limit 1`,
    [u.provider, u.meter, u.occurredAt.toISOString().slice(0, 10)],
  );
  const card = rows[0];
  const amountMicros = card ? Math.round((u.quantity / Number(card.unit_size)) * Number(card.unit_price_micros)) : null;
  const amountPaise = card && amountMicros !== null ? Math.round((amountMicros * Number(card.fx_rate_to_inr)) / 10_000) : null;
  await q.query(
    `insert into public.usage_events (provider, category, entry_kind, meter, description, call_id, lead_id, resource_ref, quantity, unit,
       rate_card_id, currency, amount_micros, fx_rate_to_inr, fx_source, amount_paise, cost_basis, bundled_in, operating_cost,
       is_simulated, is_synthetic_rate, occurred_at, dedupe_key)
     values ($1,$2,'usage',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'estimated',$16,$17,$18,$19,$20,$21)
     on conflict (dedupe_key) do nothing`,
    [
      u.provider,
      u.category,
      u.meter,
      u.description ?? null,
      u.callId ?? null,
      u.leadId ?? null,
      u.resourceRef ?? null,
      u.quantity,
      u.unit,
      card?.id ?? null,
      card?.currency ?? null,
      amountMicros,
      card?.fx_rate_to_inr ?? null,
      card?.fx_source ?? null,
      amountPaise,
      card?.bundled_in ?? null,
      card?.operating_cost ?? true,
      u.isSimulated,
      card?.is_synthetic ?? false,
      u.occurredAt,
      u.dedupeKey,
    ],
  );
}

/** Records Gemini token usage (thinking tokens are billed as output). */
export async function recordExtractionUsage(
  q: Queryable,
  input: { callId: string; leadId: string; isSimulated: boolean; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number; estimated: boolean }; occurredAt: Date; turn: number; extractor: string },
): Promise<void> {
  const desc = `${input.usage.estimated ? "Estimated" : "Reported"} tokens for ${input.extractor}`;
  await recordUsage(q, {
    provider: "gemini",
    category: "ai_inference",
    meter: "input_tokens",
    quantity: input.usage.inputTokens,
    unit: "tokens",
    occurredAt: input.occurredAt,
    callId: input.callId,
    leadId: input.leadId,
    isSimulated: input.isSimulated,
    dedupeKey: `usage:gemini:in:${input.callId}:${input.turn}`,
    description: desc,
  });
  await recordUsage(q, {
    provider: "gemini",
    category: "ai_inference",
    meter: "output_tokens",
    quantity: input.usage.outputTokens + input.usage.thinkingTokens,
    unit: "tokens",
    occurredAt: input.occurredAt,
    callId: input.callId,
    leadId: input.leadId,
    isSimulated: input.isSimulated,
    dedupeKey: `usage:gemini:out:${input.callId}:${input.turn}`,
    description: desc,
  });
}

import policy from "../../../config/policy.demo.json";

// Demo seed: synthetic staff roster, the sample policy (published as v1) and rate cards.
// Everything is labelled demo/synthetic. supabase/seed.sql is GENERATED from this module
// (npm run seed:generate) and a test fails if they drift.

export const DEMO_STAFF = [
  { key: "admin", auth: "00000000-0000-4000-8000-000000000001", role: "admin", name: "Nikhil (demo admin)", email: "nikhil.demo@aangan-demo.example", services: [] as string[], handoff: false },
  { key: "front_desk", auth: "00000000-0000-4000-8000-000000000002", role: "front_desk", name: "Front desk A (demo)", email: "frontdesk.a@aangan-demo.example", services: [], handoff: false },
  { key: "front_desk_b", auth: "00000000-0000-4000-8000-000000000003", role: "front_desk", name: "Front desk B (demo)", email: "frontdesk.b@aangan-demo.example", services: [], handoff: false },
  { key: "designer", auth: "00000000-0000-4000-8000-000000000011", role: "designer", name: "Designer Asha (demo)", email: "asha.demo@aangan-demo.example", services: ["full_home_interiors"], handoff: true },
  { key: "designer_b", auth: "00000000-0000-4000-8000-000000000012", role: "designer", name: "Designer Vikram (demo)", email: "vikram.demo@aangan-demo.example", services: ["small_office_interiors", "full_home_interiors"], handoff: true },
  { key: "designer_c", auth: "00000000-0000-4000-8000-000000000013", role: "designer", name: "Designer Neha (demo)", email: "neha.demo@aangan-demo.example", services: [], handoff: true },
] as const;

export type DemoStaffKey = (typeof DEMO_STAFF)[number]["key"];

const FX_USD = { rate: 88, source: "Synthetic planning assumption (not a market rate), 2026-10-07" };
const INR = { rate: 1, source: "INR native" };

export const DEMO_RATE_CARDS = [
  { provider: "vaani", category: "voice_telephony", meter: "voice_minute", unit: "minute", size: 1, micros: 2_400_000, currency: "INR", fx: INR, billing: "per_unit", bundled: null, includes: ["stt", "tts", "agent_llm"], synthetic: true, operating: true,
    notes: "Vaani published voicebot rate: 4 paise/second billed per started minute (docs checked 2026-10-07). Inbound phone/telephony pricing is UNVERIFIED." },
  { provider: "vaani", category: "speech", meter: "speech_bundle", unit: "minute", size: 1, micros: 0, currency: "INR", fx: INR, billing: "per_unit", bundled: "vaani:voice_minute", includes: [], synthetic: false, operating: true,
    notes: "Speech recognition/synthesis included in the Vaani minute. Recorded at zero so it is never counted twice." },
  { provider: "gemini", category: "ai_inference", meter: "input_tokens", unit: "tokens", size: 1_000_000, micros: 750_000, currency: "USD", fx: FX_USD, billing: "per_unit", bundled: null, includes: [], synthetic: true, operating: true,
    notes: "gemini-3.8-flash paid Standard input price, introductory until 2026-12-31 (docs checked 2026-10-07). FX is a synthetic assumption." },
  { provider: "gemini", category: "ai_inference", meter: "output_tokens", unit: "tokens", size: 1_000_000, micros: 3_750_000, currency: "USD", fx: FX_USD, billing: "per_unit", bundled: null, includes: ["thinking_tokens"], synthetic: true, operating: true,
    notes: "gemini-3.8-flash output price incl. thinking tokens, introductory until 2026-12-31. FX is a synthetic assumption." },
  { provider: "resend", category: "notification", meter: "email", unit: "email", size: 1, micros: 0, currency: "USD", fx: FX_USD, billing: "per_unit", bundled: "resend:monthly_plan", includes: [], synthetic: true, operating: true,
    notes: "Assumed covered by the monthly plan placeholder below." },
  { provider: "resend", category: "notification", meter: "monthly_plan", unit: "month", size: 1, micros: 20_000_000, currency: "USD", fx: FX_USD, billing: "fixed_monthly", bundled: null, includes: [], synthetic: true, operating: true,
    notes: "SYNTHETIC placeholder plan charge. Replace with the actual invoice." },
  { provider: "calcom", category: "calendar", meter: "monthly_plan", unit: "month", size: 1, micros: 15_000_000, currency: "USD", fx: FX_USD, billing: "fixed_monthly", bundled: null, includes: [], synthetic: true, operating: true,
    notes: "SYNTHETIC placeholder plan charge. Replace with the actual invoice." },
  { provider: "hubspot", category: "crm", meter: "monthly_plan", unit: "month", size: 1, micros: 20_000_000, currency: "USD", fx: FX_USD, billing: "fixed_monthly", bundled: null, includes: [], synthetic: true, operating: true,
    notes: "SYNTHETIC placeholder plan charge. Replace with the actual invoice." },
  { provider: "vercel", category: "hosting", meter: "monthly_plan", unit: "month", size: 1, micros: 20_000_000, currency: "USD", fx: FX_USD, billing: "fixed_monthly", bundled: null, includes: [], synthetic: true, operating: true,
    notes: "SYNTHETIC placeholder. Hobby is for non-commercial use; per-minute cron needs Pro or Supabase Cron." },
  { provider: "supabase", category: "database_storage", meter: "monthly_plan", unit: "month", size: 1, micros: 25_000_000, currency: "USD", fx: FX_USD, billing: "fixed_monthly", bundled: null, includes: [], synthetic: true, operating: true,
    notes: "SYNTHETIC placeholder plan charge. Replace with the actual invoice." },
  { provider: "github", category: "source_control", meter: "monthly_plan", unit: "month", size: 1, micros: 4_000_000, currency: "USD", fx: FX_USD, billing: "fixed_monthly", bundled: null, includes: [], synthetic: true, operating: true,
    notes: "SYNTHETIC placeholder plan charge. Replace with the actual invoice." },
  { provider: "claude", category: "development_tools", meter: "monthly_plan", unit: "month", size: 1, micros: 20_000_000, currency: "USD", fx: FX_USD, billing: "fixed_monthly", bundled: null, includes: [], synthetic: true, operating: false,
    notes: "Development tool subscription (Claude Chat/Code). Tracked separately; excluded from runtime operating cost." },
] as const;

const lit = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
const arr = (xs: readonly string[]) => (xs.length ? `array[${xs.map(lit).join(", ")}]::text[]` : `'{}'::text[]`);

export function demoSeedSql(): string {
  const lines: string[] = [
    "-- GENERATED by `npm run seed:generate` from src/lib/seed/demo.ts and config/policy.demo.json. Do not edit by hand.",
    "-- DEMO DATA AND SAMPLE BUSINESS RULES: synthetic staff, invented policy, synthetic/placeholder rates.",
    "",
    "insert into public.staff (auth_user_id, role, display_name, email, active, approved_for_handoff, services, is_demo) values",
    DEMO_STAFF.map((s) => `  (${lit(s.auth)}, ${lit(s.role)}, ${lit(s.name)}, ${lit(s.email)}, true, ${s.handoff}, ${arr(s.services)}, true)`).join(",\n") +
      "\non conflict (email) do nothing;",
    "",
    "insert into public.business_policies (version, status, label, is_demo, config, validation, published_at)",
    `select 1, 'active', ${lit(policy.label)}, true, $policy$${JSON.stringify(policy)}$policy$::jsonb, '{"ok": true, "issues": []}'::jsonb, now()`,
    "where not exists (select 1 from public.business_policies);",
    "",
    "insert into public.rate_cards (provider, category, meter, unit, unit_size, unit_price_micros, currency, fx_rate_to_inr, fx_source, billing, bundled_in, includes, is_synthetic, operating_cost, effective_from, notes) values",
    DEMO_RATE_CARDS.map(
      (r) =>
        `  (${lit(r.provider)}, ${lit(r.category)}, ${lit(r.meter)}, ${lit(r.unit)}, ${r.size}, ${r.micros}, ${lit(r.currency)}, ${r.fx.rate}, ${lit(r.fx.source)}, ${lit(r.billing)}, ${lit(r.bundled)}, ${arr(r.includes)}, ${r.synthetic}, ${r.operating}, '2026-01-01', ${lit(r.notes)})`,
    ).join(",\n") + "\non conflict (provider, meter, effective_from) do nothing;",
    "",
  ];
  return lines.join("\n");
}

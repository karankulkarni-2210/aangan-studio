import { describe, expect, it } from "vitest";
import policyJson from "../../config/policy.demo.json";
import { FACT_FIELDS, type FactField } from "@/lib/domain/enums";
import { resolveFacts, resolveField, type EvidenceRecord, type FactValue } from "@/lib/domain/facts";
import { evaluateQualification } from "@/lib/domain/qualification";
import { validatePolicyConfig, type PolicyConfig } from "@/lib/policy/schema";

const v = validatePolicyConfig(policyJson);
if (!v.ok) throw new Error("demo policy invalid");
const policy: PolicyConfig = v.config;

let n = 0;
const ev = (field: FactField, value: FactValue, status: EvidenceRecord["status"] = "stated", ambiguity: string[] = []): EvidenceRecord => ({
  id: `e${++n}`,
  field,
  value,
  status,
  ambiguity: ambiguity as EvidenceRecord["ambiguity"],
  source: status === "confirmed" ? "caller_confirmation" : "ai_extraction",
  quote: "q",
  utterance_id: null,
  created_at: new Date(Date.UTC(2026, 9, 7, 0, 0, n)),
});

const good = (): EvidenceRecord[] => [
  ev("service", { kind: "service", service_id: "full_home_interiors", description: "full home" }),
  ev("location", { kind: "location", city: "Pune", locality: "Baner", in_area: true }),
  ev("area", { kind: "area", sqft: 1250, original_value: 1250, original_unit: "sqft", basis: "carpet" }, "confirmed"),
  ev("budget", { kind: "budget", paise: 150_000_000, range_max_paise: null }),
  ev("timeline", { kind: "timeline", months: 1, text: "next month" }),
  ev("contact_name", { kind: "text", text: "Demo Caller" }),
  ev("callback_preference", { kind: "text", text: "evenings" }),
];

function decide(evidence: EvidenceRecord[], over: Partial<{ intent: "new_project" | "vendor_or_job" | null; discoveryIncomplete: boolean; injectionSuspected: boolean; policy: PolicyConfig | null }> = {}) {
  return evaluateQualification({
    policy: over.policy === undefined ? policy : over.policy,
    facts: resolveFacts(FACT_FIELDS, evidence),
    intent: over.intent === undefined ? "new_project" : over.intent,
    discoveryIncomplete: over.discoveryIncomplete ?? false,
    injectionSuspected: over.injectionSuspected ?? false,
  });
}
const replace = (field: FactField, e: EvidenceRecord | null) => [...good().filter((x) => x.field !== field), ...(e ? [e] : [])];

describe("fact resolution", () => {
  it("agreeing evidence is stated; a later confirmation wins", () => {
    const a = ev("area", { kind: "area", sqft: 1200, original_value: 1200, original_unit: null, basis: "unspecified" }, "needs_confirmation", ["unit_missing"]);
    expect(resolveField("area", [a]).status).toBe("unconfirmed");
    const c = ev("area", { kind: "area", sqft: 1200, original_value: 1200, original_unit: null, basis: "unspecified" }, "confirmed");
    expect(resolveField("area", [a, c]).status).toBe("confirmed");
  });
  it("conflicting statements are contradictory, never averaged", () => {
    const r = resolveField("budget", [ev("budget", { kind: "budget", paise: 1e8, range_max_paise: null }), ev("budget", { kind: "budget", paise: 2e8, range_max_paise: null })]);
    expect(r.status).toBe("contradictory");
    expect(r.value).toBeNull();
  });
  it("a declined answer resolves to declined, not zero", () => {
    expect(resolveField("budget", [ev("budget", { kind: "declined" })])).toMatchObject({ status: "declined", value: { kind: "declined" } });
  });
});

describe("qualification decision table (demo policy)", () => {
  it("all criteria met -> qualified", () => {
    expect(decide(good()).decision).toBe("qualified");
  });
  it("unsupported service -> not_fit", () => {
    const r = decide(replace("service", ev("service", { kind: "service", service_id: "structural_construction", description: "build" })));
    expect(r.decision).toBe("not_fit");
    expect(r.reasons.find((x) => x.rule_id === "SERVICE_SUPPORTED")).toMatchObject({ result: "fail", effect: "not_fit" });
  });
  it("missing budget -> needs_review (not rejection)", () => {
    const r = decide(replace("budget", null));
    expect(r.decision).toBe("needs_review");
    expect(r.missing_fields).toContain("budget");
  });
  it("declined budget -> needs_review", () => {
    expect(decide(replace("budget", ev("budget", { kind: "declined" }))).decision).toBe("needs_review");
  });
  it("budget below the demo threshold -> not_fit", () => {
    expect(decide(replace("budget", ev("budget", { kind: "budget", paise: 50_000_000, range_max_paise: null }))).decision).toBe("not_fit");
  });
  it("start beyond six months -> needs_review", () => {
    expect(decide(replace("timeline", ev("timeline", { kind: "timeline", months: 9, text: "next summer" }))).decision).toBe("needs_review");
  });
  it("stated but unconfirmed area -> needs_review", () => {
    const r = decide(replace("area", ev("area", { kind: "area", sqft: 1250, original_value: 1250, original_unit: "sqft", basis: "carpet" })));
    expect(r.decision).toBe("needs_review");
    expect(r.reasons.find((x) => x.rule_id === "AREA_POSITIVE_CONFIRMED")?.result).toBe("unconfirmed");
  });
  it("unknown place -> needs_review; known outside place -> not_fit", () => {
    expect(decide(replace("location", ev("location", { kind: "location", city: "Erandwane-ish", locality: null, in_area: null }))).decision).toBe("needs_review");
    expect(decide(replace("location", ev("location", { kind: "location", city: "mumbai", locality: null, in_area: false }))).decision).toBe("not_fit");
  });
  it("contradictory facts -> needs_review", () => {
    const evs = [...good(), ev("budget", { kind: "budget", paise: 300_000_000, range_max_paise: null })];
    const r = decide(evs);
    expect(r.decision).toBe("needs_review");
    expect(r.contradictory_fields).toContain("budget");
  });
  it("non-project intent -> needs_review", () => {
    expect(decide(good(), { intent: "vendor_or_job" }).decision).toBe("needs_review");
  });
  it("missing policy -> needs_review with POLICY_MISSING", () => {
    const r = decide(good(), { policy: null });
    expect(r.decision).toBe("needs_review");
    expect(r.reasons[0].rule_id).toBe("POLICY_MISSING");
  });
  it("interrupted discovery or suspected injection force review", () => {
    expect(decide(good(), { discoveryIncomplete: true }).decision).toBe("needs_review");
    expect(decide(good(), { injectionSuspected: true }).decision).toBe("needs_review");
  });
  it("a definite not_fit outranks missing facts", () => {
    const evs = replace("budget", null).filter((e) => e.field !== "service");
    evs.push(ev("service", { kind: "service", service_id: "structural_construction", description: "construction" }));
    expect(decide(evs).decision).toBe("not_fit");
  });
});

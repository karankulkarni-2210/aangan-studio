import { describe, expect, it } from "vitest";
import policyJson from "../../config/policy.demo.json";
import { validatePolicyConfig } from "@/lib/policy/schema";

describe("policy validation", () => {
  it("Nikhil's policy is valid, carries no prices, and is not labelled as demo", () => {
    const v = validatePolicyConfig(policyJson);
    expect(v.ok).toBe(true);
    expect(policyJson.demo).toBe(false);
    expect(JSON.stringify(policyJson)).not.toMatch(/₹|per sq|\/sq ?ft|1,800|2,400|3,500/);
  });
  it("rejects duplicate rule ids and unsupported services without a boundary script", () => {
    const bad = structuredClone(policyJson);
    bad.qualification_rules.push({ ...bad.qualification_rules[0] });
    (bad.services[2] as { decline_script: string | null }).decline_script = null;
    const v = validatePolicyConfig(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["duplicate_rule_id", "missing_decline_script"]));
  });
  it("rejects unknown keys such as a pricing table", () => {
    const v = validatePolicyConfig({ ...policyJson, pricing: { per_sqft_inr: 1500 } });
    expect(v.ok).toBe(false);
  });
});

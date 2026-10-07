import { describe, expect, it } from "vitest";
import policy from "../../config/policy.demo.json";
import { assertSpeakable, inspectSpeech } from "@/lib/domain/speech-guard";
import { FALLBACK_SCRIPT } from "@/lib/services/calls";
import { validatePolicyConfig } from "@/lib/policy/schema";

describe("pricing/commitment speech guard (The Cut)", () => {
  it.each([
    "Our rate is ₹1,500 per square foot.",
    "It would be around 1500 rupees per sq ft.",
    "For your flat the total is 12 lakh.",
    "Projects like this usually cost 8 to 10 lakh.",
    "Indicatively, about twelve lakh rupees, but it varies by site.",
    "We charge Rs 1800/sqft.",
    "Interiors start at 1,800 psf.",
    "Prices starting from 1800.",
    "We can give a 10% off this month.",
    "GST is extra.",
    "We will finish by March.",
    "We guarantee the price.",
    "That comes to about 1.2 crore.",
  ])("blocks %s", (text) => {
    expect(inspectSpeech(text).blocked).toBe(true);
  });

  it.each([
    "Just to confirm, that is about 1,250 square feet, carpet area?",
    "Your consultation is booked for Thursday, 9 October at 2:30 pm.",
    "Could you tell me that budget figure again, including whether it is in lakh or crore?",
    "A designer will confirm pricing after reviewing your scope. I can capture your details and help book a consultation.",
    "Roughly how large is the space, and is that carpet area or built-up area?",
    FALLBACK_SCRIPT,
  ])("allows %s", (text) => {
    expect(inspectSpeech(text)).toEqual({ blocked: false, codes: [] });
  });

  it("every demo policy script passes the guard", () => {
    const v = validatePolicyConfig(policy);
    expect(v.ok).toBe(true);
  });

  it("an indicative-range disclaimer does not make a price speakable", () => {
    const bad = structuredClone(policy) as typeof policy;
    bad.escalation.pricing_request.say = "Indicative only, varies by site: roughly ₹1,400 to ₹1,900 per sq ft.";
    const v = validatePolicyConfig(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.map((i) => i.code)).toContain("pricing_or_commitment_in_script");
  });

  it("assertSpeakable walks nested responses", () => {
    expect(() => assertSpeakable({ say: ["ok"], next: { prompt: "fine" } })).not.toThrow();
    expect(() => assertSpeakable({ say: ["ok"], next: { prompt: "That is 9 lakh total." } })).toThrow(/speech guard/);
  });
});

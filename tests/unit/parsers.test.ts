import { describe, expect, it } from "vitest";
import { parseArea, parseMoney, parseTimeline, quoteAppearsIn } from "@/lib/domain/parsers";

const NOW = new Date("2026-10-07T06:00:00Z");

describe("money parser (integer paise)", () => {
  it.each([
    ["around 15 lakh", 150_000_000, []],
    ["₹12,00,000", 120_000_000, []],
    ["1.2 crore", 1_200_000_000, []],
    ["twelve lakh rupees", 120_000_000, []],
    ["50k", 5_000_000, []],
  ])("%s", (text, paise, amb) => {
    const r = parseMoney(text as string)!;
    expect(r.paise).toBe(paise);
    for (const a of amb as string[]) expect(r.ambiguity).toContain(a);
  });
  it("treats ranges conservatively (lower bound) and flags them", () => {
    const r = parseMoney("eight to ten lakh")!;
    expect(r.paise).toBe(80_000_000);
    expect(r.rangeMaxPaise).toBe(100_000_000);
    expect(r.ambiguity).toContain("range_given");
  });
  it("flags a bare number as ambiguous instead of guessing a unit", () => {
    const r = parseMoney("around 12")!;
    expect(r.ambiguity).toEqual(expect.arrayContaining(["unit_missing", "magnitude_unclear"]));
  });
});

describe("area parser (square feet + basis)", () => {
  it("parses square feet with carpet basis", () => {
    expect(parseArea("about 1,250 square feet, carpet area")).toMatchObject({ sqft: 1250, originalUnit: "sqft", basis: "carpet" });
  });
  it("converts square metres and flags the conversion", () => {
    const r = parseArea("110 square metres") as { sqft: number; ambiguity: string[] };
    expect(r.sqft).toBeCloseTo(1184.03, 1);
    expect(r.ambiguity).toContain("unit_converted");
  });
  it("flags a missing unit (ambiguous area units)", () => {
    expect(parseArea("It's 1200.")).toMatchObject({ sqft: 1200, originalUnit: null, ambiguity: ["unit_missing"] });
  });
  it("does not treat a BHK count as an area", () => {
    expect(parseArea("it's a 3BHK")).toEqual({ notAnArea: true });
  });
  it("distinguishes super built-up from built-up", () => {
    expect(parseArea("1500 sq ft super built-up")).toMatchObject({ basis: "super_built_up" });
    expect(parseArea("1500 sq ft built-up")).toMatchObject({ basis: "built_up" });
  });
});

describe("timeline parser (months)", () => {
  it.each([
    ["start next month", 1],
    ["in 3 months", 3],
    ["within six months", 6],
    ["as soon as possible", 0],
    ["in about two weeks", 0.46],
  ])("%s", (text, months) => {
    expect(parseTimeline(text as string, NOW)!.months).toBeCloseTo(months as number, 1);
  });
  it("computes calendar months relative to now in IST", () => {
    expect(parseTimeline("by March", NOW)).toMatchObject({ months: 5, ambiguity: ["relative_date"] });
  });
});

describe("evidence quotes", () => {
  it("matches ignoring case, punctuation and spacing", () => {
    expect(quoteAppearsIn("Full home interiors", "we're looking for full-home  interiors.")).toBe(true);
    expect(quoteAppearsIn("office interiors", "we need full home interiors")).toBe(false);
  });
});

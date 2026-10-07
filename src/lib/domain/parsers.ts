// Deterministic parsers used to re-check every numeric value the model extracts.
// The model proposes; these parsers decide. Disagreement or missing units => blocking ambiguity.

import type { Ambiguity, AreaBasis } from "./enums";

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_RE = new RegExp(
  `\\b(?:${[...Object.keys(UNITS), ...Object.keys(TENS), "hundred", "a"].join("|")})(?:[\\s-]+(?:${[
    ...Object.keys(UNITS),
    ...Object.keys(TENS),
    "hundred",
    "and",
  ].join("|")}))*\\b`,
  "gi",
);

function wordsToNumber(phrase: string): number | null {
  const tokens = phrase.toLowerCase().split(/[\s-]+/).filter((t) => t && t !== "and");
  if (tokens.length === 1 && tokens[0] === "a") return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (t === "a") {
      current = 1;
      seen = true;
    } else if (t in UNITS) {
      current += UNITS[t];
      seen = true;
    } else if (t in TENS) {
      current += TENS[t];
      seen = true;
    } else if (t === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else return null;
  }
  total += current;
  return seen ? total : null;
}

/** Lower-cases, joins Indian digit grouping (12,00,000) and converts simple number words to digits. */
export function normaliseNumbers(text: string): string {
  let s = text.toLowerCase().replace(/(\d),(?=\d)/g, "$1");
  s = s.replace(/\bone and a half\b/g, "1.5").replace(/\b(\d+) and a half\b/g, (_, n) => String(Number(n) + 0.5));
  s = s.replace(/\bhalf\b(?=\s+(?:a\s+)?(?:crore|cr|lakh|lac))/g, "0.5");
  s = s.replace(WORD_RE, (m) => {
    // "a" on its own is an article unless followed by a multiplier like "a lakh".
    const n = wordsToNumber(m);
    return n === null ? m : String(n);
  });
  return s;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;

// ---------------------------------------------------------------------------------------------
// Money (caller-stated budget). Returned in integer paise.

export interface MoneyParse {
  paise: number;
  rangeMaxPaise: number | null;
  ambiguity: Ambiguity[];
}

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(?:crores?|cr)$/, 1e7],
  [/^(?:lakhs?|lacs?|l)$/, 1e5],
  [/^(?:thousand|k)$/, 1e3],
];

function multiplierFor(unit: string): number | null {
  for (const [re, m] of MULTIPLIERS) if (re.test(unit)) return m;
  return null;
}

const toPaise = (rupees: number) => Math.round(rupees * 100);

export function parseMoney(text: string): MoneyParse | null {
  const s = normaliseNumbers(text);
  const unit = String.raw`(crores?|cr|lakhs?|lacs?|l|thousand|k)\b`;
  const range = new RegExp(String.raw`${NUM}\s*(?:-|to|–|or)\s*${NUM}\s*${unit}`).exec(s);
  if (range) {
    const m = multiplierFor(range[3])!;
    const lo = Number(range[1]) * m;
    const hi = Number(range[2]) * m;
    return { paise: toPaise(Math.min(lo, hi)), rangeMaxPaise: toPaise(Math.max(lo, hi)), ambiguity: ["range_given"] };
  }
  const withUnit = new RegExp(String.raw`(?:₹|rs\.?|inr)?\s*${NUM}\s*${unit}`).exec(s);
  if (withUnit) {
    const m = multiplierFor(withUnit[2])!;
    return { paise: toPaise(Number(withUnit[1]) * m), rangeMaxPaise: null, ambiguity: approx(s) };
  }
  const rupees =
    new RegExp(String.raw`(?:₹|rs\.?|inr)\s*${NUM}`).exec(s) ?? new RegExp(String.raw`${NUM}\s*(?:rupees?|rs\b)`).exec(s);
  if (rupees) {
    const value = Number(rupees[1]);
    // "₹12" for an interiors budget is almost certainly a missing multiplier.
    const ambiguity: Ambiguity[] = value < 10000 ? ["magnitude_unclear"] : approx(s);
    return { paise: toPaise(value), rangeMaxPaise: null, ambiguity };
  }
  const bare = new RegExp(String.raw`(?:^|\s)${NUM}(?:\s|$|[.?!])`).exec(s);
  if (bare) return { paise: toPaise(Number(bare[1])), rangeMaxPaise: null, ambiguity: ["unit_missing", "magnitude_unclear"] };
  return null;
}

function approx(s: string): Ambiguity[] {
  return /\b(?:about|around|approx|approximately|roughly|maybe|max|upto|up to)\b/.test(s) ? ["approximate"] : [];
}

// ---------------------------------------------------------------------------------------------
// Area. Normalised to square feet with the caller's basis (carpet / built-up / super built-up).

export interface AreaParse {
  sqft: number;
  originalValue: number;
  originalUnit: "sqft" | "sqm" | "sqyd" | null;
  basis: AreaBasis;
  ambiguity: Ambiguity[];
}

const SQFT = String.raw`(?:sq\.?\s*(?:ft|feet|foot)|sqft|sft|square\s*(?:feet|foot|ft))`;
const SQM = String.raw`(?:sq\.?\s*(?:m|mtrs?|metres?|meters?)|sqm|square\s*(?:metres?|meters?|mtrs?))`;
const SQYD = String.raw`(?:sq\.?\s*(?:yd|yards?)|square\s*yards?|gaj)`;

export function parseAreaBasis(text: string): AreaBasis {
  const s = text.toLowerCase();
  if (/super\s*built[\s-]*up|super\s*area|saleable/.test(s)) return "super_built_up";
  if (/built[\s-]*up/.test(s)) return "built_up";
  if (/carpet/.test(s)) return "carpet";
  return "unspecified";
}

export function parseArea(text: string): AreaParse | { notAnArea: true } | null {
  const s = normaliseNumbers(text);
  const basis = parseAreaBasis(s);
  const tryUnit = (unitRe: string, unit: "sqft" | "sqm" | "sqyd", factor: number): AreaParse | null => {
    const range = new RegExp(String.raw`${NUM}\s*(?:-|to|–)\s*${NUM}\s*${unitRe}`).exec(s);
    const single = new RegExp(String.raw`${NUM}\s*${unitRe}`).exec(s);
    const m = range ?? single;
    if (!m) return null;
    const value = Number(m[1]);
    const ambiguity: Ambiguity[] = [];
    if (range) ambiguity.push("range_given");
    if (unit !== "sqft") ambiguity.push("unit_converted");
    ambiguity.push(...approx(s));
    return { sqft: Math.round(value * factor * 100) / 100, originalValue: value, originalUnit: unit, basis, ambiguity };
  };
  const parsed = tryUnit(SQFT, "sqft", 1) ?? tryUnit(SQM, "sqm", 10.7639) ?? tryUnit(SQYD, "sqyd", 9);
  if (parsed) return parsed;
  const bare = new RegExp(String.raw`(?:^|\s)${NUM}(?!\s*(?:bhk|rk|bedroom|floor|storey|years?|months?|lakh|crore|k)\b)`).exec(s);
  if (bare && Number(bare[1]) > 0) {
    return { sqft: Number(bare[1]), originalValue: Number(bare[1]), originalUnit: null, basis, ambiguity: ["unit_missing"] };
  }
  if (/\b\d+\s*(?:bhk|rk|bedroom)/.test(s)) return { notAnArea: true };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Timeline: months from "now" until the caller wants to start.

export interface TimelineParse {
  months: number;
  ambiguity: Ambiguity[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseTimeline(text: string, now: Date): TimelineParse | null {
  const s = normaliseNumbers(text);
  if (/\b(?:immediately|asap|as soon as possible|right away|right now|this month|urgent(?:ly)?)\b/.test(s)) {
    return { months: 0, ambiguity: [] };
  }
  if (/\bnext month\b/.test(s)) return { months: 1, ambiguity: [] };
  const span = new RegExp(String.raw`${NUM}\s*(?:-|to|–|or)?\s*(?:\d+(?:\.\d+)?\s*)?(months?|weeks?|years?)\b`).exec(s);
  if (span) {
    const n = Number(span[1]);
    const unit = span[2];
    const months = unit.startsWith("week") ? n / 4.345 : unit.startsWith("year") ? n * 12 : n;
    return { months: Math.round(months * 100) / 100, ambiguity: approx(s) };
  }
  if (/\b(?:a|one)\s+year\b|\bnext year\b/.test(s)) return { months: 12, ambiguity: ["relative_date"] };
  for (let i = 0; i < MONTHS.length; i++) {
    const name = MONTHS[i];
    if (name === "may" && !/\b(?:in|by|from|after|before|around)\s+may\b/.test(s)) continue;
    if (new RegExp(String.raw`\b${name}\b|\b${name.slice(0, 3)}\b`).test(s)) {
      // Calendar months in IST from the current month.
      const current = Number(new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: "Asia/Kolkata" }).format(now)) - 1;
      let diff = i - current;
      if (diff < 0) diff += 12;
      return { months: diff, ambiguity: ["relative_date"] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Text helpers.

export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `quote` appears in `utterance`, ignoring case, punctuation and spacing. */
export function quoteAppearsIn(quote: string, utterance: string): boolean {
  const q = normaliseForMatch(quote);
  return q.length > 0 && normaliseForMatch(utterance).includes(q);
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  const h = ` ${normaliseForMatch(haystack)} `;
  const p = normaliseForMatch(phrase);
  return p.length > 0 && h.includes(` ${p} `);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value) && value.length <= 254;
}

// The Cut (Checks 06/07): no autonomous customer-facing pricing. This guard is applied to
// every server-authored string the voice agent may speak, to policy scripts at validation time,
// and to agent utterances in transcripts (monitoring). A disclaimer does not make a price safe,
// so there is no "indicative" exception.

const NUMBER_WORDS =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|paanch|das|bees|pachaas|sau|hazaar";
const NUMBER = `(?:\\d[\\d,]*(?:\\.\\d+)?|(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}))*)`;
const CURRENCY_BEFORE = `(?:₹|rs\\.?|inr|rupees?)`;
const CURRENCY_AFTER = `(?:rupees?|rs\\.?|inr|lakhs?|lacs?|crores?|cr\\b|k\\s*(?:rupees|rs|inr)|thousand\\s+(?:rupees|rs))`;

const PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: "currency_amount", re: new RegExp(`${CURRENCY_BEFORE}\\s*${NUMBER}`, "i") },
  { code: "currency_amount", re: new RegExp(`\\b${NUMBER}\\s*(?:-|to|–)?\\s*(?:${NUMBER}\\s*)?${CURRENCY_AFTER}`, "i") },
  { code: "rate_unit", re: /(?:\bper|\/|\ba|\ban)\s*(?:sq\.?\s*(?:ft|feet|foot|m|metre|meter|yd)|square\s*(?:feet|foot|metre|meter|yard)|sft|sqft)\b/i },
  { code: "rate_unit", re: /\bpsf\b/i },
  { code: "discount_or_tax", re: /\b(?:discount|gst|tax(?:es)?|\d+\s*%\s*off|free\s+of\s+cost)\b/i },
  { code: "commitment", re: /\b(?:guarantee[ds]?|we\s+will\s+(?:finish|complete|deliver|hand\s*over)|(?:completed|ready|done|delivered)\s+by\s+\w+)/i },
  { code: "total_or_estimate", re: new RegExp(`\\b(?:total|estimate[ds]?|quote[ds]?|costs?|price[ds]?|charges?|starting)\\b[^.?!]{0,30}?\\b${NUMBER}`, "i") },
];

export interface GuardResult {
  blocked: boolean;
  codes: string[];
}

export function inspectSpeech(text: string): GuardResult {
  const codes = new Set<string>();
  for (const { code, re } of PATTERNS) {
    if (re.test(text)) codes.add(code);
  }
  return { blocked: codes.size > 0, codes: [...codes] };
}

export class SpeechGuardError extends Error {
  constructor(
    readonly field: string,
    readonly codes: string[],
  ) {
    super(`speech guard blocked ${field}: ${codes.join(", ")}`);
  }
}

/**
 * Recursively checks every string under keys that the voice agent may speak.
 * Throws so a programming error can never silently emit a price.
 */
export function assertSpeakable(value: unknown, path = "response"): void {
  if (typeof value === "string") {
    const result = inspectSpeech(value);
    if (result.blocked) throw new SpeechGuardError(path, result.codes);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSpeakable(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertSpeakable(v, `${path}.${k}`);
  }
}

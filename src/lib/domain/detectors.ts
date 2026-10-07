import type { EscalationKind } from "./enums";
import { normaliseForMatch } from "./parsers";

// Deterministic backstops for things that must not depend on the model noticing them.
// They run over CALLER utterances (data, never instructions).

const DETECTORS: Array<{ kind: EscalationKind; re: RegExp }> = [
  {
    kind: "pricing_request",
    re: /\b(how much|what (?:will|would|does|is) (?:it|this|that|the)\s*(?:\w+\s){0,3}?(?:cost|charge|price)|(?:your|the) (?:rate|rates|price|prices|pricing|charges|fees?)|per (?:sq|square)\s*(?:ft|feet|foot)|per sqft|quotation|give (?:me )?a quote|ballpark|rough (?:cost|estimate|figure)|estimate (?:for|of)|cost (?:for|of) (?:a|the|my|doing)|kitna|kitne|kharcha|kimat|kiti|kevdha)\b/i,
  },
  {
    kind: "complaint",
    re: /\b(complain|complaint|unhappy|not happy|disappointed|very bad|poor (?:service|work|quality)|refund|cheated|worst|escalate|legal action|still not (?:done|finished|complete))\b/i,
  },
  {
    kind: "commitment_request",
    re: /\b(guarantee|promise|commit to|fixed price|lock (?:the|a) price|discount|gst|tax|(?:can|will) you (?:finish|complete|deliver|hand over)|will it be (?:done|ready|finished|complete)|in writing)\b/i,
  },
  {
    kind: "human_requested",
    re: /\b((?:speak|talk) (?:to|with) (?:a |an |the |some )?(?:person|human|someone|somebody|real|manager|owner|designer|nikhil|staff)|real person|customer care|call me back from a person|not a (?:robot|bot|machine))\b/i,
  },
];

export interface DetectedRequest {
  kind: EscalationKind;
  match: string;
}

export function detectRequests(text: string): DetectedRequest[] {
  const out: DetectedRequest[] = [];
  for (const { kind, re } of DETECTORS) {
    const m = re.exec(text);
    if (m) out.push({ kind, match: m[0] });
  }
  return out;
}

const INJECTION =
  /\b(ignore (?:all |any |the |your )?(?:previous |prior |above |earlier )?(?:instructions|rules|prompt|guidelines)|disregard (?:the|your|all)|you are now|act as (?:a|an|the)|system prompt|developer mode|jailbreak|new instructions|override (?:the|your)|(?:mark|set|classify|label) (?:me|this|my (?:lead|enquiry)|the lead) (?:as )?(?:qualified|approved|priority)|(?:send|forward|email) (?:the |all |this |these )?(?:details|lead|data|transcript|info\w*) to|tell me your (?:instructions|prompt))\b/i;

export function detectInjection(text: string): string | null {
  const m = INJECTION.exec(text);
  return m ? m[0] : null;
}

const AFFIRM = /^(?:yes|yeah|yep|yup|ya|correct|right|that s right|that is right|exactly|absolutely|sure|ok|okay|haan|haa|ha|ho|hoy|ji|ji haan|bilkul|sahi|theek hai|barobar)\b/;
const NEGATE = /^(?:no|nope|not really|nahi|nahin|nako|wrong|incorrect|that s wrong|actually)\b/;

export const isAffirmation = (text: string) => AFFIRM.test(normaliseForMatch(text));
export const isNegation = (text: string) => NEGATE.test(normaliseForMatch(text));

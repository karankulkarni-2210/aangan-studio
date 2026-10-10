// Formatting for Indian rupees (lakh/crore), IST dates and the backend's enum values.

export const TZ = "Asia/Kolkata";

const inrFull = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intIN = new Intl.NumberFormat("en-IN");

export const NA = "Not available";

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined ? NA : intIN.format(n);
}

/** Operating costs: exact rupees (paise shown under ₹10). Null means unknown, never ₹0. */
export function fmtCost(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return NA;
  const rupees = paise / 100;
  return Math.abs(rupees) < 10 && rupees !== 0 ? inrPaise.format(rupees) : inrFull.format(rupees);
}

/** Project-scale amounts (budgets, contract values) in readable lakh/crore notation. */
export function fmtLakh(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return NA;
  const rupees = paise / 100;
  const trim = (x: number) => (Math.round(x * 100) / 100).toString();
  if (rupees >= 1e7) return `₹${trim(rupees / 1e7)} crore`;
  if (rupees >= 1e5) return `₹${trim(rupees / 1e5)} lakh`;
  return inrFull.format(rupees);
}

export function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return NA;
  return `${Math.round(rate * 1000) / 10}%`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return NA;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 6) / 10} min`;
  return `${Math.round(s / 360) / 10} h`;
}

const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { timeZone: TZ, ...o });
const dDate = dtf({ day: "numeric", month: "short", year: "numeric" });
const dDay = dtf({ weekday: "short", day: "numeric", month: "short" });
const dDayLong = dtf({ weekday: "long", day: "numeric", month: "long" });
const dTime = dtf({ hour: "numeric", minute: "2-digit", hour12: true });
const dKey = dtf({ year: "numeric", month: "2-digit", day: "2-digit" });

export function istDayKey(d: Date | string): string {
  const parts = dKey.formatToParts(new Date(d));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? dDate.format(new Date(iso)) : NA;
}
export function fmtTime(iso: string | null | undefined): string {
  return iso ? dTime.format(new Date(iso)).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`) : NA;
}
export function fmtDay(iso: string | null | undefined): string {
  return iso ? dDay.format(new Date(iso)) : NA;
}
export function fmtDayLong(iso: string | null | undefined): string {
  return iso ? dDayLong.format(new Date(iso)) : NA;
}
/** "Today, 10:20 am", "Yesterday, 9:45 am" or "8 Oct, 4:10 pm" (IST). */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return NA;
  const key = istDayKey(iso);
  const today = istDayKey(new Date());
  const yesterday = istDayKey(new Date(Date.now() - 86400000));
  const day = key === today ? "Today" : key === yesterday ? "Yesterday" : dtf({ day: "numeric", month: "short" }).format(new Date(iso));
  return `${day}, ${fmtTime(iso)}`;
}
export function fmtSlot(start: string | null, end?: string | null): string {
  if (!start) return "No time selected";
  return `${fmtDay(start)}, ${fmtTime(start)}${end ? ` – ${fmtTime(end)}` : ""} IST`;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.replace(/[_.]/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "terra" | "outline" | "neutral";

export const QUAL: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "neutral" },
  qualified: { label: "Qualified", tone: "ok" },
  needs_review: { label: "Needs review", tone: "warn" },
  not_fit: { label: "Not fit", tone: "bad" },
};

export const LEAD_BOOKING: Record<string, { label: string; tone: Tone }> = {
  none: { label: "Not booked", tone: "neutral" },
  confirmed: { label: "Consultation booked", tone: "ok" },
  pending_reconciliation: { label: "Awaiting confirmation", tone: "warn" },
  declined: { label: "Declined", tone: "neutral" },
  failed: { label: "Booking failed", tone: "bad" },
};

export const BOOKING: Record<string, { label: string; tone: Tone }> = {
  requested: { label: "Requested", tone: "info" },
  confirmed: { label: "Confirmed", tone: "ok" },
  conflict: { label: "Slot taken", tone: "warn" },
  pending_reconciliation: { label: "Awaiting confirmation", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  declined: { label: "Declined by caller", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const HANDOFF: Record<string, { label: string; tone: Tone }> = {
  none: { label: "No handoff", tone: "neutral" },
  pending: { label: "Handoff queued", tone: "info" },
  sent: { label: "Awaiting acceptance", tone: "warn" },
  failed: { label: "Handoff failed", tone: "bad" },
  acknowledged: { label: "Accepted", tone: "ok" },
};

export const CRM: Record<string, { label: string; tone: Tone }> = {
  not_required: { label: "Not required", tone: "neutral" },
  pending: { label: "Sync pending", tone: "info" },
  synced: { label: "Synced", tone: "ok" },
  failed: { label: "Sync failed", tone: "bad" },
};

export const DELIVERY: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "info" },
  sending: { label: "Sending", tone: "info" },
  sent: { label: "Delivered", tone: "ok" },
  simulated: { label: "Simulated delivery", tone: "accent" },
  failed: { label: "Failed", tone: "bad" },
};

export const STAGE: Record<string, string> = {
  in_discovery: "In discovery",
  discovery_incomplete: "Details incomplete",
  needs_review: "Needs review",
  not_fit: "Not fit",
  qualified_pending_handoff: "Qualified, handoff pending",
  handed_off: "With designer",
  acknowledged: "Accepted by designer",
  won: "Won",
  lost: "Lost",
};

export const FACT_LABEL: Record<string, string> = {
  service: "Service",
  location: "Location",
  area: "Area",
  budget: "Stated budget",
  timeline: "Timeline",
  contact_name: "Name",
  contact_email: "Email",
  callback_preference: "Callback preference",
};

export const FACT_STATUS: Record<string, { label: string; tone: Tone }> = {
  missing: { label: "Missing", tone: "neutral" },
  declined: { label: "Declined to share", tone: "neutral" },
  unconfirmed: { label: "Unconfirmed", tone: "warn" },
  contradictory: { label: "Conflicting answers", tone: "bad" },
  stated: { label: "Stated", tone: "info" },
  confirmed: { label: "Confirmed", tone: "ok" },
};

export const ESCALATION: Record<string, string> = {
  pricing_request: "Pricing question (for Nikhil)",
  complaint: "Complaint",
  commitment_request: "Asked for a commitment",
  human_requested: "Asked for a person",
  urgent: "Urgent",
  needs_review: "Needs review",
  callback: "Callback",
  booking_pending: "Booking to confirm",
  integration_failure: "Integration failure",
  ack_overdue: "Acceptance overdue",
  injection_review: "Unusual caller instructions",
  agent_price_utterance: "Price wording blocked",
  other: "Other",
};

export const PROVIDER: Record<string, string> = {
  vaani: "Vaani AI (voice)",
  gemini: "Gemini Flash",
  calcom: "Cal.com",
  hubspot: "HubSpot",
  resend: "Resend",
  supabase: "Supabase",
};

export const COST_CATEGORY: Record<string, string> = {
  voice_telephony: "Voice and telephony",
  ai_inference: "AI (Gemini)",
  speech: "Speech",
  notification: "Email",
  calendar: "Calendar",
  crm: "CRM",
  hosting: "Hosting",
  database_storage: "Database",
  source_control: "Source control",
  development_tools: "Development tools",
};

export const ROLE: Record<string, string> = { admin: "Administrator", front_desk: "Front desk", designer: "Designer" };

export function serviceLabel(id: string | null | undefined): string {
  if (!id) return "Project type not captured";
  const known: Record<string, string> = {
    full_home_interiors: "Home interiors",
    small_office_interiors: "Office interiors",
    structural_construction: "Construction (not offered)",
  };
  return known[id] ?? humanize(id);
}

export function placeLabel(city: string | null | undefined, locality: string | null | undefined): string {
  return [locality, city].filter(Boolean).join(", ") || "Location not captured";
}

/** The single most useful next step for a lead, derived from its state fields. */
export function nextAction(l: {
  qualification_status: string;
  discovery_status: string;
  handoff_status: string;
  ack_overdue: boolean;
  booking_status: string;
  outcome_status: string;
  open_escalations: string[];
}): { label: string; tone: Tone } {
  if (l.outcome_status === "won" || l.outcome_status === "lost") return { label: "Closed", tone: "neutral" };
  if (l.handoff_status === "failed") return { label: "Check failed handoff", tone: "bad" };
  if (l.handoff_status === "sent" && l.ack_overdue) return { label: "Acceptance overdue", tone: "bad" };
  if (l.handoff_status === "sent") return { label: "Waiting for acceptance", tone: "warn" };
  if (l.open_escalations.includes("pricing_request")) return { label: "Pricing call-back (Nikhil)", tone: "terra" };
  const callback = l.open_escalations.find((k) => ["complaint", "commitment_request", "human_requested", "urgent", "callback"].includes(k));
  if (callback) return { label: `Call back: ${(ESCALATION[callback] ?? humanize(callback)).toLowerCase()}`, tone: "terra" };
  if (l.open_escalations.length > 0) return { label: ESCALATION[l.open_escalations[0]] ?? humanize(l.open_escalations[0]), tone: "terra" };
  if (l.booking_status === "pending_reconciliation") return { label: "Check booking status", tone: "warn" };
  if (l.qualification_status === "needs_review") return { label: "Review details", tone: "warn" };
  if (l.discovery_status === "incomplete" || l.discovery_status === "in_progress") return { label: "Collect missing details", tone: "warn" };
  if (l.qualification_status === "qualified" && l.booking_status === "none") return { label: "Book consultation", tone: "accent" };
  if (l.booking_status === "confirmed" && l.outcome_status === "unknown") return { label: "Prepare for consultation", tone: "accent" };
  if (l.qualification_status === "not_fit") return { label: "No action needed", tone: "neutral" };
  return { label: "Follow up", tone: "neutral" };
}

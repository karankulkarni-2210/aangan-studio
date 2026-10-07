// Adapter contracts. Every external call returns one of four outcomes so callers can tell a
// definite failure from an AMBIGUOUS one (timeout after the request may have been applied), which
// must be reconciled before any retry of a create operation.

export type ProviderResult<T> =
  | { status: "ok"; data: T }
  | { status: "conflict"; message: string }
  | { status: "ambiguous"; message: string }
  | { status: "failed"; message: string; retriable: boolean };

export type AdapterMode = "live" | "mock" | "not_configured";

export interface Slot {
  start: string; // UTC ISO
  end: string; // UTC ISO
}

export interface BookingRequest {
  start: string;
  durationMinutes: number;
  timeZone: string;
  attendee: { name: string; email: string | null; phone: string | null };
  /** Our booking key, used to reconcile ambiguous creates. */
  bookingKey: string;
  metadata: Record<string, string>;
}

export interface CalendarAdapter {
  mode: AdapterMode;
  getSlots(input: { start: Date; end: Date; durationMinutes: number; timeZone: string }): Promise<ProviderResult<Slot[]>>;
  createBooking(input: BookingRequest): Promise<ProviderResult<{ uid: string }>>;
  /** Looks for a booking previously created with this key (after a timeout). */
  findBooking(input: { bookingKey: string; start: string; attendeeName: string; attendeeEmail: string | null }): Promise<ProviderResult<{ uid: string } | null>>;
}

export interface CrmAdapter {
  mode: AdapterMode;
  upsertContact(input: { name: string | null; phone: string | null; email: string | null; leadId: string }): Promise<ProviderResult<{ id: string; created: boolean }>>;
  upsertDeal(input: { leadId: string; dealName: string; contactId: string; description: string }): Promise<ProviderResult<{ id: string; created: boolean }>>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
  tags: Record<string, string>;
}

export interface EmailAdapter {
  mode: AdapterMode;
  send(msg: EmailMessage): Promise<ProviderResult<{ id: string }>>;
}

export function notConfigured<T>(provider: string): ProviderResult<T> {
  return { status: "failed", message: `${provider} is not configured for live mode`, retriable: false };
}

export function classifyFetchError(err: unknown): ProviderResult<never> {
  const name = (err as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return { status: "ambiguous", message: "request timed out; remote outcome unknown" };
  return { status: "failed", message: `network error: ${name ?? "unknown"}`, retriable: true };
}

import { env } from "@/lib/config/env";
import { classifyFetchError, type CalendarAdapter, type ProviderResult, type Slot } from "./types";

// Cal.com API v2. Verified against cal.com/docs on 2026-10-07. Each endpoint has its own
// cal-api-version; sending the wrong one silently selects an older endpoint version, so they are
// pinned here:
//   GET  /v2/slots     -> 2024-09-04
//   POST /v2/bookings  -> 2026-02-25
//   GET  /v2/bookings  -> 2026-05-01
// Cal.com has no idempotency key for bookings: an ambiguous create is reconciled by listing
// bookings for the event type/time window and matching our metadata.aangan_booking_key.
// The event type must NOT require host confirmation, or bookings stay "pending" (treated as failure).

const TIMEOUT_MS = 10_000;

export function createCalcomAdapter(fetchImpl: typeof fetch = fetch): CalendarAdapter {
  const cfg = env.calcom();
  const auth = { authorization: `Bearer ${cfg.apiKey}` };

  async function call(path: string, version: string, init: RequestInit = {}): Promise<Response> {
    return fetchImpl(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { ...auth, "cal-api-version": version, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  return {
    mode: "live",
    async getSlots({ start, end, timeZone }): Promise<ProviderResult<Slot[]>> {
      const qs = new URLSearchParams({
        eventTypeId: String(cfg.eventTypeId),
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone,
        format: "range",
      });
      let res: Response;
      try {
        res = await call(`/v2/slots?${qs}`, "2024-09-04");
      } catch (err) {
        const r = classifyFetchError(err);
        return r.status === "ambiguous" ? { status: "failed", message: r.message, retriable: true } : r;
      }
      if (!res.ok) return { status: "failed", message: `Cal.com slots HTTP ${res.status}`, retriable: res.status >= 500 || res.status === 429 };
      const body = (await res.json()) as { data?: Record<string, Array<{ start: string; end?: string }>> };
      const slots: Slot[] = [];
      for (const list of Object.values(body.data ?? {})) {
        for (const s of list) {
          const st = new Date(s.start);
          slots.push({ start: st.toISOString(), end: s.end ? new Date(s.end).toISOString() : st.toISOString() });
        }
      }
      return { status: "ok", data: slots.sort((a, b) => a.start.localeCompare(b.start)) };
    },

    async createBooking(input) {
      const body = {
        start: input.start,
        eventTypeId: Number(cfg.eventTypeId),
        attendee: {
          name: input.attendee.name,
          timeZone: input.timeZone,
          ...(input.attendee.email ? { email: input.attendee.email } : {}),
          ...(input.attendee.phone ? { phoneNumber: input.attendee.phone } : {}),
          language: "en",
        },
        metadata: { ...input.metadata, aangan_booking_key: input.bookingKey },
      };
      let res: Response;
      try {
        res = await call(`/v2/bookings`, "2026-02-25", { method: "POST", body: JSON.stringify(body) });
      } catch (err) {
        return classifyFetchError(err);
      }
      const json = (await res.json().catch(() => ({}))) as { status?: string; data?: { uid?: string; status?: string }; error?: { message?: string } };
      if (res.status >= 500) return { status: "ambiguous", message: `Cal.com HTTP ${res.status}; booking may exist` };
      if (!res.ok) {
        const msg = JSON.stringify(json.error ?? json).slice(0, 300);
        // Cal.com reports an unavailable slot as a 400 (e.g. no_available_users_found_error); verify per account.
        if (/no_available_users|not available|already has booking|slot/i.test(msg)) return { status: "conflict", message: msg };
        return { status: "failed", message: `Cal.com HTTP ${res.status}: ${msg}`, retriable: res.status === 429 };
      }
      const data = Array.isArray(json.data) ? json.data[0] : json.data;
      if (!data?.uid) return { status: "ambiguous", message: "Cal.com response missing booking uid" };
      if (data.status && data.status !== "accepted") {
        return { status: "failed", message: `booking created with status ${data.status}; not confirmed`, retriable: false };
      }
      return { status: "ok", data: { uid: data.uid } };
    },

    async findBooking({ bookingKey, start, attendeeName, attendeeEmail }) {
      const s = new Date(start);
      const qs = new URLSearchParams({
        eventTypeId: String(cfg.eventTypeId),
        afterStart: new Date(s.getTime() - 60000).toISOString(),
        beforeEnd: new Date(s.getTime() + 6 * 3600000).toISOString(),
        limit: "100",
      });
      if (attendeeEmail) qs.set("attendeeEmail", attendeeEmail);
      else qs.set("attendeeName", attendeeName);
      let res: Response;
      try {
        res = await call(`/v2/bookings?${qs}`, "2026-05-01");
      } catch (err) {
        const r = classifyFetchError(err);
        return { status: "failed", message: r.status === "failed" ? r.message : "lookup timed out", retriable: true };
      }
      if (!res.ok) return { status: "failed", message: `Cal.com list HTTP ${res.status}`, retriable: true };
      const json = (await res.json()) as { data?: Array<{ uid: string; status?: string; metadata?: Record<string, string> }> };
      const match = (json.data ?? []).find((b) => Boolean(b.uid) && b.metadata?.aangan_booking_key === bookingKey && b.status !== "cancelled");
      return { status: "ok", data: match ? { uid: match.uid } : null };
    },
  };
}

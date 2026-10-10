import type { z } from "zod";
import type * as S from "@/lib/api/schemas";
import type { bookingBodySchema } from "@/lib/services/bookings";
import type { patchLeadSchema } from "@/lib/services/leads";
import type { outcomeBodySchema } from "@/lib/services/outcomes";

// Browser client for the backend API. Types come straight from the backend's zod contract
// (src/lib/api/schemas.ts), so the UI cannot drift from what the server returns.

export type Me = z.infer<typeof S.Me>;
export type LeadList = z.infer<typeof S.LeadList>;
export type LeadSummary = z.infer<typeof S.LeadSummary>;
export type LeadDetail = z.infer<typeof S.LeadDetail>;
export type Dashboard = z.infer<typeof S.Dashboard>;
export type BookingList = z.infer<typeof S.BookingList>;
export type BookingListItem = BookingList["data"][number];
export type BookingSlots = z.infer<typeof S.BookingSlots>;
export type BookingResponse = z.infer<typeof S.BookingResponse>;
export type StaffList = z.infer<typeof S.StaffList>;
export type StaffMember = StaffList["data"][number];
export type Integrations = z.infer<typeof S.Integrations>;
export type PolicyList = z.infer<typeof S.PolicyList>;
export type PolicyDraftResponse = z.infer<typeof S.PolicyDraftResponse>;
export type PolicyPublishResponse = z.infer<typeof S.PolicyPublishResponse>;
export type DemoScenarioList = z.infer<typeof S.DemoScenarioList>;
export type SimulationResult = z.infer<typeof S.SimulationResult>;
export type DemoSession = z.infer<typeof S.DemoSession>;
export type PatchLeadResponse = z.infer<typeof S.PatchLeadResponse>;
export type AcknowledgementResponse = z.infer<typeof S.AcknowledgementResponse>;
export type OutcomeResponse = z.infer<typeof S.OutcomeResponse>;
export type PatchLeadRequest = z.input<typeof patchLeadSchema>;
export type OutcomeRequest = z.input<typeof outcomeBodySchema>;
export type BookingRequest = z.input<typeof bookingBodySchema>;
export type Role = Me["role"];

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
  token?: string | null;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiFailure(0, "network_error", "We couldn't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json ?? {}) as { code?: string; message?: string; details?: unknown; request_id?: string };
    throw new ApiFailure(res.status, e.code ?? `http_${res.status}`, e.message ?? `The server returned an error (${res.status}).`, e.details ?? null, e.request_id ?? null);
  }
  return { status: res.status, data: json as T };
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Plain-language explanation for an API failure, with the next step where one exists. */
export function describeError(err: unknown): { title: string; detail: string } {
  if (!(err instanceof ApiFailure)) return { title: "Something went wrong", detail: "An unexpected error occurred. Try again." };
  const known: Record<string, string> = {
    network_error: err.message,
    forbidden: "Your role does not have access to this. Ask an administrator if you need it.",
    sandbox_read_only: "Studio settings are read-only on this deployment.",
    settings_passcode_required: "Enter the studio's edit passcode to save rule changes.",
    settings_passcode_invalid: "That edit passcode is not correct.",
    not_found: "This record does not exist, or it is not visible to you.",
    rate_limited: "Too many requests in a short time. Wait a minute and try again.",
    database_not_configured: "The database is not configured on this deployment.",
    configuration_incomplete: "Live configuration is incomplete, so the server is refusing requests (fail closed).",
    calendar_unavailable: "Cal.com availability could not be loaded. Try again shortly, or arrange the consultation by phone.",
    version_conflict: "Someone else changed this lead. Reload it and try again.",
  };
  const detail = known[err.code] ?? err.message;
  return { title: err.status === 0 ? "Connection problem" : err.status >= 500 ? "The server could not complete this" : "This could not be completed", detail };
}

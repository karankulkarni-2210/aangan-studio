import { integrationMode } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { createCalcomAdapter } from "./calcom";
import { createHubspotAdapter } from "./hubspot";
import { createMockCalendar, createMockCrm, createMockEmail } from "./mock";
import { createResendAdapter } from "./resend";
import { notConfigured, type CalendarAdapter, type CrmAdapter, type EmailAdapter } from "./types";

// Adapter selection:
//  * Simulated leads ALWAYS use mock adapters, even when live credentials exist, so a demo can
//    never create a real booking, CRM record or email.
//  * Real leads use live adapters when credentials exist; in demo mode, mocks otherwise; in live
//    mode, a not-configured adapter that fails visibly.

export interface Providers {
  calendar: CalendarAdapter;
  crm: CrmAdapter;
  email: EmailAdapter;
}

let overrides: Partial<Providers> | null = null;
export function setProviderOverrides(p: Partial<Providers> | null): void {
  overrides = p;
}

const notConfiguredCalendar: CalendarAdapter = {
  mode: "not_configured",
  getSlots: async () => notConfigured("Cal.com"),
  createBooking: async () => notConfigured("Cal.com"),
  findBooking: async () => notConfigured("Cal.com"),
};
const notConfiguredCrm: CrmAdapter = {
  mode: "not_configured",
  upsertContact: async () => notConfigured("HubSpot"),
  upsertDeal: async () => notConfigured("HubSpot"),
};
const notConfiguredEmail: EmailAdapter = { mode: "not_configured", send: async () => notConfigured("Resend") };

export function getProviders(db: Db, opts: { simulated: boolean }): Providers {
  const pick = <T>(provider: "calcom" | "hubspot" | "resend", live: () => T, mock: () => T, none: T): T => {
    if (opts.simulated) return mock();
    const mode = integrationMode(provider);
    return mode === "live" ? live() : mode === "mock" ? mock() : none;
  };
  return {
    calendar: overrides?.calendar ?? pick("calcom", () => createCalcomAdapter(), () => createMockCalendar(db), notConfiguredCalendar),
    crm: overrides?.crm ?? pick("hubspot", () => createHubspotAdapter(), () => createMockCrm(db), notConfiguredCrm),
    email: overrides?.email ?? pick("resend", () => createResendAdapter(), () => createMockEmail(db), notConfiguredEmail),
  };
}

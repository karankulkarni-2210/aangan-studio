import { env } from "@/lib/config/env";
import { classifyFetchError, type CrmAdapter, type ProviderResult } from "./types";

// HubSpot CRM (legacy v3 object paths, still supported alongside the 2026-09 date-versioned paths).
// Verified against developers.hubspot.com on 2026-10-07.
//  * Contacts: search by email, then phone; create if none. Search is eventually consistent, so a
//    timed-out create is retried with search-first and may, rarely, produce a duplicate contact.
//  * Deals: idempotent via batch upsert on a UNIQUE custom deal property (default aangan_lead_id,
//    created once with hasUniqueValue=true). One open deal per lead; retries cannot duplicate it.
//  * Deal->contact association: PUT v4 default association (idempotent).
// Setup prerequisite: create the deal property, and supply pipeline + stage internal IDs.

const TIMEOUT_MS = 10_000;

export function createHubspotAdapter(fetchImpl: typeof fetch = fetch): CrmAdapter {
  const cfg = env.hubspot();
  const headers = { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" };

  async function call<T>(method: string, path: string, body?: unknown): Promise<ProviderResult<T> & { httpStatus?: number; raw?: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return classifyFetchError(err);
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return { status: "ok", data: json as T, httpStatus: res.status };
    if (res.status === 409) return { status: "conflict", message: JSON.stringify(json).slice(0, 300), httpStatus: 409, raw: json };
    if (res.status >= 500) return { status: method === "GET" ? "failed" : "ambiguous", message: `HubSpot HTTP ${res.status}`, retriable: true } as ProviderResult<T>;
    return { status: "failed", message: `HubSpot HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`, retriable: res.status === 429 };
  }

  async function searchContact(property: string, value: string): Promise<ProviderResult<string | null>> {
    const r = await call<{ results?: Array<{ id: string }> }>("POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
      limit: 1,
    });
    if (r.status !== "ok") return r.status === "ambiguous" ? { status: "failed", message: r.message, retriable: true } : r;
    return { status: "ok", data: r.data.results?.[0]?.id ?? null };
  }

  return {
    mode: "live",
    async upsertContact({ name, phone, email }) {
      for (const [prop, value] of [["email", email], ["phone", phone]] as const) {
        if (!value) continue;
        const found = await searchContact(prop, value);
        if (found.status !== "ok") return found;
        if (found.data) return { status: "ok", data: { id: found.data, created: false } };
      }
      const [firstname, ...rest] = (name ?? "").trim().split(/\s+/);
      const created = await call<{ id: string }>("POST", "/crm/v3/objects/contacts", {
        properties: { ...(firstname ? { firstname } : {}), ...(rest.length ? { lastname: rest.join(" ") } : {}), ...(phone ? { phone } : {}), ...(email ? { email } : {}) },
      });
      if (created.status === "conflict") {
        const existing = /Existing ID:\s*(\d+)/i.exec(created.message);
        if (existing) return { status: "ok", data: { id: existing[1], created: false } };
        return { status: "failed", message: created.message, retriable: false };
      }
      if (created.status !== "ok") return created;
      return { status: "ok", data: { id: created.data.id, created: true } };
    },

    async upsertDeal({ leadId, dealName, contactId, description }) {
      const upsert = await call<{ results?: Array<{ id: string; new?: boolean }> }>("POST", "/crm/v3/objects/deals/batch/upsert", {
        inputs: [
          {
            id: leadId,
            idProperty: cfg.leadIdProperty,
            properties: {
              [cfg.leadIdProperty]: leadId,
              dealname: dealName,
              pipeline: cfg.pipelineId,
              dealstage: cfg.dealStageId,
              description,
            },
          },
        ],
      });
      if (upsert.status !== "ok") return upsert.status === "conflict" ? { status: "failed", message: upsert.message, retriable: false } : upsert;
      const deal = upsert.data.results?.[0];
      if (!deal?.id) return { status: "ambiguous", message: "HubSpot upsert returned no deal id" };
      const assoc = await call("PUT", `/crm/v4/objects/deals/${encodeURIComponent(deal.id)}/associations/default/contacts/${encodeURIComponent(contactId)}`);
      if (assoc.status !== "ok") return { status: "failed", message: `deal saved but association failed: ${"message" in assoc ? assoc.message : ""}`, retriable: true };
      return { status: "ok", data: { id: deal.id, created: deal.new ?? false } };
    },
  };
}

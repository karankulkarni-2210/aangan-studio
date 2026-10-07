import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { runDispatcher } from "@/lib/jobs/handlers";
import { enqueue } from "@/lib/jobs/outbox";
import { createMockCrm } from "@/lib/providers/mock";
import { setProviderOverrides } from "@/lib/providers/registry";
import { setClock } from "@/lib/runtime";
import { createTestDb } from "../helpers/db";
import { leadRow, simulate } from "../helpers/scenario";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const remoteCount = async (kind: string) =>
  (await db.query(`select count(*)::int as n from public.mock_remote_objects where provider = 'hubspot' and object_kind = $1`, [kind])).rows[0].n;

describe("HubSpot sync", () => {
  it("creates one contact and one open deal per qualified project and stores remote ids", async () => {
    const r = await simulate(db, "suitable_home");
    const { rows } = await db.query(`select object_kind, status, remote_id, mode from public.integration_syncs where lead_id = $1 order by object_kind`, [r.lead_id]);
    expect(rows).toEqual([
      { object_kind: "contact", status: "succeeded", remote_id: expect.stringMatching(/^sim_hs_contact_/), mode: "mock" },
      { object_kind: "deal", status: "succeeded", remote_id: expect.stringMatching(/^sim_hs_deal_/), mode: "mock" },
    ]);
    expect(await remoteCount("deal")).toBe(1);
  });

  it("re-running the sync never duplicates the contact or deal", async () => {
    const r = await simulate(db, "suitable_home");
    await db.query(`update public.integration_syncs set status = 'pending', remote_id = null where lead_id = $1`, [r.lead_id]);
    await enqueue(db, "crm.sync", { lead_id: r.lead_id }, "crm-resync");
    await runDispatcher(db, { trigger: "test" });
    expect(await remoteCount("contact")).toBe(1);
    expect(await remoteCount("deal")).toBe(1);
  });

  it("an ambiguous timeout after the deal was created reconciles to the same deal", async () => {
    setProviderOverrides({ crm: createMockCrm(db, { upsertDeal: ["timeout_after_commit"] }) });
    const r = await simulate(db, "declined_booking");
    const { rows: s1 } = await db.query(`select status from public.integration_syncs where lead_id = $1 and object_kind = 'deal'`, [r.lead_id]);
    expect(s1[0].status).toBe("ambiguous");
    setClock(() => new Date(Date.now() + 3600_000));
    await runDispatcher(db, { trigger: "test" });
    expect(await remoteCount("deal")).toBe(1);
    expect((await leadRow(db, r.lead_id!)).crm_status).toBe("synced");
  });

  it("repeat callers with the same number reuse the CRM contact but get separate deals", async () => {
    await simulate(db, "suitable_home");
    const second = await simulate(db, "suitable_home");
    expect(await remoteCount("contact")).toBe(1);
    expect(await remoteCount("deal")).toBe(2);
    const { rows } = await db.query(`select count(*)::int as n from public.leads where caller_phone = '+919000000101'`);
    expect(rows[0].n).toBe(2); // never merged on phone number alone
    void second;
  });

  it("only qualified leads are synced (demo policy)", async () => {
    const r = await simulate(db, "missing_budget");
    expect((await leadRow(db, r.lead_id!)).crm_status).toBe("not_required");
    expect(await remoteCount("deal")).toBe(0);
  });
});

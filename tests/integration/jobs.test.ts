import { beforeEach, describe, expect, it } from "vitest";
import * as dispatchRoute from "@/app/internal/jobs/dispatch/route";
import type { Db } from "@/lib/db/types";
import { claimJobs, dispatch, enqueue, PermanentJobError, type JobHandler, type JobKind } from "@/lib/jobs/outbox";
import { setClock } from "@/lib/runtime";
import { createTestDb } from "../helpers/db";
import { call } from "../helpers/http";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const handlersWith = (fn: JobHandler) => ({ "call.finalize": fn }) as unknown as Record<JobKind, JobHandler>;

describe("durable outbox and bounded dispatcher", () => {
  it("an interrupted dispatcher's job is reclaimed after the lease expires and processed once", async () => {
    await enqueue(db, "call.finalize", { call_id: "x" }, "job-1");
    const crashed = await claimJobs(db, "worker-that-dies", 5, 120);
    expect(crashed).toHaveLength(1);

    let runs = 0;
    const handlers = handlersWith(async () => {
      runs++;
    });
    const before = await dispatch(db, handlers, { limit: 10, timeBudgetMs: 5000, trigger: "test" });
    expect(before.claimed).toBe(0); // lease still held

    const t0 = Date.now();
    setClock(() => new Date(t0 + 121_000));
    const after = await dispatch(db, handlers, { limit: 10, timeBudgetMs: 5000, trigger: "test" });
    expect(after).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(runs).toBe(1);
    const again = await dispatch(db, handlers, { limit: 10, timeBudgetMs: 5000, trigger: "test" });
    expect(again.claimed).toBe(0);
    const { rows } = await db.query(`select status, attempts from public.outbox_jobs where dedupe_key = 'job-1'`);
    expect(rows[0]).toEqual({ status: "succeeded", attempts: 2 });
  });

  it("a job whose lease expires on its final attempt goes dead instead of looping", async () => {
    await db.query(`insert into public.outbox_jobs (kind, payload, dedupe_key, max_attempts) values ('call.finalize', '{}', 'job-lease', 1)`);
    await claimJobs(db, "killed-worker", 1, 60);
    let runs = 0;
    setClock(() => new Date(Date.now() + 61_000));
    await dispatch(db, handlersWith(async () => { runs++; }), { limit: 5, timeBudgetMs: 5000, trigger: "test" });
    expect(runs).toBe(0);
    const { rows } = await db.query(`select status, attempts, last_error from public.outbox_jobs where dedupe_key = 'job-lease'`);
    expect(rows[0]).toMatchObject({ status: "dead", attempts: 1, last_error: expect.stringContaining("lease expired") });
  });

  it("retries with backoff, then marks the job dead and visible", async () => {
    await db.query(`insert into public.outbox_jobs (kind, payload, dedupe_key, max_attempts) values ('call.finalize', '{}', 'job-2', 3)`);
    const handlers = handlersWith(async () => {
      throw new Error("provider down");
    });
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      setClock(() => new Date(t0 + i * 3600_000));
      await dispatch(db, handlers, { limit: 5, timeBudgetMs: 5000, trigger: "test" });
    }
    const { rows } = await db.query(`select status, attempts, last_error from public.outbox_jobs where dedupe_key = 'job-2'`);
    expect(rows[0]).toEqual({ status: "dead", attempts: 3, last_error: "provider down" });
  });

  it("permanent errors are not retried", async () => {
    await enqueue(db, "call.finalize", {}, "job-3");
    await dispatch(db, handlersWith(async () => { throw new PermanentJobError("bad data"); }), { limit: 5, timeBudgetMs: 5000, trigger: "test" });
    const { rows } = await db.query(`select status, attempts from public.outbox_jobs where dedupe_key = 'job-3'`);
    expect(rows[0]).toEqual({ status: "dead", attempts: 1 });
  });

  it("enqueue is idempotent on the dedupe key", async () => {
    expect(await enqueue(db, "crm.sync", { lead_id: "a" }, "same")).toBeTruthy();
    expect(await enqueue(db, "crm.sync", { lead_id: "a" }, "same")).toBeNull();
  });

  it("stops at the job limit and reports remaining work", async () => {
    for (let i = 0; i < 7; i++) await enqueue(db, "call.finalize", {}, `bulk-${i}`);
    const r = await dispatch(db, handlersWith(async () => undefined), { limit: 3, timeBudgetMs: 5000, trigger: "test" });
    expect(r).toMatchObject({ claimed: 3, stopped_reason: "limit", remaining_ready: 4 });
  });

  it("daily maintenance purges transcripts past retention and closes stale calls", async () => {
    const { simulate } = await import("../helpers/scenario");
    const { startCall } = await import("../helpers/voice");
    const old = await simulate(db, "price_only");
    await db.query(`update public.calls set ended_at = now() - interval '100 days' where lead_id = $1`, [old.lead_id]);
    const stale = await startCall();
    await stale.say("We need full home interiors in Baner.");
    await db.query(`update public.calls set last_event_at = now() - interval '3 hours' where id = $1`, [stale.callId]);
    await db.query(`delete from public.outbox_jobs where kind = 'maintenance.daily'`);
    const { runDispatcher } = await import("@/lib/jobs/handlers");
    await runDispatcher(db, { trigger: "test" });
    await runDispatcher(db, { trigger: "test" });
    const { rows: purged } = await db.query(`select distinct u.text from public.utterances u join public.calls c on c.id = u.call_id where c.lead_id = $1`, [old.lead_id]);
    expect(purged).toEqual([{ text: "[purged under retention policy]" }]);
    const { rows: evidence } = await db.query(`select count(*)::int as n, count(quote)::int as quotes from public.field_evidence where lead_id = $1`, [old.lead_id]);
    expect(evidence[0]).toEqual({ n: expect.any(Number), quotes: 0 }); // structured facts kept; verbatim quotes purged
    expect(evidence[0].n).toBeGreaterThan(0);
    const { rows: summaries } = await db.query(`select summary from public.human_tasks where lead_id = $1 and kind = 'pricing_request'`, [old.lead_id]);
    expect(summaries[0].summary).toContain("Caller said: [purged under retention policy]");
    const { rows: closed } = await db.query(`select status, end_reason, finalized_at is not null as finalized from public.calls where id = $1`, [stale.callId]);
    expect(closed[0]).toEqual({ status: "failed", end_reason: "no_end_event", finalized: true });
    const { rows: tasks } = await db.query(`select kind from public.human_tasks where call_id = $1`, [stale.callId]);
    expect(tasks.map((t) => t.kind)).toContain("callback");
  });

  it("the dispatch endpoint is never public", async () => {
    expect((await call(dispatchRoute.POST, "POST", "/internal/jobs/dispatch")).status).toBe(401);
    expect((await call(dispatchRoute.POST, "POST", "/internal/jobs/dispatch", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await call(dispatchRoute.GET, "GET", "/internal/jobs/dispatch?limit=5", { headers: { authorization: `Bearer ${process.env.DISPATCH_SECRET}`, "user-agent": "vercel-cron/1.0" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ run_id: expect.any(String) });
    const { rows } = await db.query(`select trigger from public.dispatcher_runs`);
    expect(rows[0].trigger).toBe("vercel_cron");
  });
});

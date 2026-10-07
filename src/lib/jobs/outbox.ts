import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/lib/db/types";
import { log } from "@/lib/log";
import { now } from "@/lib/runtime";

// Durable outbox in Supabase Postgres. Jobs are claimed atomically with FOR UPDATE SKIP LOCKED
// and a lease; a dispatcher that dies mid-job leaves an expired lease that the next run reclaims.
// Delivery to external providers is therefore at-least-once: handlers must be idempotent
// (local dedupe + provider idempotency keys + reconcile-before-create).

export type JobKind =
  | "call.finalize"
  | "handoff.send"
  | "handoff.ack_check"
  | "crm.sync"
  | "booking.reconcile"
  | "maintenance.daily";

export interface Job {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  dedupe_key: string;
  attempts: number;
  max_attempts: number;
}

export class RetryableJobError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
/** A failure that will not improve with retries (bad data, permanent provider rejection). */
export class PermanentJobError extends Error {}

export async function enqueue(
  q: Queryable,
  kind: JobKind,
  payload: Record<string, unknown>,
  dedupeKey: string,
  opts: { runAfter?: Date; maxAttempts?: number } = {},
): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into public.outbox_jobs (kind, payload, dedupe_key, run_after, max_attempts)
     values ($1, $2, $3, $4, $5) on conflict (dedupe_key) do nothing returning id`,
    [kind, JSON.stringify(payload), dedupeKey, opts.runAfter ?? now(), opts.maxAttempts ?? 5],
  );
  return rows[0]?.id ?? null;
}

export async function claimJobs(db: Db, workerId: string, limit: number, leaseSeconds: number): Promise<Job[]> {
  const t = now();
  const { rows } = await db.query<Job>(
    `update public.outbox_jobs j
        set status = 'running', locked_by = $1, lease_expires_at = $4::timestamptz + make_interval(secs => $3),
            attempts = j.attempts + 1
      where j.id in (
        select id from public.outbox_jobs
         where (status = 'queued' and run_after <= $4) or (status = 'running' and lease_expires_at < $4)
         order by run_after
         limit $2
         for update skip locked)
      returning j.id, j.kind, j.payload, j.dedupe_key, j.attempts, j.max_attempts`,
    [workerId, limit, leaseSeconds, t],
  );
  return rows;
}

function backoffSeconds(attempt: number): number {
  return Math.min(3600, 15 * 2 ** (attempt - 1));
}

export type JobHandler = (db: Db, job: Job) => Promise<void>;

export interface DispatchResult {
  run_id: string;
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
  remaining_ready: number;
  stopped_reason: "drained" | "limit" | "time_budget";
}

/**
 * Bounded dispatcher: processes at most `limit` jobs or until `timeBudgetMs` elapses, then returns.
 * Never loops forever inside a request.
 */
export async function dispatch(
  db: Db,
  handlers: Record<JobKind, JobHandler>,
  opts: { limit: number; timeBudgetMs: number; trigger: string; leaseSeconds?: number },
): Promise<DispatchResult> {
  const workerId = `dispatcher:${randomUUID()}`;
  const started = Date.now();
  const { rows: run } = await db.query<{ id: string }>(
    `insert into public.dispatcher_runs (trigger, started_at) values ($1, $2) returning id`,
    [opts.trigger, now()],
  );
  const result: DispatchResult = { run_id: run[0].id, claimed: 0, succeeded: 0, retried: 0, dead: 0, remaining_ready: 0, stopped_reason: "drained" };

  while (result.claimed < opts.limit) {
    if (Date.now() - started > opts.timeBudgetMs) {
      result.stopped_reason = "time_budget";
      break;
    }
    const batch = await claimJobs(db, workerId, Math.min(5, opts.limit - result.claimed), opts.leaseSeconds ?? 120);
    if (batch.length === 0) break;
    for (const job of batch) {
      result.claimed++;
      const handler = handlers[job.kind];
      try {
        if (!handler) throw new PermanentJobError(`no handler for ${job.kind}`);
        await handler(db, job);
        await db.query(
          `update public.outbox_jobs set status = 'succeeded', completed_at = $2, locked_by = null, lease_expires_at = null, last_error = null
           where id = $1 and locked_by = $3`,
          [job.id, now(), workerId],
        );
        result.succeeded++;
      } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? "error";
        const permanent = err instanceof PermanentJobError || job.attempts >= job.max_attempts;
        if (permanent) {
          await db.query(
            `update public.outbox_jobs set status = 'dead', completed_at = $2, locked_by = null, lease_expires_at = null, last_error = $3
             where id = $1 and locked_by = $4`,
            [job.id, now(), message, workerId],
          );
          result.dead++;
          log.error("job_dead", { job_id: job.id, kind: job.kind, attempts: job.attempts, error: message });
        } else {
          const delay = err instanceof RetryableJobError && err.retryAfterSeconds ? err.retryAfterSeconds : backoffSeconds(job.attempts);
          await db.query(
            `update public.outbox_jobs set status = 'queued', run_after = $2::timestamptz + make_interval(secs => $3),
               locked_by = null, lease_expires_at = null, last_error = $4
             where id = $1 and locked_by = $5`,
            [job.id, now(), delay, message, workerId],
          );
          result.retried++;
          log.warn("job_retry", { job_id: job.id, kind: job.kind, attempts: job.attempts, delay_s: delay, error: message });
        }
      }
    }
  }
  if (result.claimed >= opts.limit) result.stopped_reason = "limit";

  const { rows: rem } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.outbox_jobs where status = 'queued' and run_after <= $1`,
    [now()],
  );
  result.remaining_ready = rem[0].n;
  await db.query(
    `update public.dispatcher_runs set finished_at = $2, claimed = $3, succeeded = $4, retried = $5, dead = $6 where id = $1`,
    [result.run_id, now(), result.claimed, result.succeeded, result.retried, result.dead],
  );
  return result;
}

import type { Db } from "@/lib/db/types";
import { enqueue, type Job } from "@/lib/jobs/outbox";
import { now } from "@/lib/runtime";
import { getActivePolicy } from "./policies";

// Daily housekeeping, scheduled by the dispatcher itself (one job per IST date):
//  * retention: purge transcript text, evidence quotes and provider payloads older than the
//    policy's windows (structured facts, decisions and audit history are kept);
//  * stale calls: calls with no end event for 2 hours are closed as failed so finalisation saves
//    the partial lead and opens a callback task;
//  * rate-limit buckets older than a day are removed.

export async function ensureDailyMaintenance(db: Db): Promise<void> {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now());
  await enqueue(db, "maintenance.daily", { day }, `maintenance.daily:${day}`, { maxAttempts: 3 });
}

export async function dailyMaintenanceJob(db: Db, _job: Job): Promise<void> {
  const t = now();
  const policy = await db.tx((tx) => getActivePolicy(tx));
  const retention = policy?.config.retention;
  if (retention) {
    await db.query(
      `update public.utterances u set text = '[purged under retention policy]'
         from public.calls c
        where c.id = u.call_id and c.ended_at < $1::timestamptz - make_interval(days => $2) and u.text <> '[purged under retention policy]'`,
      [t, retention.transcript_days],
    );
    // Evidence quotes are verbatim transcript excerpts: purge them too, keep the structured value.
    await db.query(
      `update public.field_evidence e set quote = null
         from public.calls c
        where c.id = e.call_id and c.ended_at < $1::timestamptz - make_interval(days => $2) and e.quote is not null and e.source <> 'human_edit'`,
      [t, retention.transcript_days],
    );
    await db.query(
      `update public.human_tasks t set summary = regexp_replace(t.summary, 'Caller said: “[^”]*”', 'Caller said: [purged under retention policy]')
         from public.calls c
        where c.id = t.call_id and c.ended_at < $1::timestamptz - make_interval(days => $2) and t.summary like '%Caller said: “%'`,
      [t, retention.transcript_days],
    );
    await db.query(
      `update public.calls set transcript_purged_at = $1, recording_ref = null
        where ended_at < $1::timestamptz - make_interval(days => $2) and transcript_purged_at is null`,
      [t, retention.transcript_days],
    );
    await db.query(
      `update public.provider_events set payload_redacted = '{}'::jsonb
        where received_at < $1::timestamptz - make_interval(days => $2) and payload_redacted <> '{}'::jsonb`,
      [t, retention.provider_payload_days],
    );
  }
  const { rows: stale } = await db.query<{ id: string }>(
    `update public.calls set status = 'failed', status_rank = 3, end_reason = coalesce(end_reason, 'no_end_event'), ended_at = coalesce(ended_at, last_event_at)
      where status in ('ringing', 'in_progress') and coalesce(last_event_at, created_at) < $1::timestamptz - interval '2 hours'
      returning id`,
    [t],
  );
  for (const c of stale) await enqueue(db, "call.finalize", { call_id: c.id }, `call.finalize:${c.id}`);
  await db.query(`delete from public.rate_limit_buckets where window_start < $1::timestamptz - interval '1 day'`, [t]);
}

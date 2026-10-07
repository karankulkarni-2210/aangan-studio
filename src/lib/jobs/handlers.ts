import type { Db } from "@/lib/db/types";
import { reconcileBookingJob } from "@/lib/services/bookings";
import { crmSyncJob } from "@/lib/services/crm";
import { finalizeCallJob } from "@/lib/services/finalize";
import { ackCheckJob, sendHandoffJob } from "@/lib/services/handoffs";
import { dailyMaintenanceJob, ensureDailyMaintenance } from "@/lib/services/maintenance";
import { dispatch, type DispatchResult, type JobHandler, type JobKind } from "./outbox";

export const JOB_HANDLERS: Record<JobKind, JobHandler> = {
  "call.finalize": finalizeCallJob,
  "handoff.send": sendHandoffJob,
  "handoff.ack_check": ackCheckJob,
  "crm.sync": crmSyncJob,
  "booking.reconcile": reconcileBookingJob,
  "maintenance.daily": dailyMaintenanceJob,
};

export async function runDispatcher(db: Db, opts: { limit?: number; timeBudgetMs?: number; trigger: string }): Promise<DispatchResult> {
  await ensureDailyMaintenance(db);
  return dispatch(db, JOB_HANDLERS, { limit: opts.limit ?? 25, timeBudgetMs: opts.timeBudgetMs ?? 15_000, trigger: opts.trigger });
}

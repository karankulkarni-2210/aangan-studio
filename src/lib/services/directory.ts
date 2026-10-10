import { z } from "zod";
import type { Db } from "@/lib/db/types";
import { BOOKING_STATUSES } from "@/lib/domain/enums";
import type { StaffActor } from "@/lib/http/route";

// Read-only directory views for the studio workspace: the staff roster and the consultations list.
// Both run under the caller's row-level security; sandbox sessions only see demo staff and
// simulated leads.

export async function listStaff(db: Db, staff: StaffActor) {
  return db.tx((tx) =>
    tx.asStaff(staff.auth_user_id, async (q) => {
      const { rows } = await q.query(
        `select id, display_name, role, email, active, approved_for_handoff, services, is_demo
           from public.staff ${staff.sandbox ? "where is_demo" : ""}
          order by active desc, role, display_name`,
      );
      return { data: rows.map((r) => ({ ...r, services: r.services ?? [] })) };
    }),
  );
}

export const bookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  from: z.string().datetime({ offset: true }).optional().describe("Slot start on or after (bookings without a slot are always included)"),
  to: z.string().datetime({ offset: true }).optional(),
  simulated: z.enum(["true", "false", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function listBookings(db: Db, staff: StaffActor, query: z.infer<typeof bookingsQuerySchema>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const simulated = staff.sandbox ? "true" : query.simulated;
  if (simulated !== "all") where.push(`l.is_simulated = ${p(simulated === "true")}`);
  if (query.status) where.push(`b.status = ${p(query.status)}`);
  if (query.from) where.push(`(b.slot_start is null or b.slot_start >= ${p(new Date(query.from))})`);
  if (query.to) where.push(`(b.slot_start is null or b.slot_start < ${p(new Date(query.to))})`);
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  return db.tx((tx) =>
    tx.asStaff(staff.auth_user_id, async (q) => {
      const { rows } = await q.query(
        `select b.id, b.lead_id, l.reference as lead_reference, l.contact_name, l.service_type, l.location_city, l.location_locality,
                b.status, b.mode, l.is_simulated as simulated, b.slot_start, b.slot_end, b.timezone, b.provider_booking_uid,
                b.last_error, b.decline_reason, b.requested_by, b.created_at, l.owner_staff_id, s.display_name as owner_name
           from public.bookings b join public.leads l on l.id = b.lead_id left join public.staff s on s.id = l.owner_staff_id
           ${whereSql}
          order by coalesce(b.slot_start, b.created_at) desc
          limit ${p(query.limit)}`,
        params,
      );
      const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
      return {
        timezone: "Asia/Kolkata" as const,
        data: rows.map((r) => ({
          id: r.id,
          lead_id: r.lead_id,
          lead_reference: r.lead_reference,
          contact_name: r.contact_name,
          service_type: r.service_type,
          location_city: r.location_city,
          location_locality: r.location_locality,
          status: r.status,
          mode: r.mode,
          simulated: r.simulated,
          slot_start: iso(r.slot_start),
          slot_end: iso(r.slot_end),
          timezone: r.timezone,
          provider_booking_uid: r.provider_booking_uid,
          confirmed: r.status === "confirmed" && Boolean(r.provider_booking_uid),
          last_error: r.last_error,
          decline_reason: r.decline_reason,
          requested_by: r.requested_by,
          created_at: iso(r.created_at),
          owner: r.owner_staff_id ? { id: r.owner_staff_id, display_name: r.owner_name } : null,
        })),
      };
    }),
  );
}

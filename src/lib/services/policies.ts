import type { Queryable, Tx } from "@/lib/db/types";
import { badRequest, conflict, notFound } from "@/lib/http/errors";
import type { StaffActor } from "@/lib/http/route";
import { log } from "@/lib/log";
import { validatePolicyConfig, type PolicyConfig } from "@/lib/policy/schema";
import { audit } from "./audit";

export interface PolicyRecord {
  id: string;
  version: number;
  status: "draft" | "active" | "retired";
  label: string;
  is_demo: boolean;
  config: PolicyConfig;
}

function toRecord(row: Record<string, unknown>): PolicyRecord | null {
  const v = validatePolicyConfig(row.config);
  if (!v.ok) {
    log.error("stored_policy_invalid", { policy_id: row.id, issues: v.issues.length });
    return null;
  }
  return { id: row.id as string, version: row.version as number, status: row.status as PolicyRecord["status"], label: row.label as string, is_demo: row.is_demo as boolean, config: v.config };
}

export async function getActivePolicy(q: Queryable): Promise<PolicyRecord | null> {
  const { rows } = await q.query(`select * from public.business_policies where status = 'active' limit 1`);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getPolicyById(q: Queryable, id: string | null): Promise<PolicyRecord | null> {
  if (!id) return null;
  const { rows } = await q.query(`select * from public.business_policies where id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listPolicies(q: Queryable) {
  const { rows } = await q.query(
    `select id, version, status, label, is_demo, config, validation, created_at, created_by, published_at, published_by, retired_at
     from public.business_policies order by version desc`,
  );
  return rows;
}

export async function createDraft(tx: Tx, staff: StaffActor, config: unknown, requestId: string) {
  const validation = validatePolicyConfig(config);
  const { rows: max } = await tx.query<{ v: number }>(`select coalesce(max(version), 0) as v from public.business_policies`);
  const version = Number(max[0].v) + 1;
  const cfg = config as Partial<PolicyConfig>;
  const label = typeof cfg?.label === "string" ? cfg.label.slice(0, 120) : `Policy v${version}`;
  const { rows } = await tx.query(
    `insert into public.business_policies (version, status, label, is_demo, config, validation, created_by)
     values ($1, 'draft', $2, $3, $4, $5, $6) returning id, version, status, label, is_demo, validation, created_at`,
    [version, label, cfg?.demo !== false, JSON.stringify(config ?? {}), JSON.stringify({ ok: validation.ok, issues: validation.issues }), staff.id],
  );
  await audit(tx, { actor_kind: "staff", actor_staff_id: staff.id, action: "policy.draft_created", entity_type: "business_policy", entity_id: rows[0].id, after: { version, valid: validation.ok }, request_id: requestId });
  return { policy: rows[0], validation: { ok: validation.ok, issues: validation.issues } };
}

export async function publishPolicy(tx: Tx, staff: StaffActor, id: string, requestId: string) {
  const { rows } = await tx.query(`select * from public.business_policies where id = $1 for update`, [id]);
  const row = rows[0];
  if (!row) throw notFound("Policy");
  if (row.status !== "draft") throw conflict("policy_not_draft", `Policy v${row.version} is ${row.status}; only drafts can be published`);
  const validation = validatePolicyConfig(row.config);
  if (!validation.ok) throw badRequest("policy_invalid", "Policy failed validation and cannot be published", validation.issues);

  const { rows: prev } = await tx.query(
    `update public.business_policies set status = 'retired', retired_at = now() where status = 'active' returning id, version`,
  );
  const { rows: published } = await tx.query(
    `update public.business_policies set status = 'active', published_at = now(), published_by = $2,
       validation = $3 where id = $1 returning id, version, status, label, is_demo, published_at`,
    [id, staff.id, JSON.stringify({ ok: true, issues: [] })],
  );
  await audit(tx, {
    actor_kind: "staff",
    actor_staff_id: staff.id,
    action: "policy.published",
    entity_type: "business_policy",
    entity_id: id,
    before: prev[0] ? { active_policy_id: prev[0].id, active_version: prev[0].version } : null,
    after: { active_policy_id: id, active_version: published[0].version },
    request_id: requestId,
  });
  return published[0];
}

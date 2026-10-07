import { z } from "zod";
import { integrationMode } from "@/lib/config/env";
import { jsonResponse, route } from "@/lib/http/route";
import { createDraft, getActivePolicy, listPolicies } from "@/lib/services/policies";

export const GET = route({ auth: "staff", roles: ["admin", "front_desk"], rateLimitPerMinute: 60 }, async ({ db }) => {
  const [policies, active] = await Promise.all([listPolicies(db), db.tx((tx) => getActivePolicy(tx))]);
  return {
    data: policies.map((p) => ({ ...p, created_at: new Date(p.created_at).toISOString(), published_at: p.published_at ? new Date(p.published_at).toISOString() : null, retired_at: p.retired_at ? new Date(p.retired_at).toISOString() : null })),
    readiness: {
      active_policy_id: active?.id ?? null,
      active_version: active?.version ?? null,
      active_is_demo: active?.is_demo ?? null,
      label: active?.is_demo ? "Demo data and sample business rules" : null,
      pricing_in_voice_context: false,
      integrations: { calcom: integrationMode("calcom"), hubspot: integrationMode("hubspot"), resend: integrationMode("resend") },
    },
  };
});

export const POST = route({ auth: "staff", roles: ["admin"], rateLimitPerMinute: 20, maxBodyBytes: 256 * 1024 }, async ({ db, staff, json, requestId }) => {
  const body = await json(z.object({ config: z.unknown() }).strict());
  const result = await db.tx((tx) => createDraft(tx, staff!, body.config, requestId));
  return jsonResponse(result, 201);
});

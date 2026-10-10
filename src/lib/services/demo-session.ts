import { z } from "zod";
import { mintDemoToken } from "@/lib/auth/demo-token";
import { env } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { ApiError } from "@/lib/http/errors";
import { DEMO_STAFF } from "@/lib/seed/demo";

// Evaluator sandbox sign-in (demo mode only). Issues a short-lived token for a seeded demo identity
// carrying the sandbox claim: the session can only see and change simulated records and cannot edit
// studio configuration. Real records still require a Supabase Auth login.

export const DEMO_PERSONAS = ["admin", "front_desk", "front_desk_b", "designer", "designer_b", "designer_c"] as const;
export const demoSessionSchema = z.object({ persona: z.enum(DEMO_PERSONAS).describe("A seeded demo identity (designer = Asha, designer_b = Vikram, designer_c = Neha)") }).strict();
const TTL_SECONDS = 4 * 3600;

export async function startDemoSession(db: Db, body: z.infer<typeof demoSessionSchema>) {
  if (env.appMode() !== "demo" || !env.demoJwtSecret()) throw new ApiError(404, "demo_unavailable", "The demo sandbox is not available on this deployment");
  const identity = DEMO_STAFF.find((s) => s.key === body.persona)!;
  const { rows } = await db.query(`select id, role, display_name, email from public.staff where auth_user_id = $1 and active and is_demo`, [identity.auth]);
  if (!rows[0]) throw new ApiError(503, "demo_not_seeded", "Demo staff are not seeded in this database");
  return {
    access_token: await mintDemoToken(identity.auth, TTL_SECONDS, { sandbox: true }),
    token_type: "bearer" as const,
    expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
    sandbox: true as const,
    staff: { ...rows[0], app_mode: "demo" as const },
  };
}

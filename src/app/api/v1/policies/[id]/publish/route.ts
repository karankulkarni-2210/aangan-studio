import { z } from "zod";
import { route } from "@/lib/http/route";
import { publishPolicy } from "@/lib/services/policies";

export const POST = route({ auth: "staff", roles: ["admin"], rateLimitPerMinute: 10, maxBodyBytes: 1024, sandbox: "deny" }, async ({ db, staff, params, requestId }) =>
  db.tx((tx) => publishPolicy(tx, staff!, z.string().uuid().parse(params.id), requestId)),
);

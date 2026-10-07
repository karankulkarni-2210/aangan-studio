import { z } from "zod";
import { route } from "@/lib/http/route";
import { getLeadDetail, patchLead, patchLeadSchema } from "@/lib/services/leads";

const id = (p: Record<string, string>) => z.string().uuid().parse(p.id);

export const GET = route({ auth: "staff", rateLimitPerMinute: 300 }, async ({ db, staff, params }) => getLeadDetail(db, staff!, id(params)));

export const PATCH = route({ auth: "staff", rateLimitPerMinute: 60, maxBodyBytes: 32 * 1024 }, async ({ db, staff, params, json, req, requestId }) => {
  const body = await json(patchLeadSchema);
  // Optional If-Match header must agree with the body version.
  const ifMatch = req.headers.get("if-match")?.replace(/"/g, "");
  if (ifMatch && Number(ifMatch) !== body.version) {
    return Response.json({ code: "version_mismatch", message: "If-Match does not match body version", request_id: requestId, details: null }, { status: 412 });
  }
  return patchLead(db, staff!, id(params), body, requestId);
});

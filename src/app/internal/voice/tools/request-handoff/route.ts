import { route } from "@/lib/http/route";
import { requestHandoff, requestHandoffSchema } from "@/lib/services/voice-tools";

export const POST = route({ auth: "voice", rateLimitPerMinute: 30, maxBodyBytes: 2 * 1024 }, async ({ db, voice, json, requestId }) =>
  requestHandoff(db, voice!, await json(requestHandoffSchema), requestId),
);

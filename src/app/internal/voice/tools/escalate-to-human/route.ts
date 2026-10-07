import { route } from "@/lib/http/route";
import { escalateSchema, escalateToHuman } from "@/lib/services/voice-tools";

export const POST = route({ auth: "voice", rateLimitPerMinute: 60, maxBodyBytes: 4 * 1024 }, async ({ db, voice, json, requestId }) =>
  escalateToHuman(db, voice!, await json(escalateSchema), requestId),
);

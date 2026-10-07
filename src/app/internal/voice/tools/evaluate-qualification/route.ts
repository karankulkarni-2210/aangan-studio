import { z } from "zod";
import { route } from "@/lib/http/route";
import { evaluateForCall } from "@/lib/services/voice-tools";

export const POST = route({ auth: "voice", rateLimitPerMinute: 60, maxBodyBytes: 1024 }, async ({ db, voice, json }) => {
  await json(z.object({}).strict());
  return evaluateForCall(db, voice!);
});

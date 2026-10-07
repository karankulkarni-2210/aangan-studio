import { route } from "@/lib/http/route";
import { captureFacts, captureFactsSchema } from "@/lib/services/voice-tools";

export const maxDuration = 30;
export const POST = route({ auth: "voice", rateLimitPerMinute: 120, maxBodyBytes: 64 * 1024 }, async ({ db, voice, json }) => captureFacts(db, voice!, await json(captureFactsSchema)));

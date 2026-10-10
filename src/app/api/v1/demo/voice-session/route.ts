import { jsonResponse, route } from "@/lib/http/route";
import { startVoiceTest } from "@/lib/services/voice-test";

// Contract addition: in-browser live voice test with the studio's Vaani agent (demo mode only).
// Recorded as a simulated call; rate-limited because each session uses Vaani minutes.
export const POST = route({ auth: "staff", rateLimitPerMinute: 3, maxBodyBytes: 1024 }, async ({ db }) => jsonResponse(await startVoiceTest(db), 201));

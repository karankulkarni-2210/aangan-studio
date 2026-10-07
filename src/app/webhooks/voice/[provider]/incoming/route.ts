import { route } from "@/lib/http/route";
import { handleVoiceWebhook } from "@/lib/services/webhooks";

export const POST = route({ auth: "webhook", rateLimitPerMinute: 600, maxBodyBytes: 32 * 1024 }, (ctx) => handleVoiceWebhook(ctx, "incoming"));

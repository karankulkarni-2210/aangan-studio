import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string, message: string | Buffer): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Per-call tool token. Derived (not stored) so a retried incoming webhook can return the same
 * token; knowledge of the token binds tool calls to exactly one call. Requires VOICE_TOOL_SECRET.
 */
export function callToolToken(secret: string, callId: string): string {
  return hmacHex(secret, `aangan-call-tool:v1:${callId}`);
}

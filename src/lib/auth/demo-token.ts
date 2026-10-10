import { SignJWT } from "jose";
import { env } from "@/lib/config/env";

/**
 * Mints a short-lived HS256 access token for a demo staff identity. Demo mode only: live mode
 * ignores DEMO_JWT_SECRET entirely, so these tokens can never authenticate against a live deployment.
 */
export async function mintDemoToken(authUserId: string, ttlSeconds = 8 * 3600, opts: { sandbox?: boolean } = {}): Promise<string> {
  const secret = env.demoJwtSecret();
  if (env.appMode() !== "demo" || !secret) throw new Error("demo tokens require APP_MODE=demo and DEMO_JWT_SECRET");
  if (secret.length < 32) throw new Error("DEMO_JWT_SECRET must be at least 32 characters");
  return new SignJWT({ role: "authenticated", ...(opts.sandbox ? { aangan_sandbox: true } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(authUserId)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

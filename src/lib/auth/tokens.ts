import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { env } from "@/lib/config/env";

// Supabase Auth access-token verification.
//  * Asymmetric signing keys (ES256/RS256): verified against the project JWKS endpoint.
//  * Legacy HS256 shared secret: SUPABASE_JWT_SECRET (supported, but Supabase recommends JWKS).
//  * Demo HS256 secret: DEMO_JWT_SECRET, accepted ONLY when APP_MODE=demo. Generated locally;
//    there is no built-in credential.

let jwks: { url: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

function remoteJwks(supabaseUrl: string) {
  const url = `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
  if (!jwks || jwks.url !== url) jwks = { url, set: createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60 * 1000 }) };
  return jwks.set;
}

export interface VerifiedToken {
  sub: string;
  source: "supabase_jwks" | "supabase_hs256" | "demo";
  /** Evaluator sandbox session (demo token with the sandbox claim): simulated records only, no config writes. */
  sandbox: boolean;
}

export class TokenError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkClaims(payload: JWTPayload): string {
  if (payload.role !== "authenticated") throw new TokenError("token role is not authenticated");
  if ((payload as { is_anonymous?: boolean }).is_anonymous) throw new TokenError("anonymous sessions are not staff");
  if (!payload.sub || !UUID.test(payload.sub)) throw new TokenError("token subject is not a user id");
  return payload.sub;
}

export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new TokenError("malformed token");
  }
  const opts = { audience: "authenticated", clockTolerance: 30 };

  if (alg === "HS256") {
    const candidates: Array<[VerifiedToken["source"], string | undefined]> = [
      ["supabase_hs256", env.supabaseJwtSecret()],
      ["demo", env.demoJwtSecret()],
    ];
    for (const [source, secret] of candidates) {
      if (!secret) continue;
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { ...opts, algorithms: ["HS256"] });
        return { sub: checkClaims(payload), source, sandbox: source === "demo" && payload.aangan_sandbox === true };
      } catch (err) {
        if (err instanceof TokenError) throw err;
      }
    }
    throw new TokenError("token signature not accepted");
  }

  if (alg === "ES256" || alg === "RS256") {
    const supabaseUrl = env.supabaseUrl();
    if (!supabaseUrl) throw new TokenError("asymmetric tokens require SUPABASE_URL for JWKS");
    try {
      const { payload } = await jwtVerify(token, remoteJwks(supabaseUrl), {
        ...opts,
        algorithms: ["ES256", "RS256"],
        issuer: `${supabaseUrl.replace(/\/$/, "")}/auth/v1`,
      });
      return { sub: checkClaims(payload), source: "supabase_jwks", sandbox: false };
    } catch (err) {
      if (err instanceof TokenError) throw err;
      throw new TokenError("token signature not accepted");
    }
  }
  throw new TokenError(`unsupported token algorithm ${alg ?? "none"}`);
}

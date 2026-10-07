import { randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { env, isLiveAndIncomplete } from "@/lib/config/env";
import { callToolToken, safeEqual } from "@/lib/auth/crypto";
import { TokenError, verifyAccessToken } from "@/lib/auth/tokens";
import type { Db } from "@/lib/db/types";
import type { Role } from "@/lib/domain/enums";
import { SpeechGuardError } from "@/lib/domain/speech-guard";
import { log } from "@/lib/log";
import { getDb, MissingDatabaseError, now } from "@/lib/runtime";
import { ApiError, badRequest, forbidden, unauthorized, unavailable } from "./errors";

export interface StaffActor {
  id: string;
  auth_user_id: string;
  role: Role;
  display_name: string;
  email: string;
}

export interface VoiceBinding {
  callId: string;
  leadId: string | null;
  provider: string;
  isSimulated: boolean;
  /** End-of-call processing has run; decisions can no longer change through voice tools. */
  finalized: boolean;
}

export type AuthKind = "none" | "staff" | "voice" | "staff_or_voice" | "dispatch" | "webhook";

export interface RouteOptions {
  auth: AuthKind;
  roles?: Role[];
  maxBodyBytes?: number;
  /** Requests per minute for the authenticated principal (or client IP for webhooks). */
  rateLimitPerMinute?: number;
  /** Health/readiness are served even when live configuration is incomplete. */
  allowWhenLiveIncomplete?: boolean;
}

export interface RouteContext {
  req: Request;
  url: URL;
  requestId: string;
  params: Record<string, string>;
  db: Db;
  staff: StaffActor | null;
  voice: VoiceBinding | null;
  rawBody(): Promise<string>;
  json<T>(schema: ZodType<T>): Promise<T>;
  query<T>(schema: ZodType<T>): T;
}

type Handler = (ctx: RouteContext) => Promise<Response | unknown>;
type NextContext = { params: Promise<Record<string, string | string[]>> };

const DEFAULT_BODY_LIMIT = 64 * 1024;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function errorResponse(err: ApiError, requestId: string): Response {
  return jsonResponse(
    { code: err.code, message: err.message, request_id: requestId, details: err.details ?? null },
    err.status,
    { "x-request-id": requestId, ...err.headers },
  );
}

async function readLimited(req: Request, limit: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) throw new ApiError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

async function authenticateStaff(db: Db, req: Request): Promise<StaffActor> {
  const token = bearer(req);
  if (!token) throw unauthorized();
  let sub: string;
  try {
    sub = (await verifyAccessToken(token)).sub;
  } catch (err) {
    throw unauthorized(err instanceof TokenError ? err.message : "Invalid token");
  }
  const { rows } = await db.query<StaffActor>(
    `select id, auth_user_id, role, display_name, email from public.staff where auth_user_id = $1 and active`,
    [sub],
  );
  if (!rows[0]) throw forbidden("Authenticated user is not active studio staff");
  return rows[0];
}

const CALL_TOOL_GRACE_MS = 15 * 60 * 1000;

async function authenticateVoice(db: Db, req: Request): Promise<VoiceBinding> {
  const secret = env.voiceToolSecret();
  if (!secret) throw unavailable("voice_tools_not_configured", "VOICE_TOOL_SECRET is not configured");
  const token = bearer(req);
  if (!token || !safeEqual(token, secret)) throw unauthorized("Invalid voice service credential");
  const callId = req.headers.get("x-aangan-call-id") ?? "";
  const callToken = req.headers.get("x-aangan-call-token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(callId) || !safeEqual(callToken, callToolToken(secret, callId))) {
    throw unauthorized("Tool call is not bound to a valid call");
  }
  const { rows } = await db.query(
    `select id, lead_id, provider, is_simulated, status, ended_at, finalized_at from public.calls where id = $1`,
    [callId],
  );
  const call = rows[0];
  if (!call) throw unauthorized("Unknown call");
  if (call.ended_at && now().getTime() - new Date(call.ended_at).getTime() > CALL_TOOL_GRACE_MS) {
    throw new ApiError(409, "call_closed", "The call has ended; tools are no longer available");
  }
  return { callId: call.id, leadId: call.lead_id, provider: call.provider, isSimulated: call.is_simulated, finalized: Boolean(call.finalized_at) };
}

export async function consumeRateLimit(db: Db, key: string, limitPerMinute: number): Promise<void> {
  const windowStart = new Date(Math.floor(now().getTime() / 60000) * 60000);
  const { rows } = await db.query<{ count: number }>(
    `insert into public.rate_limit_buckets (key, window_start, count) values ($1, $2, 1)
     on conflict (key, window_start) do update set count = public.rate_limit_buckets.count + 1
     returning count`,
    [key, windowStart],
  );
  if ((rows[0]?.count ?? 0) > limitPerMinute) {
    const retry = Math.max(1, Math.ceil((windowStart.getTime() + 60000 - now().getTime()) / 1000));
    throw new ApiError(429, "rate_limited", "Too many requests", { limit_per_minute: limitPerMinute }, { "retry-after": String(retry) });
  }
}

export function route(opts: RouteOptions, handler: Handler) {
  return async (req: Request, nextCtx?: NextContext): Promise<Response> => {
    const incomingId = req.headers.get("x-request-id");
    const requestId = incomingId && /^[\w-]{8,64}$/.test(incomingId) ? incomingId : randomUUID();
    try {
      if (!opts.allowWhenLiveIncomplete && isLiveAndIncomplete()) {
        throw unavailable("configuration_incomplete", "Live mode is not fully configured; refusing to serve (fail closed)");
      }
      const rawParams = nextCtx ? await nextCtx.params : {};
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawParams ?? {})) params[k] = Array.isArray(v) ? v.join("/") : v;

      let db: Db;
      try {
        db = await getDb();
      } catch (err) {
        if (err instanceof MissingDatabaseError) throw unavailable("database_not_configured", "DATABASE_URL is not configured");
        throw err;
      }

      let staff: StaffActor | null = null;
      let voice: VoiceBinding | null = null;
      if (opts.auth === "staff") staff = await authenticateStaff(db, req);
      else if (opts.auth === "voice") voice = await authenticateVoice(db, req);
      else if (opts.auth === "staff_or_voice") {
        if (req.headers.get("x-aangan-call-id")) voice = await authenticateVoice(db, req);
        else staff = await authenticateStaff(db, req);
      } else if (opts.auth === "dispatch") {
        const secret = env.dispatchSecret();
        if (!secret) throw unavailable("dispatcher_not_configured", "DISPATCH_SECRET or CRON_SECRET is not configured");
        const token = bearer(req);
        if (!token || !safeEqual(token, secret)) throw unauthorized("Invalid dispatcher credential");
      }
      if (staff && opts.roles && !opts.roles.includes(staff.role)) throw forbidden();

      if (opts.rateLimitPerMinute) {
        const principal = staff ? `staff:${staff.id}` : voice ? `call:${voice.callId}` : `ip:${clientIp(req)}`;
        // One bucket per method + route template (ids collapsed), so routes keep their own limits.
        const template = new URL(req.url).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
        await consumeRateLimit(db, `${req.method} ${template}|${principal}`, opts.rateLimitPerMinute);
      }

      let bodyCache: string | null = null;
      const url = new URL(req.url);
      const ctx: RouteContext = {
        req,
        url,
        requestId,
        params,
        db,
        staff,
        voice,
        async rawBody() {
          if (bodyCache === null) bodyCache = await readLimited(req, opts.maxBodyBytes ?? DEFAULT_BODY_LIMIT);
          return bodyCache;
        },
        async json<T>(schema: ZodType<T>) {
          const raw = await ctx.rawBody();
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            throw badRequest("invalid_json", "Request body is not valid JSON");
          }
          return schema.parse(parsed);
        },
        query<T>(schema: ZodType<T>) {
          const obj: Record<string, string> = {};
          url.searchParams.forEach((value, key) => {
            obj[key] = value;
          });
          return schema.parse(obj);
        },
      };

      const result = await handler(ctx);
      const res = result instanceof Response ? result : jsonResponse(result);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err, requestId);
      if (err instanceof ZodError) {
        return errorResponse(
          badRequest(
            "validation_failed",
            "Request failed validation",
            err.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })),
          ),
          requestId,
        );
      }
      if (err instanceof SpeechGuardError) {
        // A server-authored script tripped the pricing guard: never send it.
        log.error("speech_guard_blocked", { request_id: requestId, field: err.field, codes: err.codes });
        return errorResponse(new ApiError(500, "speech_guard_blocked", "Response withheld by the pricing guard"), requestId);
      }
      log.error("unhandled_error", { request_id: requestId, path: new URL(req.url).pathname, error: err });
      return errorResponse(new ApiError(500, "internal_error", "Unexpected server error"), requestId);
    }
  };
}

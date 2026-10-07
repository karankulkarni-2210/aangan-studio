import { z } from "zod";
import { runDispatcher } from "@/lib/jobs/handlers";
import { route, type RouteContext } from "@/lib/http/route";

// Protected, bounded dispatcher. POST is the contract; GET exists only because Vercel Cron issues
// GET requests (Authorization: Bearer CRON_SECRET). Never public, never unbounded.
export const maxDuration = 60;

const limits = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), time_budget_ms: z.coerce.number().int().min(1000).max(50000).default(20000) });

const handler = async (ctx: RouteContext) => {
  const q = ctx.query(limits);
  return runDispatcher(ctx.db, { limit: q.limit, timeBudgetMs: q.time_budget_ms, trigger: ctx.req.headers.get("user-agent")?.startsWith("vercel-cron") ? "vercel_cron" : ctx.req.method === "GET" ? "cron_get" : "post" });
};

export const POST = route({ auth: "dispatch", rateLimitPerMinute: 30, maxBodyBytes: 1024 }, handler);
export const GET = route({ auth: "dispatch", rateLimitPerMinute: 30 }, handler);

import { env } from "@/lib/config/env";
import { classifyFetchError, type EmailAdapter } from "./types";

// Resend email. Verified against resend.com/docs on 2026-10-07: POST /emails, Bearer key,
// User-Agent header required, Idempotency-Key (1-256 chars) retained for 24 hours. Local dedupe
// (one handoff row per lead+purpose) covers retries beyond that window. Exactly-once delivery is
// NOT claimed: a send that times out after Resend accepted it, and is retried after 24 hours,
// could deliver twice.

const TIMEOUT_MS = 10_000;

export function createResendAdapter(fetchImpl: typeof fetch = fetch): EmailAdapter {
  const cfg = env.resend();
  return {
    mode: "live",
    async send(msg) {
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/emails`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.apiKey}`,
            "content-type": "application/json",
            "user-agent": "aangan-studio-backend/0.1",
            "idempotency-key": msg.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({
            from: cfg.from,
            to: [msg.to],
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
            tags: Object.entries(msg.tags).map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) })),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const r = classifyFetchError(err);
        // With an idempotency key, retrying an ambiguous send inside 24h is safe.
        return r.status === "ambiguous" ? { status: "failed", message: r.message, retriable: true } : r;
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
      if (res.ok && json.id) return { status: "ok", data: { id: json.id } };
      if (res.status === 409) {
        // concurrent_idempotent_requests is transient; invalid_idempotent_request means a changed payload.
        const transient = /concurrent/i.test(`${json.name} ${json.message}`);
        return { status: "failed", message: `Resend 409 ${json.name ?? ""}`, retriable: transient };
      }
      return { status: "failed", message: `Resend HTTP ${res.status} ${json.name ?? ""}`.trim(), retriable: res.status === 429 || res.status >= 500 };
    },
  };
}

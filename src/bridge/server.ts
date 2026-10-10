import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { safeEqual } from "@/lib/auth/crypto";
import { env } from "@/lib/config/env";
import type { Db } from "@/lib/db/types";
import { ApiError } from "@/lib/http/errors";
import { runDispatcher } from "@/lib/jobs/handlers";
import { log } from "@/lib/log";
import { getDb } from "@/lib/runtime";
import { Conversation, type TranscriptMessage } from "@/lib/voice/conversation";
import { handleVaaniWebhook } from "@/lib/voice/vaani-events";

// Vaani voice bridge: a small always-on Node service (WebSockets cannot run on Vercel functions).
//   wss://<host>/vaani/byol/<call_id>   Vaani "Bring Your Own LLM" connection (Bearer VAANI_BYOL_TOKEN)
//   POST https://<host>/vaani/webhook?token=VAANI_WEBHOOK_SECRET   Vaani call events
//   GET  https://<host>/health
// It shares the database and business code with the Next.js app. It also runs the bounded outbox
// dispatcher once a minute (BRIDGE_RUN_DISPATCHER=false to disable), so it can be the scheduler.

const BODY_LIMIT = 256 * 1024;
const CALL_ID = /^[\w.:@-]{1,200}$/;

export interface Bridge {
  port: number;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new ApiError(413, "payload_too_large", "Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function startBridge(opts: { port?: number; db?: Db; path?: string; runDispatcher?: boolean } = {}): Promise<Bridge> {
  const db = opts.db ?? (await getDb());
  const wsPath = (opts.path ?? "/vaani/byol").replace(/\/$/, "");
  const conversations = new Set<WebSocket>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    try {
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { status: "ok", active_calls: conversations.size });
      if (req.method === "POST" && url.pathname === "/vaani/webhook") {
        const raw = await readBody(req);
        return sendJson(res, 200, await handleVaaniWebhook(db, raw, url.searchParams.get("token")));
      }
      sendJson(res, 404, { code: "not_found", message: "Not found" });
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { code: err.code, message: err.message });
      log.error("bridge_http_error", { path: url.pathname, error: err });
      sendJson(res, 500, { code: "internal_error", message: "Unexpected error" });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    const reject = (code: number, text: string) => {
      // Logged without headers or tokens, so failed Vaani "Test Connection" attempts can be diagnosed.
      log.warn("bridge_upgrade_rejected", { status: code, path: url.pathname, has_auth: Boolean(req.headers.authorization) });
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // `/vaani/byol` with no call id = Vaani's "Test Connection" (nothing is recorded).
    const isTest = url.pathname === wsPath;
    if (!isTest && !url.pathname.startsWith(`${wsPath}/`)) return reject(404, "Not Found");
    const callId = isTest ? "" : decodeURIComponent(url.pathname.slice(wsPath.length + 1));
    if (!isTest && !CALL_ID.test(callId)) return reject(400, "Bad Request");
    const token = env.vaani().byolToken;
    if (!token) return reject(503, "Service Unavailable");
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
    // Vaani's Test Connection sends no token; the test path records nothing. Real calls must authenticate.
    if (!isTest && !safeEqual(auth, token)) return reject(401, "Unauthorized");
    log.info("bridge_connected", { test: isTest, has_auth: Boolean(auth) });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, callId));
  });

  wss.on("connection", (ws: WebSocket, callId: string) => {
    conversations.add(ws);
    let conversation: Conversation | null = null;
    let chain: Promise<unknown> = Promise.resolve();
    ws.send(JSON.stringify({ interaction_type: "config", content: "Aangan Studio bridge ready" }));
    ws.send(JSON.stringify({ interaction_type: "greeting", content: "connected" }));

    ws.on("message", (data) => {
      chain = chain.then(async () => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.response_type === "ping_pong") return ws.send(JSON.stringify({ response_type: "ping_pong" }));
        if (msg.interaction_type !== "response_required" && msg.interaction_type !== "reminder_required") return;
        if (!callId) {
          // Connection test: answer without creating a call or lead.
          return ws.send(JSON.stringify({ response_type: "response", response_id: msg.response_id, content: "Aangan Studio bridge is connected.", content_complete: true }));
        }
        conversation ??= new Conversation(db, callId, (msg.req_body as Record<string, unknown> | null) ?? null);
        const transcript = Array.isArray(msg.transcript) ? (msg.transcript as TranscriptMessage[]) : [];
        const reply = await conversation.respond(transcript);
        if (ws.readyState !== ws.OPEN) return;
        ws.send(
          JSON.stringify({
            response_type: "response",
            response_id: msg.response_id,
            content: reply.content,
            content_complete: true,
            ...(reply.endCall ? { end_call: true } : {}),
          }),
        );
      }).catch((err) => log.error("bridge_message_failed", { call: callId, error: err }));
    });

    ws.on("close", () => {
      conversations.delete(ws);
      chain = chain
        .then(async () => {
          await conversation?.finish("connection_closed");
          if (opts.runDispatcher !== false) await runDispatcher(db, { trigger: "bridge_call_end" });
        })
        .catch((err) => log.error("bridge_close_failed", { call: callId, error: err }));
    });
  });

  let ticking = false;
  const timer =
    opts.runDispatcher === false
      ? null
      : setInterval(async () => {
          if (ticking) return;
          ticking = true;
          try {
            await runDispatcher(db, { trigger: "bridge_interval" });
          } catch (err) {
            log.error("bridge_dispatch_failed", { error: err });
          } finally {
            ticking = false;
          }
        }, 60_000);

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, resolve));
  const port = (server.address() as AddressInfo).port;
  log.info("bridge_listening", { port, ws_path: `${wsPath}/<call_id>` });
  return {
    port,
    close: async () => {
      if (timer) clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

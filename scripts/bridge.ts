/**
 * Vaani voice bridge (WebSocket "Bring Your Own LLM" + call-event webhook + scheduled dispatcher).
 *   npm run bridge            # listens on BRIDGE_PORT (default 8787); reads .env.local if present
 * Expose it publicly (Render/Railway, or a tunnel for local testing) and configure Vaani with:
 *   BYOL WebSocket URL: wss://<host>/vaani/byol        Auth token: VAANI_BYOL_TOKEN
 *   Webhook URL:        https://<host>/vaani/webhook?token=<VAANI_WEBHOOK_SECRET>
 */
import fs from "node:fs";

if (fs.existsSync(".env.local")) {
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

(async () => {
  const { startBridge } = await import("../src/bridge/server");
  const bridge = await startBridge({ port: Number(process.env.BRIDGE_PORT ?? process.env.PORT ?? 8787), runDispatcher: process.env.BRIDGE_RUN_DISPATCHER !== "false" });
  console.log(`Vaani bridge listening on :${bridge.port}  (ws path /vaani/byol/<call_id>, webhook /vaani/webhook, health /health)`);
  const stop = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "[url]"));
  process.exit(1);
});

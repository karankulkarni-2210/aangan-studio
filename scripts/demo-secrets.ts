/**
 * Writes random local secrets to .env.local (git-ignored) if they are not already set.
 * Demo mode only; these are never shared or committed, and DEMO_JWT_SECRET is ignored in live mode.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";

const file = ".env.local";
const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const lines: string[] = [];
for (const name of ["DEMO_JWT_SECRET", "VOICE_TOOL_SECRET", "DISPATCH_SECRET", "SIMULATED_VOICE_WEBHOOK_SECRET"]) {
  if (new RegExp(`^${name}=`, "m").test(existing)) continue;
  lines.push(`${name}=${randomBytes(32).toString("hex")}`);
}
if (!/^APP_MODE=/m.test(existing)) lines.unshift("APP_MODE=demo");
if (lines.length) fs.appendFileSync(file, (existing && !existing.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
console.log(lines.length ? `added ${lines.length} value(s) to ${file} (values not printed)` : `${file} already has the demo secrets`);

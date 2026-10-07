/**
 * Prints a short-lived demo access token for a seeded demo identity (APP_MODE=demo only).
 *   npm run demo:token -- admin | front_desk | front_desk_b | designer | designer_b | designer_c
 * Reads DEMO_JWT_SECRET from the environment or .env.local.
 */
import fs from "node:fs";
import { mintDemoToken } from "../src/lib/auth/demo-token";
import { DEMO_STAFF } from "../src/lib/seed/demo";

if (fs.existsSync(".env.local")) {
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const key = process.argv[2] ?? "admin";
const staff = DEMO_STAFF.find((s) => s.key === key);
if (!staff) {
  console.error(`unknown identity ${key}; choose ${DEMO_STAFF.map((s) => s.key).join(", ")}`);
  process.exit(1);
}
mintDemoToken(staff.auth).then((t) => console.log(t), (e) => {
  console.error(e.message);
  process.exit(1);
});

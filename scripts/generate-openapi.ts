import fs from "node:fs";
import path from "node:path";
import { buildOpenApi } from "../src/lib/api/openapi";

const out = path.resolve(process.cwd(), "openapi.json");
fs.writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`wrote ${out}`);

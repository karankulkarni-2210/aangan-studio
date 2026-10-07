import fs from "node:fs";
import path from "node:path";
import { demoSeedSql } from "../src/lib/seed/demo";

const out = path.resolve(process.cwd(), "supabase", "seed.sql");
fs.writeFileSync(out, demoSeedSql());
console.log(`wrote ${out}`);

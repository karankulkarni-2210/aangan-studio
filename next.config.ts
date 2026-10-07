import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg (Supabase) and PGlite (local demo database) load at runtime on the server only.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  poweredByHeader: false,
};

export default nextConfig;

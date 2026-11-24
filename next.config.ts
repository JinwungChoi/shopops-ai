import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  ...(process.env.SHOP_OPS_BACKEND === "supabase"
    ? { distDir: ".next-supabase" }
    : {}),
};

export default config;

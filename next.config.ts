import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  // 로컬에서는 Supabase 모드 빌드를 따로 두고, Vercel은 기본 .next만 읽으므로 그대로 둔다.
  ...(process.env.SHOP_OPS_BACKEND === "supabase" && process.env.VERCEL !== "1"
    ? { distDir: ".next-supabase" }
    : {}),
};

export default config;

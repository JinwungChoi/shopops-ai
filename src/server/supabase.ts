import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { DemoError } from "./demo-core";

function apiUrl() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new DemoError(503, "Supabase URL을 설정해 주세요.");
  return url;
}

export const isSupabaseEnabled = () => process.env.SHOP_OPS_BACKEND === "supabase";
// 공개 데모 배포: 고객 채팅만 연다. 관리자 가입·로그인·업체 API는 막는다(문서 인덱싱 비용과 데이터 변경 방지).
export const isPublicDemo = () => process.env.SHOP_OPS_PUBLIC_DEMO === "1";

export async function userClient(cookieName?: string) {
  const jar = await cookies();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!key) throw new DemoError(503, "Supabase 공개 키를 설정해 주세요.");

  return createServerClient(apiUrl(), key, {
    cookieOptions: cookieName ? { name: cookieName, httpOnly: true, sameSite: "lax" } : undefined,
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (values) => {
        for (const { name, value, options } of values) jar.set(name, value, options);
      },
    },
  });
}

export const customerClient = () => userClient("shopops-customer-auth");

export function serverClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new DemoError(503, "Supabase 서버 키를 설정해 주세요.");
  return createClient(apiUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      }),
    },
  });
}

export async function requireUser() {
  const client = await userClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new DemoError(401, "관리자 로그인이 필요해요.");
  return { client, userId: data.user.id };
}

export async function requireTenant(tenantId: string) {
  const context = await requireUser();
  const { data, error } = await context.client.from("tenant_members").select("tenant_id, role")
    .eq("tenant_id", tenantId).eq("user_id", context.userId).maybeSingle();
  if (error) throw new DemoError(502, "업체 권한을 확인하지 못했어요.");
  if (!data || !["owner", "staff"].includes(data.role)) throw new DemoError(404, "쇼핑몰을 찾을 수 없어요.");
  return { ...context, tenantId: String(data.tenant_id) };
}

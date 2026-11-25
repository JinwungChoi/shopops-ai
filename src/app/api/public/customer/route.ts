import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, readBody, respond } from "@/server/demo-http";
import { DemoError } from "@/server/demo-core";
import { customerClient, isSupabaseEnabled } from "@/server/supabase";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), email: z.email().max(254), password: z.string().min(8).max(128) }).strict(),
  z.object({ action: z.literal("demo"), customer: z.enum(["a", "b"]) }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
]);

// 시연용 합성 고객 두 명만 버튼으로 전환한다. 비밀번호는 서버에만 두고 브라우저에는 고객 키(a/b)만 보낸다.
const demoCustomers = { a: "style-customer-a@example.com", b: "style-customer-b@example.com" } as const;
const demoPassword = () => process.env.SHOP_OPS_DEMO_PASSWORD || "StyleShop-Demo-2026!";
const demoKey = (email: string | undefined) =>
  (Object.keys(demoCustomers) as (keyof typeof demoCustomers)[]).find((key) => demoCustomers[key] === email) ?? null;

export function GET(request: NextRequest) {
  return handle(request, async () => {
    if (!isSupabaseEnabled()) throw new DemoError(404, "고객 로그인은 실제 모델 데모에서 사용할 수 있어요.");
    const { data } = await (await customerClient()).auth.getUser();
    return respond(request, { loggedIn: Boolean(data.user), customer: demoKey(data.user?.email) });
  });
}

export function POST(request: NextRequest) {
  return handle(request, async () => {
    if (!isSupabaseEnabled()) throw new DemoError(404, "고객 로그인은 실제 모델 데모에서 사용할 수 있어요.");
    const command = await readBody(request, commandSchema);
    const client = await customerClient();
    if (command.action === "logout") {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw new DemoError(502, "고객 로그아웃에 실패했어요.");
      return respond(request, { loggedIn: false, customer: null });
    }
    const credentials = command.action === "demo"
      ? { email: demoCustomers[command.customer], password: demoPassword() }
      : { email: command.email, password: command.password };
    const { data, error } = await client.auth.signInWithPassword(credentials);
    if (error || !data.user) {
      throw new DemoError(401, command.action === "demo" ? "데모 고객 계정을 찾지 못했어요. 로컬 시드를 확인해 주세요." : "고객 이메일과 비밀번호를 확인해 주세요.");
    }
    return respond(request, { loggedIn: true, customer: demoKey(data.user.email) });
  });
}

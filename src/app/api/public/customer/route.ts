import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, readBody, respond } from "@/server/demo-http";
import { DemoError } from "@/server/demo-core";
import { customerClient, isSupabaseEnabled } from "@/server/supabase";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), email: z.email().max(254), password: z.string().min(8).max(128) }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
]);

export function GET(request: NextRequest) {
  return handle(request, async () => {
    if (!isSupabaseEnabled()) throw new DemoError(404, "고객 로그인은 실제 모델 데모에서 사용할 수 있어요.");
    const { data } = await (await customerClient()).auth.getUser();
    return respond(request, { loggedIn: Boolean(data.user) });
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
      return respond(request, { loggedIn: false });
    }
    const { data, error } = await client.auth.signInWithPassword({ email: command.email, password: command.password });
    if (error || !data.user) throw new DemoError(401, "고객 이메일과 비밀번호를 확인해 주세요.");
    return respond(request, { loggedIn: true });
  });
}

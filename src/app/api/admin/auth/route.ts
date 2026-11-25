import type { NextRequest } from "next/server";
import { z } from "zod";
import { DemoError } from "@/server/demo-core";
import { handle, readBody, respond } from "@/server/demo-http";
import { isPublicDemo, isSupabaseEnabled, userClient } from "@/server/supabase";

const credentials = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["login", "signup"]), email: z.email().max(254), password: z.string().min(8).max(128) }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
]);

export function POST(request: NextRequest) {
  return handle(request, async () => {
    if (!isSupabaseEnabled()) throw new DemoError(404, "Supabase 모드를 먼저 설정해 주세요.");
    if (isPublicDemo()) throw new DemoError(403, "공개 데모에서는 관리자 기능을 열지 않아요.");
    const command = await readBody(request, credentials);
    const client = await userClient();
    if (command.action === "logout") {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw new DemoError(502, "로그아웃하지 못했어요.");
      return respond(request, { loggedIn: false });
    }
    const input = { email: command.email, password: command.password };
    const { data, error } = command.action === "login" ? await client.auth.signInWithPassword(input) : await client.auth.signUp(input);
    if (error) throw new DemoError(400, "이메일과 비밀번호를 확인해 주세요.");
    return respond(request, { loggedIn: Boolean(data.session), emailConfirmationRequired: !data.session });
  });
}

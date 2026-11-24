import type { NextRequest } from "next/server";
import { z } from "zod";
import { DemoError } from "@/server/demo-core";
import { handle, respond } from "@/server/demo-http";
import { history } from "@/server/live-chat";
import { isSupabaseEnabled } from "@/server/supabase";

export function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  return handle(request, async () => {
    if (!isSupabaseEnabled()) throw new DemoError(404, "대화 내역을 찾을 수 없어요.");
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new DemoError(401, "대화를 먼저 시작해 주세요.");
    const id = z.uuid().safeParse((await params).sessionId);
    const offset = z.coerce.number().int().min(0).max(2000).safeParse(request.nextUrl.searchParams.get("offset") ?? "0");
    if (!id.success || !offset.success) throw new DemoError(400, "요청을 확인해 주세요.");
    return respond(request, { messages: await history(id.data, token, offset.data) });
  });
}

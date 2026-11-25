import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Answer } from "@/lib/demo";
import type { ChatEvent, ReportProgress } from "@/lib/chat-progress";
import { DemoError } from "@/server/demo-core";
import { clientIp, handle, readBody, respond, store, workspace } from "@/server/demo-http";
import { generate } from "@/server/generation";
import { answerMessage } from "@/server/live-chat";
import { decisionContent } from "@/server/agent-workflow";
import { isSupabaseEnabled } from "@/server/supabase";

const base = z.object({
  sessionId: z.uuid(),
  clientRequestId: z.uuid(),
});
const input = z.union([
  base.extend({ content: z.string().trim().min(1).max(2000) }).strict(),
  base.extend({ action: z.object({
    approvalId: z.uuid(), decision: z.enum(["confirm", "cancel"]), itemConditionConfirmed: z.boolean(),
  }).strict() }).strict(),
]);

function streamAnswer(run: (report: ReportProgress) => Promise<Answer>) {
  const encoder = new TextEncoder();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) => {
        if (!canceled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const data = await run((stage) => send({ type: "progress", stage }));
        send({ type: "answer", data });
      } catch (error) {
        send({ type: "error", message: error instanceof DemoError ? error.message : "요청을 처리하지 못했어요. 다시 시도해 주세요." });
      } finally {
        if (!canceled) controller.close();
      }
    },
    cancel() { canceled = true; },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store" } });
}

export function POST(request: NextRequest) {
  return handle(request, async () => {
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new DemoError(401, "대화를 먼저 시작해 주세요.");
    const body = await readBody(request, input);
    const { sessionId, clientRequestId } = body;
    const action = "action" in body ? body.action : undefined;
    const content = "content" in body ? body.content : decisionContent(body.action);
    const live = isSupabaseEnabled();
    if (action && !live) throw new DemoError(404, "접수 기능을 사용할 수 없어요.");
    const scope = live ? undefined : workspace(request);
    const run = async (report?: ReportProgress): Promise<Answer> => live
      ? answerMessage(sessionId, token, clientRequestId, content, report, action, clientIp(request))
      : store.answer(scope!.id, sessionId, token, clientRequestId, content, generate, report);
    if (request.headers.get("accept")?.includes("application/x-ndjson")) return streamAnswer(run);
    return respond(request, await run());
  });
}

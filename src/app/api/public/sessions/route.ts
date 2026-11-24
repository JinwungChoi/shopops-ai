import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, readBody, respond, shopSchema, store, workspace } from "@/server/demo-http";
import { createSession } from "@/server/live-chat";
import { isSupabaseEnabled } from "@/server/supabase";

const demo = z.object({ publicWidgetKey: shopSchema }).strict();
const live = z.object({ publicWidgetKey: z.string().regex(/^[a-f0-9]{32}$/) }).strict();

export function POST(request: NextRequest) {
  return handle(request, async () => {
    if (isSupabaseEnabled()) {
      const { publicWidgetKey } = await readBody(request, live);
      return respond(request, await createSession(publicWidgetKey), undefined, 201);
    }
    const { publicWidgetKey } = await readBody(request, demo);
    const scope = workspace(request, true);
    return respond(request, store.session(scope.id, publicWidgetKey), scope, 201);
  });
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { DemoError } from "@/server/demo-core";
import { handle, readBody, respond, shopSchema, store, workspace } from "@/server/demo-http";

const fields = { shop: shopSchema, id: z.string().max(100), version: z.int().positive() };
const edit = z.object({ ...fields, content: z.string().trim().min(1).max(10_000) }).strict();
const index = z.object(fields).strict();

export function GET(request: NextRequest) {
  return handle(request, () => {
    const shop = shopSchema.safeParse(request.nextUrl.searchParams.get("shop"));
    if (!shop.success) throw new DemoError(404, "쇼핑몰을 찾을 수 없어요.");
    const scope = workspace(request, true);
    return respond(request, { documents: store.documents(scope.id, shop.data) }, scope);
  });
}

export function PATCH(request: NextRequest) {
  return handle(request, async () => {
    const scope = workspace(request);
    const { shop, id, version, content } = await readBody(request, edit);
    return respond(request, { document: store.update(scope.id, shop, id, version, content) });
  });
}

export function POST(request: NextRequest) {
  return handle(request, async () => {
    const scope = workspace(request);
    const { shop, id, version } = await readBody(request, index);
    return respond(request, { document: store.index(scope.id, shop, id, version) });
  });
}

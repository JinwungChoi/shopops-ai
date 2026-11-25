import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { showcaseShop } from "@/lib/demo";
import { DemoError, DemoStore } from "./demo-core";

const runtime = globalThis as typeof globalThis & { shopOpsDemo?: DemoStore };
export const store = runtime.shopOpsDemo ??= new DemoStore();
const cookieName = "shopops_workspace";

export const shopSchema = z.literal(showcaseShop);

export async function readBody<T>(request: NextRequest, schema: z.ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new DemoError(415, "JSON 요청이 필요해요.");
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  if (reader) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 48_000) {
        await reader.cancel();
        throw new DemoError(413, "요청이 너무 커요.");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  }

  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new DemoError(400, "요청 형식이 올바르지 않아요."); }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new DemoError(400, "입력 내용을 확인해 주세요.");
  return parsed.data;
}

// 요청자 IP. Vercel이 덮어쓰는 헤더만 신뢰하므로 Vercel 밖(로컬)에서는 null이다. 제한 키로만 쓰고 저장하지 않는다(해시).
export function clientIp(request: NextRequest) {
  if (process.env.VERCEL !== "1") return null;
  const value = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0];
  return value?.trim().slice(0, 64) || null;
}

export function workspace(request: NextRequest, create = false) {
  const id = request.cookies.get(cookieName)?.value ?? "";
  if (store.hasWorkspace(id)) return { id, fresh: false };
  if (create) return { id: store.createWorkspace(), fresh: true };
  throw new DemoError(401, "작업공간이 만료됐어요. 새로고침해 주세요.");
}

export function respond<T>(request: NextRequest, data: T, scope?: ReturnType<typeof workspace>, status = 200) {
  const response = NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
  if (scope?.fresh) response.cookies.set(cookieName, scope.id, {
    httpOnly: true, sameSite: "strict", path: "/", maxAge: 3600, secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

export async function handle(request: NextRequest, operation: () => Promise<Response> | Response) {
  try {
    const host = request.headers.get("host") ?? "";
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
    const configured = process.env.APP_BASE_URL;
    if (!local && (process.env.SHOP_OPS_DEMO !== "1" || !configured)) {
      throw new DemoError(404, "데모를 사용할 수 없어요.");
    }
    const expectedOrigin = local ? "http://" + host : new URL(configured!).origin;
    const origin = request.headers.get("origin");
    if (request.method !== "GET" && origin && origin !== expectedOrigin) {
      throw new DemoError(403, "요청 출처를 확인할 수 없어요.");
    }
    return await operation();
  } catch (error) {
    return respond(request, { error: { message: error instanceof DemoError ? error.message : "요청을 처리하지 못했어요. 다시 시도해 주세요." } }, undefined, error instanceof DemoError ? error.status : 500);
  }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { DemoError } from "@/server/demo-core";
import { handle, readBody, respond } from "@/server/demo-http";
import { addDocument, getDocument, indexDocument, listDocuments, updateDocument } from "@/server/live-knowledge";
import { requireTenant, requireUser, serverClient, isSupabaseEnabled } from "@/server/supabase";

type Context = { params: Promise<{ path?: string[] }> };
const fields = z.object({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(10000), kind: z.enum(["faq", "markdown"]) });
const version = z.object({ expectedVersion: z.int().min(1) });
const createTenant = z.object({ name: z.string().trim().min(2).max(120), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,49}$/) }).strict();
const missing = () => new DemoError(404, "경로를 찾을 수 없어요.");
const parseId = (value?: string) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw missing();
  return parsed.data;
};
const offset = (request: NextRequest) => {
  const page = z.coerce.number().int().min(1).max(1000).safeParse(request.nextUrl.searchParams.get("page") ?? "1");
  if (!page.success) throw new DemoError(400, "페이지 값을 확인해 주세요.");
  return page.data;
};

async function route(request: NextRequest, context: Context) {
  return handle(request, async () => {
    if (!isSupabaseEnabled()) throw missing();
    const { path = [] } = await context.params;
    const [rawTenant, collection, rawId, action] = path;
    const method = request.method;
    if (!path.length) {
      const { client, userId } = await requireUser();
      if (method === "GET") {
        const { data, error } = await client.from("tenants").select("id,name,slug,public_widget_key").eq("is_active", true).order("name").limit(50);
        if (error) throw new DemoError(502, "쇼핑몰을 불러오지 못했어요.");
        return respond(request, { tenants: data });
      }
      if (method === "POST") {
        const { name, slug } = await readBody(request, createTenant);
        const { data, error } = await serverClient().rpc("create_tenant", { p_owner: userId, p_name: name, p_slug: slug });
        if (error?.code === "23505" || error?.message === "tenant_quota_exceeded") throw new DemoError(409, "쇼핑몰 주소 또는 생성 한도를 확인해 주세요.");
        if (error) throw new DemoError(502, "쇼핑몰을 생성하지 못했어요.");
        return respond(request, data, undefined, 201);
      }
      throw missing();
    }

    const tenantId = parseId(rawTenant);
    if (collection === "support-tickets" && method === "GET" && path.length === 2) {
      const { client, tenantId: authorized } = await requireTenant(tenantId);
      const page = offset(request);
      const { data, error } = await client.from("support_tickets").select("id,session_id,title,reason,status,order_reference,last_scan,created_at")
        .eq("tenant_id", authorized).order("created_at", { ascending: false }).order("id").range((page - 1) * 20, page * 20 - 1);
      if (error) throw new DemoError(502, "상담 문의를 불러오지 못했어요.");
      return respond(request, { tickets: data });
    }
    if (collection === "conversations" && method === "GET" && !action && path.length <= 3) {
      const { client, tenantId: authorized } = await requireTenant(tenantId);
      const page = offset(request);
      if (rawId) {
        const { data, error } = await client.from("chat_messages").select("id,role,content,abstained,created_at")
          .eq("tenant_id", authorized).eq("session_id", parseId(rawId)).order("created_at").order("id").range((page - 1) * 50, page * 50 - 1);
        if (error) throw new DemoError(502, "상담을 불러오지 못했어요.");
        return respond(request, { messages: data });
      }
      const { data, error } = await client.from("chat_sessions").select("id,created_at,expires_at")
        .eq("tenant_id", authorized).order("created_at", { ascending: false }).range((page - 1) * 20, page * 20 - 1);
      if (error) throw new DemoError(502, "상담 목록을 불러오지 못했어요.");
      return respond(request, { sessions: data });
    }

    if (collection !== "documents") throw missing();
    if (path.length === 2 && method === "GET") return respond(request, { documents: await listDocuments(tenantId, offset(request)) });
    if (path.length === 2 && method === "POST") return respond(request, await addDocument(tenantId, await readBody(request, fields.strict())), undefined, 201);
    const id = parseId(rawId);
    if (path.length === 3 && method === "GET") return respond(request, (await getDocument(tenantId, id)).data);
    if (path.length === 3 && method === "PATCH") {
      const { expectedVersion, ...change } = await readBody(request, fields.partial().extend(version.shape).strict().refine((body) => Boolean(body.title || body.content || body.kind)));
      return respond(request, await updateDocument(tenantId, id, expectedVersion, change));
    }
    if (path.length === 3 && method === "DELETE") {
      const { expectedVersion } = await readBody(request, version.strict());
      return respond(request, await updateDocument(tenantId, id, expectedVersion, null));
    }
    if (path.length === 4 && method === "POST" && action === "index") {
      const { expectedVersion } = await readBody(request, version.strict());
      return respond(request, await indexDocument(tenantId, id, expectedVersion));
    }
    throw missing();
  });
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const DELETE = route;

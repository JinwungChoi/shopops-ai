import "server-only";
import { DemoError } from "./demo-core";
import { embeddings } from "./embeddings";
import { requireTenant, serverClient } from "./supabase";

type Write = { title?: string; content?: string; kind?: "faq" | "markdown" };

export async function listDocuments(tenantId: string, page: number) {
  const { client, tenantId: authorized } = await requireTenant(tenantId);
  const { data, error } = await client.from("knowledge_documents")
    .select("id,title,kind,content,version,index_status,indexed_at")
    .eq("tenant_id", authorized).is("deleted_at", null)
    .order("created_at").order("id").range((page - 1) * 20, page * 20 - 1);
  if (error) throw new DemoError(502, "정책을 불러오지 못했어요.");
  return data;
}

export async function addDocument(tenantId: string, document: Required<Write>) {
  const { tenantId: authorized } = await requireTenant(tenantId);
  const { data, error } = await serverClient().from("knowledge_documents").insert({
    tenant_id: authorized, ...document,
  }).select("id,index_status").single();
  if (error) throw new DemoError(502, "정책을 저장하지 못했어요.");
  return data;
}

export async function getDocument(tenantId: string, id: string) {
  const { client, tenantId: authorized } = await requireTenant(tenantId);
  const { data, error } = await client.from("knowledge_documents").select("id,title,kind,content,version,index_status")
    .eq("tenant_id", authorized).eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw new DemoError(502, "정책을 불러오지 못했어요.");
  if (!data) throw new DemoError(404, "정책을 찾을 수 없어요.");
  return { authorized, data };
}

export async function updateDocument(tenantId: string, id: string, expectedVersion: number, patch: Write | null) {
  const { authorized, data } = await getDocument(tenantId, id);
  if (data.version !== expectedVersion) throw new DemoError(409, "정책이 변경됐어요. 새로고침해 주세요.");
  const now = new Date().toISOString();
  const change = patch === null ? { deleted_at: now } : patch;
  const result = await serverClient().from("knowledge_documents").update({
    ...change, version: expectedVersion + 1, active_version: null, index_status: "pending", error_code: null, updated_at: now,
  }).eq("tenant_id", authorized).eq("id", id).eq("version", expectedVersion).is("deleted_at", null)
    .select("id,version,index_status").maybeSingle();
  if (result.error) throw new DemoError(502, "정책을 변경하지 못했어요.");
  if (!result.data) throw new DemoError(409, "정책이 변경됐어요. 새로고침해 주세요.");
  return result.data;
}

export function splitDocument(content: string, kind: string) {
  const raw = Array.from(content.trim().replace(/\r\n/g, "\n"));
  const step = kind === "faq" && raw.length <= 1400 ? 1400 : 800;
  const chunks: string[] = [];
  for (let start = 0; start < raw.length;) {
    const end = Math.min(start + step, raw.length);
    chunks.push(raw.slice(start, end).join(""));
    if (end === raw.length) break;
    start = end - 100;
  }
  return chunks;
}

export async function indexDocument(tenantId: string, id: string, expectedVersion: number) {
  const { authorized, data } = await getDocument(tenantId, id);
  if (data.version !== expectedVersion) throw new DemoError(409, "정책이 변경됐어요. 새로고침해 주세요.");
  if (data.index_status === "ready") return { status: "ready" };

  const adapter = embeddings();
  const client = serverClient();
  const scope = { p_tenant_id: authorized, p_document_id: id, p_version: expectedVersion };
  const { data: attempt, error: claimError } = await client.rpc("claim_document_index", scope);
  if (claimError) throw new DemoError(502, "인덱싱을 시작하지 못했어요.");
  if (typeof attempt !== "string") {
    const latest = await getDocument(tenantId, id);
    if (latest.data.version === expectedVersion && latest.data.index_status === "ready") return { status: "ready" };
    throw new DemoError(409, "문서가 바뀌었거나 인덱싱이 이미 진행 중이에요.");
  }

  try {
    const chunks = splitDocument(data.content, data.kind);
    const vectors = await adapter.embed(chunks);
    if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== 1536 || !vector.every(Number.isFinite))) {
      throw new DemoError(502, "임베딩 결과를 검증하지 못했어요.");
    }
    const { data: published, error } = await client.rpc("publish_document_chunks", {
      ...scope, p_model: adapter.model,
      p_chunks: { attemptId: attempt, chunks: chunks.map((content, index) => ({ content, embedding: JSON.stringify(vectors[index]) })) },
    });
    if (error) throw new DemoError(502, "인덱싱에 실패했어요.");
    if (!published) throw new DemoError(409, "문서가 바뀌었어요. 새로고침해 주세요.");
    return { status: "ready" };
  } catch (error) {
    await client.rpc("fail_document_index", { ...scope, p_attempt_id: attempt });
    throw error instanceof DemoError ? error : new DemoError(502, "인덱싱에 실패했어요. 다시 시도해 주세요.");
  }
}

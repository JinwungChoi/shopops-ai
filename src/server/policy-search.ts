import "server-only";
import type { Source } from "@/lib/demo";
import { DemoError } from "./demo-core";
import type { serverClient } from "./supabase";

export async function searchPolicies(client: ReturnType<typeof serverClient>, tenantId: string, model: string, query: number[]) {
  if (query.length !== 1536 || !query.every(Number.isFinite)) {
    throw new DemoError(502, "검색용 임베딩을 확인하지 못했어요.");
  }

  const { data, error } = await client.rpc("search_tenant_chunks", {
    p_tenant_id: tenantId, p_query_embedding: JSON.stringify(query), p_match_count: 5, p_embedding_model: model,
  });
  if (error || !Array.isArray(data)) throw new DemoError(502, "정책 검색을 완료하지 못했어요.");

  const maxDistance = model === "shopops-demo-bigram-v1" ? 0.72 : 0.65;
  const candidates = data.map((item) => ({
    documentId: String(item.document_id),
    title: String(item.title),
    version: Number(item.document_version),
    excerpt: String(item.content),
    distance: typeof item.distance === "number" ? item.distance : Infinity,
  }));

  const qualified: Source[] = candidates.filter((item) => item.distance <= maxDistance)
    .map(({ documentId, title, version, excerpt }) => ({ documentId, title, version, excerpt }));
  const evidence = [...new Map(qualified.map((source) => [source.documentId, source])).values()];

  return { candidates, evidence };
}

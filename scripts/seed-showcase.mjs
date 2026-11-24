import { readFile } from "node:fs/promises";
import { OpenAIEmbeddings } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const shops = [
  { key: "style", name: "Style Shop", widget: "202dbac4609c4aaa9a7cd4ea0aa604a5" },
];
const model = "text-embedding-3-small";
const policy = z.object({
  id: z.string().min(1), title: z.string().min(1).max(200),
  question: z.string().min(1).max(400), answer: z.string().min(1).max(950),
});

async function seed() {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !secret) {
    throw Error("격리된 로컬 Supabase 설정이 필요합니다.");
  }
  const client = createClient(url.origin, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const fixtures = z.object({ style: z.array(policy) }).parse(
    JSON.parse(await readFile(new URL("../demo/showcase-policies.json", import.meta.url), "utf8")),
  );

  const plan = [];
  for (const shop of shops) {
    const tenant = await client.from("tenants").select("id,name,slug")
      .eq("public_widget_key", shop.widget).eq("is_active", true).maybeSingle();
    if (tenant.error || tenant.data?.name !== shop.name || !tenant.data?.slug.startsWith("live-" + shop.key + "-")) {
      throw Error(shop.name + "의 로컬 시연 업체를 확인하지 못했습니다.");
    }
    const current = await client.from("knowledge_documents").select("id,title,content,version,index_status")
      .eq("tenant_id", tenant.data.id).is("deleted_at", null);
    if (current.error) throw Error(shop.name + "의 정책 목록 조회에 실패했습니다.");
    const pending = [];
    const names = new Set();
    for (const document of fixtures[shop.key]) {
      if (names.has(document.title)) throw Error("시연 정책 제목이 중복됐습니다.");
      names.add(document.title);
      const matched = current.data.filter((row) => row.title === document.title);
      if (matched.length > 1) throw Error(document.title + " 이름의 정책이 중복됐습니다.");
      const previous = matched[0];
      const content = "Q: " + document.question + "\nA: " + document.answer;
      if (previous?.content === content && previous.index_status === "ready") continue;
      pending.push({ title: document.title, content, previous });
    }
    plan.push({ shop, tenantId: tenant.data.id, pending });
  }

  const work = plan.flatMap(({ tenantId, pending }) => pending.map((item) => ({ tenantId, ...item })));
  if (work.length) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw Error("시연 정책 인덱싱용 OpenAI 키 설정이 필요합니다.");
    const adapter = new OpenAIEmbeddings({ apiKey, model, dimensions: 1536, timeout: 18_000, maxRetries: 0 });
    const vectors = await adapter.embedDocuments(work.map((item) => item.content));
    if (vectors.length !== work.length || vectors.some((entry) => entry.length !== 1536 || !entry.every(Number.isFinite))) {
      throw Error("임베딩 결과의 형식이 올바르지 않습니다.");
    }
    for (const [index, item] of work.entries()) {
      let id = item.previous?.id;
      let version = item.previous?.version ?? 1;
      if (!id) {
        const inserted = await client.from("knowledge_documents").insert({
          tenant_id: item.tenantId, title: item.title, content: item.content, kind: "faq",
        }).select("id").single();
        if (inserted.error) throw Error(item.title + " 등록에 실패했습니다.");
        id = inserted.data.id;
      } else if (item.previous.content !== item.content) {
        const updated = await client.from("knowledge_documents").update({
          content: item.content, version: version + 1, active_version: null, index_status: "pending", error_code: null, updated_at: new Date().toISOString(),
        }).eq("tenant_id", item.tenantId).eq("id", id).eq("version", version)
          .is("deleted_at", null).select("id").maybeSingle();
        if (updated.error || !updated.data) throw Error(item.title + " 버전 변경에 실패했습니다.");
        version++;
      }
      const scope = { p_tenant_id: item.tenantId, p_document_id: id, p_version: version };
      const claim = await client.rpc("claim_document_index", scope);
      if (claim.error || typeof claim.data !== "string") throw Error(item.title + " 인덱싱 작업을 시작하지 못했습니다.");
      const publish = await client.rpc("publish_document_chunks", {
        ...scope, p_model: model,
        p_chunks: { attemptId: claim.data, chunks: [{ content: item.content, embedding: JSON.stringify(vectors[index]) }] },
      });
      if (publish.error || !publish.data) {
        await client.rpc("fail_document_index", { ...scope, p_attempt_id: claim.data });
        throw Error(item.title + " 인덱싱을 완료하지 못했습니다.");
      }
    }
  }

  for (const { shop, pending } of plan) {
    console.log(shop.name + " · 정책 " + fixtures[shop.key].length + "개 · 이번 갱신 " + pending.length + "개");
  }
}

seed().catch((error) => {
  const message = error instanceof Error && error.name === "Error" ? error.message : "로컬 시연 정책 시드에 실패했습니다.";
  console.error(message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 200));
  process.exitCode = 1;
});

import "server-only";
import { OpenAIEmbeddings } from "@langchain/openai";
import { DemoError } from "./demo-core";

function fingerprint(text: string) {
  const features = new Array<number>(1536).fill(0);
  const clean = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (let index = 0; index < clean.length - 1; index++) {
    const position = (clean.charCodeAt(index) * 31 + clean.charCodeAt(index + 1)) % features.length;
    features[position] += 1;
  }
  if (!features.some(Boolean)) features[0] = 1;
  return features;
}

export function embeddings() {
  if (process.env.SHOP_OPS_FAKE_EMBEDDINGS === "1") return {
    model: "shopops-demo-bigram-v1",
    embed: async (texts: string[]) => texts.map(fingerprint),
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new DemoError(503, "임베딩 API를 설정해 주세요.");
  const model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const adapter = new OpenAIEmbeddings({ apiKey, model, dimensions: 1536, timeout: 12_000, maxRetries: 0 });
  return { model, embed: (texts: string[]) => adapter.embedDocuments(texts) };
}

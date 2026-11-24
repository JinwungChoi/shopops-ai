import type { ReportProgress } from "@/lib/chat-progress";
import { catalogAnswer, catalogQuery, type CatalogFilters } from "./catalog";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Answer, Category, Document, ShopId, Source } from "@/lib/demo";

const fallback = "등록된 정책에서 답변 근거를 찾지 못했어요. 쇼핑몰 담당자 확인이 필요합니다.";
const topics: [Category, RegExp][] = [
  ["returns", /반품|환불|return|refund/iu],
  ["exchange", /교환|exchange/iu],
  ["shipping", /배송|택배|발송|shipping|delivery/iu],
  ["support", /고객센터|연락처|상담 시간|고객지원|support/iu],
];
const unsupported = /쿠폰|할인|재고|세탁|수선|결제 수단|배송 조회|어디쯤|주문 상태|업체 코드/u;

export function seedDocuments(shop: ShopId): Document[] {
  const style = shop === "demo-style-shop";
  return [
    { id: shop + "-returns", title: "반품 및 환불 정책", category: "returns", content: style
      ? "상품 수령 후 7일 이내에 반품을 신청할 수 있습니다. 미사용 상품이어야 하며 상품 태그가 부착되어 있어야 합니다."
      : "상품 수령 후 14일 이내에 반품을 신청할 수 있습니다. 미사용 상태로 구성품과 원래 포장이 모두 필요합니다." },
    { id: shop + "-shipping", title: "배송 소요 기간", category: "shipping", content: style
      ? "결제 확인 후 영업일 기준 2~3일 이내에 출고합니다. 도서산간 지역은 배송에 시간이 더 걸릴 수 있습니다."
      : "영업일 오후 2시 이전 결제 건은 당일 출고합니다. 이후 주문은 다음 영업일에 출고합니다." },
    { id: shop + "-exchange", title: "상품 교환 안내", category: "exchange", content: style
      ? "교환은 수령 후 7일 이내에 고객센터로 신청해 주세요. 사이즈 교환은 재고가 있는 경우에 가능합니다."
      : "상품 이상이 있는 경우 상품과 구성품 사진을 준비해 고객센터로 문의해 주세요." },
    { id: shop + "-support", title: "고객센터 운영 시간", category: "support", content: style
      ? "고객센터는 평일 오전 10시부터 오후 5시까지 운영합니다."
      : "고객센터는 평일 오전 9시부터 오후 6시까지 운영합니다." },
  ].map((document) => ({ ...document, category: document.category as Category, version: 1, status: "ready" }));
}

export function retrieve(documents: Document[], question: string): Source[] {
  const matches = topics.filter(([, expression]) => expression.test(question));
  if (matches.length !== 1 || unsupported.test(question)) return [];
  const active = documents.filter((doc) => doc.status === "ready" && doc.category === matches[0][0]);
  if (active.length !== 1) return [];
  return active.map((doc) => ({ documentId: doc.id, title: doc.title, version: doc.version, excerpt: doc.content }));
}

export function finalizeAnswer(text: string, sourceIds: string[], evidence: Source[]): Answer {
  const selected = evidence.filter((source) => sourceIds.includes(source.documentId));
  if (!text.trim() || !selected.length || sourceIds.some((id) => !selected.some((source) => source.documentId === id))) {
    return { answer: fallback, sources: [], abstained: true };
  }
  return { answer: text, sources: selected, abstained: false };
}

export function explain(question: string, evidence: Source[]): Answer {
  const source = evidence[0];
  if (!source) return finalizeAnswer("", [], evidence);
  const number = question.match(/(\d+)\s*일/u)?.[1] ?? (/열흘/u.test(question) ? "10" : undefined);
  const period = source.excerpt.match(/(\d+)\s*일\s*이내/u)?.[1];
  const isReturns = /반품|환불|return|refund/iu.test(source.title) && /반품|환불|return|refund/iu.test(question);
  let answer = source.excerpt;
  if (isReturns && number && period) {
    const assessment = Number(number) > Number(period)
      ? "일반 반품 신청 기간이 지났어요."
      : "기간 기준으로는 반품을 신청할 수 있어요.";
    answer = assessment + " " + source.excerpt;
  }
  return finalizeAnswer(answer, [source.documentId], evidence);
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const createToken = () => randomBytes(32).toString("base64url");
type Session = { id: string; shop: ShopId; workspaceId: string; digest: string; expiresAt: number; catalogFilters?: CatalogFilters; entries: Map<string, { question: string; result: Promise<Answer> }> };

export class DemoStore {
  private readonly sessions = new Map<string, Session>();
  private readonly workspaces = new Map<string, { docs: Map<ShopId, Document[]>; expiresAt: number }>();

  constructor(private readonly now = Date.now) {}

  createWorkspace() {
    for (const [id, workspace] of this.workspaces) {
      if (workspace.expiresAt <= this.now()) this.workspaces.delete(id);
    }
    if (this.workspaces.size >= 128) throw new DemoError(429, "체험 작업공간이 가득 찼어요. 잠시 뒤 다시 시도해 주세요.");
    const id = createToken();
    this.workspaces.set(id, { docs: new Map(), expiresAt: this.now() + 3600_000 });
    return id;
  }

  hasWorkspace(id: string) {
    return (this.workspaces.get(id)?.expiresAt ?? 0) > this.now();
  }

  documents(workspaceId: string, shop: ShopId) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !this.hasWorkspace(workspaceId)) throw new DemoError(401, "작업공간이 만료됐어요.");
    let docs = workspace.docs.get(shop);
    if (!docs) {
      docs = seedDocuments(shop);
      workspace.docs.set(shop, docs);
    }
    return docs;
  }

  update(workspaceId: string, shop: ShopId, id: string, version: number, content: string) {
    const document = this.getDocument(workspaceId, shop, id, version);
    Object.assign(document, { content, version: version + 1, status: "pending" });
    return document;
  }

  index(workspaceId: string, shop: ShopId, id: string, version: number) {
    const document = this.getDocument(workspaceId, shop, id, version);
    document.status = "ready";
    return document;
  }

  private getDocument(workspaceId: string, shop: ShopId, id: string, version: number) {
    const document = this.documents(workspaceId, shop).find((item) => item.id === id);
    if (!document) throw new DemoError(404, "이 작업공간에서 문서를 찾을 수 없어요.");
    if (document.version !== version) throw new DemoError(409, "문서가 바뀌었어요. 목록을 새로고침해 주세요.");
    return document;
  }

  session(workspaceId: string, shop: ShopId) {
    const now = this.now();
    for (const [id, stored] of this.sessions) if (stored.expiresAt <= now) this.sessions.delete(id);
    const activeCount = [...this.sessions.values()].filter((entry) => entry.workspaceId === workspaceId).length;
    if (activeCount >= 24 || this.sessions.size >= 512) throw new DemoError(429, "새 대화를 너무 자주 시작했어요.");
    const token = createToken();
    const id = randomUUID();
    this.sessions.set(id, { id, workspaceId, shop, digest: hashToken(token), expiresAt: now + 1800_000, entries: new Map() });
    return { sessionId: id, sessionToken: token, expiresAt: new Date(now + 1800_000).toISOString() };
  }

  answer(workspaceId: string, sessionId: string, token: string, requestId: string, question: string, generate: typeof explain | ((question: string, evidence: Source[]) => Promise<Answer>) = explain, report?: ReportProgress) {
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId || session.digest !== hashToken(token) || session.expiresAt <= this.now()) {
      throw new DemoError(401, "대화가 만료됐어요. 새 대화를 시작해 주세요.");
    }
    const previous = session.entries.get(requestId);
    if (previous) {
      if (previous.question !== question) throw new DemoError(409, "요청 내용이 이전과 달라요.");
      return previous.result;
    }
    if (session.entries.size >= 24) throw new DemoError(429, "이 대화의 메시지 한도에 도달했어요.");
    const filters = session.shop === "demo-style-shop" ? catalogQuery(question, session.catalogFilters) : undefined;
    if (filters) session.catalogFilters = filters;
    report?.(filters ? "search_products" : "search_policies");
    const evidence = filters ? [] : retrieve(this.documents(workspaceId, session.shop), question);
    const result = Promise.resolve().then(() => filters ? catalogAnswer(filters) : generate(question, evidence)).catch((error: unknown) => {
      session.entries.delete(requestId);
      throw error;
    });
    session.entries.set(requestId, { question, result });
    return result;
  }
}

export class DemoError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

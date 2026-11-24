import { describe, expect, it, vi } from "vitest";
import { DemoStore, explain, finalizeAnswer, retrieve, seedDocuments } from "@/server/demo-core";
import { randomUUID } from "node:crypto";

const a = "demo-style-shop";
const b = "demo-gadget-shop";
const question = "받은 지 열흘 됐는데 반품할 수 있나요?";

describe("고객지원 데모", () => {
  it("같은 질문에도 업체별 답변과 출처가 분리된다", async () => {
    const store = new DemoStore();
    const workspace = store.createWorkspace();
    const shopA = store.session(workspace, a);
    const shopB = store.session(workspace, b);
    const answerA = await store.answer(workspace, shopA.sessionId, shopA.sessionToken, randomUUID(), question);
    const answerB = await store.answer(workspace, shopB.sessionId, shopB.sessionToken, randomUUID(), question);
    expect(answerA.answer).toContain("기간이 지났어요");
    expect(answerB.answer).toContain("신청할 수 있어요");
    expect(answerA.sources.map((source) => source.documentId)).toEqual([a + "-returns"]);
    expect(answerB.sources.map((source) => source.documentId)).toEqual([b + "-returns"]);
    expect(() => store.answer(workspace, shopB.sessionId, shopA.sessionToken, randomUUID(), question)).toThrow();
  });

  it("변경 즉시 이전 버전을 제외하고 다시 인덱싱한 버전만 사용한다", async () => {
    const store = new DemoStore();
    const workspace = store.createWorkspace();
    const other = store.createWorkspace();
    const session = store.session(workspace, a);
    const ask = () => store.answer(workspace, session.sessionId, session.sessionToken, randomUUID(), question);
    expect(() => store.index(workspace, a, b + "-returns", 1)).toThrow();
    store.update(workspace, a, a + "-returns", 1, "상품 수령 후 21일 이내에 반품을 신청할 수 있습니다.");
    expect(await ask()).toMatchObject({ abstained: true, sources: [] });
    store.index(workspace, a, a + "-returns", 2);
    expect(await ask()).toMatchObject({ sources: [{ version: 2, excerpt: expect.stringContaining("21일") }] });
    expect(store.documents(other, a)[0].version).toBe(1);
  });

  it("근거 없는 질문과 다른 업체의 인용은 보류한다", () => {
    expect(explain("할인 쿠폰 있나요?", retrieve(seedDocuments(a), "할인 쿠폰 있나요?"))).toMatchObject({ abstained: true });
    const evidence = retrieve(seedDocuments(a), question);
    expect(finalizeAnswer("임의 답변", [a + "-returns", b + "-returns"], evidence)).toMatchObject({ abstained: true, sources: [] });
  });

  it("동일 요청에는 답변을 한 번만 생성하고 만료된 세션은 거부한다", async () => {
    let now = 0;
    const store = new DemoStore(() => now);
    const workspace = store.createWorkspace();
    const session = store.session(workspace, a);
    const id = randomUUID();
    const generate = vi.fn(explain);
    const ask = () => store.answer(workspace, session.sessionId, session.sessionToken, id, question, generate);
    await Promise.all([ask(), ask()]);
    expect(generate).toHaveBeenCalledOnce();
    now = 1800_000;
    expect(ask).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { fakeActionIntent, followUpIntent, isReturnableOrderListQuestion, reportedMissingDelivery, type AgentState } from "../../src/server/agent-intent";

const prior: AgentState = { intent: "return", reference: "STY-1002", reason: null, waiting: "reason" };

describe("반품 에이전트 의도", () => {
  it("주문별 조회, 일반 반품 정책, 접수 요청을 구분한다", () => {
    expect(isReturnableOrderListQuestion("지금 반품가능한게 어떤거야?")).toBe(true);
    expect(isReturnableOrderListQuestion("내 주문 중에 반품 가능한 상품 보여줘")).toBe(true);
    expect(isReturnableOrderListQuestion("반품 가능한 조건이 뭐야?")).toBe(false);
    expect(isReturnableOrderListQuestion("반품 가능하면 접수해줘")).toBe(false);
  });

  it("배송 완료 후 미수령 신고를 택배 조회로 처리하지 않는다", () => {
    expect(reportedMissingDelivery("STY-1002 배송 완료라는데 못 받았어")).toMatchObject({ intent: "support", reason: "missing_delivery" });
    expect(reportedMissingDelivery("STY-1002 배송 완료됐어?")).toBeUndefined();
  });
  it("진행 중인 반품의 사유를 이어서 받고 정책 질문은 별도로 보낸다", () => {
    expect(followUpIntent("단순 변심", prior)).toMatchObject({ intent: "return", reason: "change_of_mind" });
    expect(followUpIntent("단순 변심 반품비가 얼마예요?", prior)).toBeUndefined();
    expect(fakeActionIntent("단순 변심 반품비가 얼마예요?")).toBeUndefined();
  });

  it("주문 선택 후 이전 이관 사유를 유지한다", () => {
    expect(followUpIntent("STY-1002", { intent: "support", reference: null, reason: "missing_delivery", waiting: "order" }))
      .toMatchObject({ intent: "support", reason: "missing_delivery" });
  });

  it("일반 채팅의 긍정 문구를 접수 승인에 사용하지 않는다", () => {
    expect(followUpIntent("그대로 접수 확인", { ...prior, waiting: "approval" })).toBeUndefined();
    expect(fakeActionIntent("접수 확인")).toBeUndefined();
  });
});

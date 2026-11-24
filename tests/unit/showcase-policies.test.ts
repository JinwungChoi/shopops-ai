import { describe, expect, it } from "vitest";
import fixtures from "../../demo/showcase-policies.json";

describe("쇼핑몰 시연용 정책", () => {
  it("공개 쇼핑몰의 정책은 고유 제목과 복사할 질문을 갖고 한 청크로 인덱싱된다", () => {
    for (const policies of Object.values(fixtures)) {
      expect(policies).toHaveLength(23);
      expect(new Set(policies.map((policy) => policy.id)).size).toBe(policies.length);
      expect(new Set(policies.map((policy) => policy.title)).size).toBe(policies.length);
      for (const policy of policies) {
        expect(policy.question.trim().length).toBeGreaterThan(0);
        expect(policy.answer.trim().length).toBeGreaterThan(0);
        expect(Array.from("Q: " + policy.question + "\nA: " + policy.answer).length).toBeLessThanOrEqual(1400);
      }
    }
  });

  it("Style Shop 시연 질문에 반품·무료배송 정책을 연결한다", () => {
    const lookup = (shop: keyof typeof fixtures, id: string) => fixtures[shop].find((policy) => policy.id === id);
    expect(lookup("style", "return")?.answer).toContain("7일 이내");
    expect(lookup("style", "delivery-fee")?.answer).toContain("5만 원");
  });
});

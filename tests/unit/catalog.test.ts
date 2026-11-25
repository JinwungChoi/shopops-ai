import { describe, expect, it } from "vitest";
import { catalogAnswer, catalogQuery, searchCatalog } from "@/server/catalog";

describe("Style Shop 카탈로그 조회", () => {
  it("가격과 색상 조건으로 검색하고 원화 상한을 반영한다", () => {
    const filters = catalogQuery("7만 원 이하 검정 신상 재킷 보여줘")!;
    expect(searchCatalog(filters).products.map((product) => product.id)).toEqual(["black-twill-jacket"]);
    expect(searchCatalog(catalogQuery("6만 원 미만 신상 재킷 보여줘")!).products).toEqual([]);
  });

  it("후속 사이즈 조건은 앞선 카테고리를 보존하고 품절 옵션을 제외한다", () => {
    const initial = catalogQuery("신상 재킷 보여줘")!;
    expect(searchCatalog(initial).products).toHaveLength(2);
    const refined = catalogQuery("M 사이즈만", initial)!;
    expect(searchCatalog(refined).products).toMatchObject([{ id: "black-twill-jacket", options: [{ size: "M", available: true }] }]);
    expect(catalogQuery("받고 나서 반품은 며칠까지 돼?", refined)).toBeUndefined();
  });

  it("다른 쇼핑몰·지원하지 않는 카테고리에는 Style Shop 상품을 보여주지 않는다", () => {
    expect(catalogQuery("다른 쇼핑몰 신상 재킷 보여줘")).toBeUndefined();
    expect(searchCatalog(catalogQuery("신상 패딩 보여줘")!).products).toEqual([]);
  });

  it("결과가 없을 때 판매하지 않는 품목과 사이즈 품절을 구분해 안내한다", () => {
    expect(catalogAnswer({ category: "jacket", color: "black", size: "L" }).answer).toBe("블랙 트윌 재킷의 L 사이즈는 지금 품절이에요.");
    expect(catalogAnswer({ category: "other" }).answer).toContain("판매 목록에 없어요");
    expect(catalogAnswer({ category: "jacket", size: "M" }).answer).toBe("블랙 트윌 재킷의 M 사이즈는 재고가 있어요.");
    expect(catalogAnswer({ category: "jacket", newOnly: true, maxPrice: 59999 }).answer).toBe("조건에 맞는 상품이 없어요. 가격이나 사이즈 조건을 바꿔보세요.");
  });
});

describe("상품명 검색", () => {
  it("상품명이 맞으면 모델이 잘못 고른 분류를 무시하고 그 상품을 찾는다", () => {
    const result = searchCatalog({ nameQuery: "아이보리 옥스퍼드", category: "trousers", size: "M" });
    expect(result.products.map((product) => product.name)).toEqual(["아이보리 옥스퍼드 셔츠"]);
  });

  it("상품명이 맞지 않으면 기존 분류 조건을 그대로 적용한다", () => {
    const result = searchCatalog({ nameQuery: "없는 상품", category: "trousers" });
    expect(result.products.map((product) => product.name)).toEqual(["차콜 플리츠 팬츠"]);
  });
});

import { describe, expect, it } from "vitest";
import { catalogQuery, searchCatalog } from "@/server/catalog";

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
});

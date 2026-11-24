import { z } from "zod";
import type { CatalogResult, ProductCard } from "@/lib/demo";

export const styleCatalogWidget = "202dbac4609c4aaa9a7cd4ea0aa604a5";
const filtersSchema = z.object({
  category: z.enum(["jacket", "shirt", "trousers", "other"]).optional(),
  color: z.enum(["black", "stone", "ivory", "charcoal"]).optional(),
  size: z.enum(["S", "M", "L", "XL"]).optional(),
  minPrice: z.number().int().nonnegative().optional(),
  maxPrice: z.number().int().nonnegative().optional(),
  newOnly: z.boolean().optional(),
});
export type CatalogFilters = z.infer<typeof filtersSchema>;
const entries = [
  { id: "black-twill-jacket", name: "블랙 트윌 재킷", category: "jacket", color: "black", colorLabel: "블랙", price: 69000, releasedAt: "2026-11-23", isNew: true, options: [{ size: "S", stock: 4 }, { size: "M", stock: 7 }, { size: "L", stock: 0 }] },
  { id: "stone-collar-jacket", name: "스톤 칼라 재킷", category: "jacket", color: "stone", colorLabel: "스톤 베이지", price: 79000, releasedAt: "2026-11-22", isNew: true, options: [{ size: "S", stock: 2 }, { size: "M", stock: 0 }, { size: "L", stock: 5 }] },
  { id: "ivory-oxford-shirt", name: "아이보리 옥스퍼드 셔츠", category: "shirt", color: "ivory", colorLabel: "아이보리", price: 49000, releasedAt: "2026-11-21", isNew: true, options: [{ size: "S", stock: 5 }, { size: "M", stock: 4 }, { size: "L", stock: 3 }] },
  { id: "charcoal-pleated-trousers", name: "차콜 플리츠 팬츠", category: "trousers", color: "charcoal", colorLabel: "차콜", price: 59000, releasedAt: "2026-11-05", isNew: false, options: [{ size: "S", stock: 0 }, { size: "M", stock: 3 }, { size: "L", stock: 4 }] },
] as const;

export function readCatalogFilters(input: unknown): CatalogFilters | undefined {
  const result = filtersSchema.safeParse(input);
  return result.success ? result.data : undefined;
}

const policyQuestion = /반품|교환|환불|취소|배송|출고|고객센터|세탁|관리\s*방법|재입고|영수증|결제\s*수단|return|refund|shipping/iu;
const otherShop = /(?:다른|타)\s*(?:쇼핑몰|상점|스토어)|gadget\s*shop/iu;

export function catalogQuery(question: string, prior?: CatalogFilters): CatalogFilters | undefined {
  if (policyQuestion.test(question) || otherShop.test(question)) return undefined;

  const category = /재킷|자켓|점퍼|jacket/iu.test(question) ? "jacket"
    : /셔츠|shirt/iu.test(question) ? "shirt"
      : /팬츠|바지|슬랙스|trouser|pants/iu.test(question) ? "trousers"
        : /코트|패딩|스커트|원피스|신발|가방|모자|earbud|이어폰/iu.test(question) ? "other" : undefined;
  const color = /검[정은]|블랙|black/iu.test(question) ? "black"
    : /베이지|스톤|beige|stone/iu.test(question) ? "stone"
      : /아이보리|크림|화이트|ivory|white/iu.test(question) ? "ivory"
        : /차콜|짙은\s*회색|charcoal/iu.test(question) ? "charcoal" : undefined;
  const normalized = question.toUpperCase();
  const size = normalized.match(/(?:^|[^A-Z])(XL|S|M|L)(?=$|[\s만,?.!]|사이즈|재고)/u)?.[1];
  const budget = question.match(/(\d[\d,]*(?:\.\d+)?)\s*(만|천)?\s*원?\s*(이하|이내|미만|아래|이상|초과)/u);
  const amount = budget ? Math.round(Number(budget[1].replaceAll(",", "")) * (budget[2] === "만" ? 10000 : budget[2] === "천" ? 1000 : 1)) : undefined;
  const latest = /신상|신규\s*상품|새로\s*(?:나온|출시)|이번\s*주\s*출시|new arrivals/iu.test(question);
  const browse = latest || /상품\s*(?:목록|리스트|추천)|카탈로그/u.test(question);
  const refinement = Boolean(prior && (size || color || budget || (category && /만|다시/u.test(question))));
  const lookup = Boolean(category && /보여|추천|찾아|사이즈|재고|옵션|얼마|있어|가격/u.test(question));
  if (!browse && !lookup && !refinement) return undefined;

  return readCatalogFilters({
    ...(refinement && !browse ? prior : {}),
    ...(category && { category }),
    ...(color && { color }),
    ...(size && { size }),
    ...(latest && { newOnly: true }),
    ...(amount !== undefined && budget && (
      budget[3] === "이상" || budget[3] === "초과"
        ? { minPrice: amount + (budget[3] === "초과" ? 1 : 0) }
        : { maxPrice: Math.max(0, amount - (budget[3] === "미만" || budget[3] === "아래" ? 1 : 0)) }
    )),
  });
}

export function searchCatalog(filters: CatalogFilters): CatalogResult {
  const products: ProductCard[] = entries
    .filter((item) =>
      (!filters.category || item.category === filters.category) &&
      (!filters.color || item.color === filters.color) &&
      (!filters.newOnly || item.isNew) &&
      (filters.minPrice === undefined || item.price >= filters.minPrice) &&
      (filters.maxPrice === undefined || item.price <= filters.maxPrice) &&
      (!filters.size || item.options.some((option) => option.size === filters.size && option.stock > 0)),
    )
    .map((item) => ({
      id: item.id, name: item.name, color: item.colorLabel, price: item.price,
      image: "/demo-products/" + item.id + ".png", releasedAt: item.releasedAt,
      options: item.options.filter((option) => !filters.size || option.size === filters.size)
        .map(({ size, stock }) => ({ size, available: stock > 0 })),
    }));

  return { products };
}

export function catalogAnswer(filters: CatalogFilters) {
  const catalog = searchCatalog(filters);
  return {
    answer: catalog.products.length ? "조건에 맞는 상품 " + catalog.products.length + "개를 찾았어요." : "조건에 맞는 상품이 없어요. 가격이나 사이즈 조건을 바꿔보세요.",
    sources: [],
    abstained: false,
    catalog,
  };
}

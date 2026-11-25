import "server-only";
import { z } from "zod";
import type { Answer, CartResult, ProductDetail } from "@/lib/demo";
import { colorLabels, catalogColors, type CatalogEntry } from "./catalog";
import { DemoError } from "./demo-core";
import { serverClient } from "./supabase";

// Style Shop 상품·장바구니·모의 주문 어댑터. 가격·재고·소유권 판정은 DB 함수가 하고 여기서는 결과 형식만 검증한다.
type Scope = { tenantId: string; sessionId: string; customerId?: string };

const productRow = z.object({
  id: z.string(), name: z.string(), category: z.string(), color: z.string(), price: z.int(), released_at: z.string(),
  is_new: z.boolean(), material: z.string(), fit: z.string(), care: z.string(), image: z.string().nullable(),
  mock_product_options: z.array(z.object({ size: z.string(), stock: z.int() })),
});
const sizeOrder = ["S", "M", "L", "XL", "FREE"];
const sortOptions = <T extends { size: string }>(options: T[]) =>
  [...options].sort((a, b) => sizeOrder.indexOf(a.size) - sizeOrder.indexOf(b.size));

async function productRows(tenantId: string) {
  const { data, error } = await serverClient().from("mock_products")
    .select("id,name,category,color,price,released_at,is_new,material,fit,care,image,mock_product_options(size,stock)")
    .eq("tenant_id", tenantId).eq("is_active", true).order("released_at", { ascending: false }).order("id").limit(200);
  if (error) throw new DemoError(502, "상품 목록을 확인하지 못했어요.");
  return z.array(productRow).parse(data);
}

export async function loadCatalog(tenantId: string): Promise<CatalogEntry[]> {
  return (await productRows(tenantId)).map((row) => ({
    id: row.id, name: row.name, category: row.category, color: row.color,
    colorLabel: colorLabels[row.color as (typeof catalogColors)[number]] ?? row.color, price: row.price,
    releasedAt: row.released_at, isNew: row.is_new, image: row.image, options: sortOptions(row.mock_product_options),
  }));
}

export async function productDetail(tenantId: string, productId: string | null, hint: string | null): Promise<Answer> {
  const rows = await productRows(tenantId);
  const needle = hint?.replaceAll(" ", "");
  const matches = productId ? rows.filter((row) => row.id === productId)
    : needle ? rows.filter((row) => row.name.replaceAll(" ", "").includes(needle)) : [];
  if (matches.length !== 1) {
    return { answer: matches.length ? "어떤 상품인지 이름을 조금 더 정확히 알려주세요." : "해당 상품을 찾지 못했어요. 상품명을 확인해 주세요.",
      sources: [], abstained: true, toolUsed: "get_product" };
  }
  const row = matches[0];
  const options = sortOptions(row.mock_product_options);
  const product: ProductDetail = { id: row.id, name: row.name, price: row.price, material: row.material, fit: row.fit,
    care: row.care, image: row.image, options };
  const available = options.filter((option) => option.stock > 0).map((option) => option.size);
  return {
    answer: `${row.name}은 ${row.material}, ${row.fit}이에요. 관리: ${row.care}. ` +
      (available.length ? `지금 주문 가능한 사이즈는 ${available.join(", ")}이에요.` : "지금은 모든 사이즈가 품절이에요."),
    sources: [], abstained: false, toolUsed: "get_product", product,
  };
}

const cartSchema = z.object({
  lines: z.array(z.object({ productId: z.string(), name: z.string(), size: z.string(), quantity: z.int(),
    unitPrice: z.int(), lineTotal: z.int() })),
  subtotal: z.int(), shippingFee: z.int(), total: z.int(),
});

function cartAnswer(cart: CartResult, lead: string): Answer {
  const summary = cart.lines.length
    ? `장바구니에 ${cart.lines.length}개 상품, 합계 ${cart.total.toLocaleString("ko-KR")}원이에요.`
      + (cart.shippingFee ? ` 배송비 ${cart.shippingFee.toLocaleString("ko-KR")}원이 포함됐어요.` : " 무료배송이에요.")
    : "장바구니가 비어 있어요.";
  return { answer: [lead, summary].filter(Boolean).join(" "), sources: [], abstained: false, cart };
}

function loginRequired(toolUsed: Answer["toolUsed"]): Answer {
  return { answer: "장바구니와 주문은 데모 고객으로 로그인한 뒤 이용할 수 있어요.", sources: [], abstained: true, toolUsed };
}

export async function viewCart({ tenantId, customerId }: Scope): Promise<Answer> {
  if (!customerId) return loginRequired("view_cart");
  const { data, error } = await serverClient().rpc("mock_cart_view", { p_tenant: tenantId, p_customer: customerId });
  if (error) throw new DemoError(502, "장바구니를 확인하지 못했어요.");
  return { ...cartAnswer(cartSchema.parse(data), ""), toolUsed: "view_cart" };
}

const cartUpdate = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["ok", "duplicate"]), cart: cartSchema }),
  z.object({ status: z.literal("not_found"), sizes: z.array(z.string()) }),
  z.object({ status: z.literal("out_of_stock"), stock: z.int() }),
  z.object({ status: z.literal("limit"), quantity: z.int() }),
  z.object({ status: z.enum(["missing", "invalid"]) }),
]);

export async function updateCart(scope: Scope, request: string, productId: string, size: string, quantity: number,
  mode: "add" | "set", productName: string): Promise<Answer> {
  if (!scope.customerId) return loginRequired("update_cart");
  const { data, error } = await serverClient().rpc("update_mock_cart", {
    p_tenant: scope.tenantId, p_session: scope.sessionId, p_customer: scope.customerId, p_request: request,
    p_product: productId, p_size: size, p_quantity: quantity, p_mode: mode,
  });
  if (error) throw new DemoError(502, "장바구니를 바꾸지 못했어요.");
  const result = cartUpdate.parse(data);
  const fail = (answer: string): Answer => ({ answer, sources: [], abstained: true, toolUsed: "update_cart" });
  switch (result.status) {
    case "ok":
    case "duplicate":
      return { ...cartAnswer(result.cart, mode === "set" && quantity === 0 ? `${productName} ${size}을 장바구니에서 뺐어요.`
        : mode === "set" ? `${productName} ${size} 수량을 ${quantity}개로 바꿨어요.` : `${productName} ${size} ${quantity}개를 장바구니에 담았어요.`),
      toolUsed: "update_cart" };
    case "not_found":
      return fail(result.sizes.length ? `${productName}은 ${result.sizes.join(", ")} 사이즈만 있어요.` : "해당 상품을 찾지 못했어요.");
    case "out_of_stock":
      return fail(result.stock ? `${productName} ${size}은 ${result.stock}개까지 주문할 수 있어요.` : `${productName} ${size}은 지금 품절이에요.`);
    case "limit":
      return fail("같은 상품은 한 번에 10개까지 담을 수 있어요.");
    default:
      return fail("장바구니를 바꾸려면 데모 고객으로 다시 로그인해 주세요.");
  }
}

// 장바구니의 모든 줄을 0개로 바꾼다. 되돌릴 수 있는 변경이며 줄마다 요청 키를 달아 재전송을 한 번만 반영한다.
export async function clearCart(scope: Scope, request: string): Promise<Answer> {
  if (!scope.customerId) return loginRequired("update_cart");
  const current = await viewCart(scope);
  const lines = current.cart?.lines ?? [];
  if (!lines.length) return { ...current, answer: "장바구니가 이미 비어 있어요.", toolUsed: "update_cart" };
  let last: Answer = current;
  for (const line of lines) {
    last = await updateCart(scope, request + ":" + line.productId + ":" + line.size, line.productId, line.size, 0, "set", line.name);
    if (last.abstained) return last;
  }
  return { ...last, answer: `장바구니에서 ${lines.length}개 상품을 모두 뺐어요.` };
}

const checkoutDraft = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), id: z.uuid(), expiresAt: z.iso.datetime({ offset: true }), cart: cartSchema }),
  z.object({ status: z.literal("out_of_stock"), shortages: z.array(z.object({ productId: z.string(), size: z.string(), stock: z.int() })) }),
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("missing") }),
]);

// 주문 확인 카드만 만든다. 실제 주문은 고객이 카드에서 확인할 때 decide_agent_action이 처리한다.
export async function prepareCheckout(scope: Scope) {
  if (!scope.customerId) return { answer: loginRequired("prepare_checkout"), approvalId: undefined };
  const { data, error } = await serverClient().rpc("prepare_mock_checkout", {
    p_tenant: scope.tenantId, p_session: scope.sessionId, p_customer: scope.customerId,
  });
  if (error) throw new DemoError(502, "주문 내용을 준비하지 못했어요.");
  const result = checkoutDraft.parse(data);
  if (result.status !== "pending") {
    const reason = result.status === "out_of_stock"
      ? "재고가 부족한 상품이 있어요: " + result.shortages.map((line) => `${line.productId} ${line.size}(남은 수량 ${line.stock}개)`).join(", ")
      : result.status === "empty" ? "장바구니가 비어 있어요. 먼저 상품을 담아 주세요." : "주문하려면 데모 고객으로 다시 로그인해 주세요.";
    const answer: Answer = { answer: reason, sources: [], abstained: true, toolUsed: "prepare_checkout" };
    return { answer, approvalId: undefined };
  }
  const answer: Answer = {
    answer: `주문 금액은 ${result.cart.total.toLocaleString("ko-KR")}원이에요. 아래 내용을 확인하고 주문해 주세요.`,
    sources: [], abstained: false, toolUsed: "prepare_checkout", cart: result.cart,
    action: { kind: "checkout", id: result.id, expiresAt: result.expiresAt, cart: result.cart },
  };
  return { answer, approvalId: result.id as string | undefined };
}

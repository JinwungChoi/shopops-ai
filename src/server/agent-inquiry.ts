import "server-only";
import { z } from "zod";
import type { Answer } from "@/lib/demo";
import type { ReportProgress } from "@/lib/chat-progress";
import { orderReference, referenceSchema, type AgentState } from "./agent-intent";
import { runAgentLoop } from "./agent-loop";
import { createToolSelector, productFilters, type PresentedOrder, type RecentTurn } from "./agent-routing";
import { runAgentWorkflow } from "./agent-workflow";
import { catalogAnswer, type CatalogEntry, type CatalogFilters } from "./catalog";
import { loadCatalog, prepareCheckout, productDetail, updateCart, viewCart } from "./store";
import { listAddresses, listOrders, listReturnEligibility, orderLoginRequired, trackShipment } from "./mock-orders";

const orderContextSchema = z.object({
  reference: referenceSchema, name: z.string().max(200), status: z.string(), orderedAt: z.string(),
  quantity: z.int().positive(), total: z.int().nullable(),
  eligibility: z.enum(["eligible", "not_delivered", "too_late", "already_submitted", "review"]).optional(),
});
const orderContext = z.union([
  z.object({ kind: z.enum(["history", "return_eligibility"]), items: z.array(orderContextSchema).max(20) }),
  z.object({ kind: z.literal("shipment"), order: orderContextSchema }),
]);

const helpPrompt = "Style Shop의 주문·배송·반품, 상품, 쇼핑몰 정책을 안내해 드려요. 무엇을 확인할까요?";

export function presentedOrders(value: unknown): PresentedOrder[] {
  const data = orderContext.safeParse(value).data;
  return !data ? [] : data.kind === "shipment" ? [data.order] : data.items;
}

type Inquiry = {
  tenantId: string; sessionId: string; customerId?: string; question: string; requestId: string;
  filters?: CatalogFilters; prior?: AgentState; previousOrders: PresentedOrder[]; lastOrder?: string;
  recentTurns?: RecentTurn[]; report?: ReportProgress; policyAnswer: (query: string, prompt: string, policyPart: boolean) => Promise<Answer>;
};

export async function answerInquiry({ tenantId, sessionId, customerId, question, requestId, filters, prior, previousOrders, lastOrder, recentTurns, report, policyAnswer }: Inquiry) {
  // 현재 장바구니는 DB에서 읽어 모델 문맥에 넣는다. 수량 변경·주문 요청을 장바구니 기준으로 판단하게 하기 위해서다.
  const currentCart = customerId ? (await viewCart({ tenantId, sessionId, customerId })).cart : undefined;
  const select = createToolSelector(question, filters, prior, previousOrders,
    currentCart?.lines.map(({ productId, name, size, quantity }) => ({ productId, name, size, quantity })), recentTurns);
  const known = new Set(previousOrders.map(({ reference }) => reference));
  // 화면에 보인 주문의 상품명. 모델이 고른 주문번호가 질문의 상품명과 맞는지 확인할 때 쓴다.
  const knownNames = new Map(previousOrders.map(({ reference, name }) => [reference, name]));
  if (prior?.reference) known.add(prior.reference);
  const statedRef = orderReference(question);
  const policies: Answer[] = [];
  let currentOrders = previousOrders;
  let orderResult: Answer | undefined;
  let catalogResult: Answer | undefined;
  let workflowResult: Awaited<ReturnType<typeof runAgentWorkflow>> | undefined;
  let nextFilters: CatalogFilters | undefined;
  let shopResult: Answer | undefined;
  let checkoutApproval: string | undefined;
  const listedAddresses = new Set<string>();
  let catalog: CatalogEntry[] | undefined;
  const products = async () => catalog ??= await loadCatalog(tenantId);
  const scope = { tenantId, sessionId, customerId };

  const status = await runAgentLoop(async (observation) => {
    report?.(observation === undefined ? "routing" : "review_result");
    return select(observation);
  }, async (tool) => {
    if (tool.name === "search_policies") {
      const policy = await policyAnswer(tool.args.query, question, true);
      policies.push({ ...policy, toolUsed: "search_policies" });
      return { answer: policy.answer, grounded: policy.sources.length > 0 };
    }
    if (tool.name === "search_products") {
      report?.("search_products");
      nextFilters = productFilters(tool.args, nextFilters ?? filters);
      catalogResult = { ...catalogAnswer(nextFilters, await products()), toolUsed: "search_products" };
      return { answer: catalogResult.answer, products: catalogResult.catalog?.products };
    }
    if (tool.name === "get_product") {
      report?.("get_product");
      shopResult = await productDetail(tenantId, tool.args.productId, tool.args.productHint);
      return { answer: shopResult.answer, product: shopResult.product };
    }
    if (tool.name === "view_cart" || tool.name === "add_to_cart" || tool.name === "update_cart_item") {
      report?.(tool.name === "view_cart" ? "view_cart" : "update_cart");
      if (tool.name === "view_cart") {
        shopResult = await viewCart(scope);
      } else {
        const name = (await products()).find((entry) => entry.id === tool.args.productId)?.name ?? "해당 상품";
        // 같은 채팅 요청의 재전송이면 DB가 중복 반영을 막는다.
        const key = [requestId, tool.name, tool.args.productId, tool.args.size, tool.args.quantity].join(":");
        shopResult = await updateCart(scope, key, tool.args.productId, tool.args.size, tool.args.quantity,
          tool.name === "add_to_cart" ? "add" : "set", name);
      }
      return { answer: shopResult.answer, cart: shopResult.cart };
    }
    if (tool.name === "prepare_checkout") {
      report?.("prepare_checkout");
      const draft = await prepareCheckout(scope);
      shopResult = draft.answer;
      checkoutApproval = draft.approvalId;
      // 승인 ID는 화면 카드에만 두고 모델에는 전달하지 않는다.
      return { answer: shopResult.answer, awaiting: shopResult.action?.kind, cart: shopResult.cart };
    }
    const referenceArg = "orderReference" in tool.args ? tool.args.orderReference : null;
    const hintArg = "productHint" in tool.args ? tool.args.productHint : null;
    const productHint = hintArg && question.toLowerCase().includes(hintArg.toLowerCase())
      ? hintArg.replaceAll("자켓", "재킷") : null;
    // 질문에 상품명이 있으면, 모델이 고른 주문번호는 그 주문의 상품명이 일치할 때만 쓴다. 이전 턴의 다른 주문을 바꾸는 실수를 막기 위해서다.
    const matchesHint = (ref: string) => !productHint || (knownNames.get(ref)?.replaceAll(" ", "") ?? "").includes(productHint.replaceAll(" ", ""));
    const reference = statedRef ?? (referenceArg && known.has(referenceArg) && matchesHint(referenceArg) ? referenceArg : null);
    if (tool.name === "list_addresses") {
      // 배송지 ID 조회만 한다. 선택 카드는 주문 판정을 통과한 뒤 워크플로가 보여준다.
      if (!customerId) return { answer: "로그인이 필요해요." };
      report?.("list_addresses");
      const listed = await listAddresses(tenantId, customerId);
      const items = listed.action?.kind === "addresses" ? listed.action.items : [];
      for (const item of items) listedAddresses.add(item.id);
      return { addresses: items, next: "prepare_order_change로 주문을 확인하세요." };
    }
    if (tool.name === "prepare_order_change") {
      if (!workflowResult) {
        // 배송지 ID는 이번 턴에 조회한 목록에 있을 때만 쓴다. 없으면 워크플로가 목록을 보여주고 고객이 고르게 한다.
        const addressId = tool.args.addressId && listedAddresses.has(tool.args.addressId) ? tool.args.addressId : null;
        workflowResult = await runAgentWorkflow({
          scope: { tenantId, sessionId, customerId }, question, prior, lastOrder, report,
          decision: undefined, approvalKind: undefined,
          intent: { intent: tool.args.kind, reason: null, orderReference: reference ?? undefined, productHint, policyQuery: null,
            change: { addressId, size: tool.args.size } },
        });
      }
      const { answer } = workflowResult;
      return { answer: answer.answer, awaiting: answer.action?.kind,
        orders: answer.action?.kind === "select_order" ? answer.action.items : undefined,
        addresses: answer.action?.kind === "addresses" ? answer.action.items : undefined };
    }
    if (tool.name === "prepare_return" || tool.name === "offer_support") {
      if (!workflowResult) {
        workflowResult = await runAgentWorkflow({
          scope: { tenantId, sessionId, customerId }, question, prior, lastOrder, report,
          decision: undefined, approvalKind: undefined,
          intent: { intent: tool.name === "prepare_return" ? "return" : "support", reason: tool.args.reason,
            orderReference: reference ?? undefined, productHint, policyQuery: null },
        });
      }
      const { answer } = workflowResult;
      return { answer: answer.answer, awaiting: answer.action?.kind,
        orders: answer.action?.kind === "select_order" ? answer.action.items : undefined };
    }

    const progress = tool.name === "list_returnable_orders" || tool.name === "check_order_return_status"
      ? "check_return_eligibility" : tool.name;
    if (!customerId) {
      orderResult = orderLoginRequired(progress);
    } else {
      report?.(progress);
      switch (tool.name) {
        case "list_orders":
          orderResult = await listOrders(tenantId, customerId, tool.args.status);
          break;
        case "track_shipment":
          orderResult = await trackShipment(tenantId, customerId, reference, productHint);
          break;
        case "list_returnable_orders":
        case "check_order_return_status": {
          const lookup = { reference, productHint,
            view: tool.name === "list_returnable_orders" ? "eligible_only" as const : "order_statuses" as const };
          const presented = tool.args.scope === "previous_orders" ? currentOrders.map((order) => order.reference) : null;
          orderResult = await listReturnEligibility(tenantId, customerId, { ...lookup, presented });
          // 제외 사유는 직전 목록 밖의 주문에 대해 묻는 경우가 많다. 지목한 주문이 범위에 없으면 같은 고객의 전체 주문에서 찾는다.
          const missing = orderResult.orders?.kind === "return_eligibility" && orderResult.orders.items.length === 0;
          if (tool.name === "check_order_return_status" && presented && (reference || productHint) && (missing || !orderResult.orders)) {
            orderResult = await listReturnEligibility(tenantId, customerId, { ...lookup, presented: null });
          }
          break;
        }
      }
    }
    const observed = presentedOrders(orderResult.orders);
    if (tool.name === "list_orders" && observed.length) currentOrders = observed;
    for (const order of observed) {
      known.add(order.reference);
      knownNames.set(order.reference, order.name);
    }
    return { answer: orderResult.answer, orders: orderResult.orders };
  });

  const citations = [...new Map(policies.flatMap((policy) => policy.sources)
    .map((source) => [source.documentId, source])).values()];
  const groundedPolicies = policies.filter((policy) => policy.sources.length > 0);
  const policy = groundedPolicies.length ? {
    answer: [...new Set(groundedPolicies.map((entry) => entry.answer))].join("\n\n"),
    sources: citations, abstained: false, toolUsed: "search_policies" as const,
  } : policies[0];
  const answers = [orderResult, catalogResult, workflowResult?.answer, shopResult].filter((answer) => answer !== undefined);
  // 조회 도구가 모두 보류(로그인 필요 등)이고 정책 답변이 있으면 정책을 주 답변으로 둔다.
  const policyLeads = policy !== undefined && answers.every((answer) => answer.abstained);
  const primary = policyLeads ? undefined : answers.at(-1);
  const pendingCard = workflowResult?.answer.action ?? shopResult?.action;
  const clarification = status === "clarify" && !pendingCard && !workflowResult
    ? catalogResult || shopResult?.product ? "원하는 상품의 사이즈 버튼을 눌러 골라 주세요. 수량을 말하지 않으면 1개로 담아요."
      : answers.length ? "확인할 주문번호나 상품명을 알려주세요." : helpPrompt : undefined;
  const incomplete = status === "incomplete" && !pendingCard
    ? "추가 확인이 필요한 내용은 다시 물어봐 주세요." : undefined;
  const result: Answer | undefined = primary ? {
    ...primary,
    answer: [...new Set([...answers.map((entry) => entry.answer), clarification, incomplete].filter(Boolean))].join("\n\n"),
    orders: orderResult?.orders, catalog: catalogResult?.catalog, cart: shopResult?.cart, product: shopResult?.product,
    abstained: answers.every((answer) => answer.abstained),
  } : policy ? {
    ...policy, answer: [policy.answer, ...answers.map((entry) => entry.answer)].join("\n\n"),
  } : {
    answer: clarification ?? helpPrompt,
    sources: [], abstained: true,
  };
  const checkpoint: AgentState | undefined = workflowResult?.checkpoint ?? (checkoutApproval ? {
    intent: "checkout", reference: null, reason: null, waiting: "approval", approvalId: checkoutApproval, approvalKind: "checkout",
  } : undefined);
  return { result, supplementaryPolicy: primary ? policy : undefined, filters: nextFilters, checkpoint };
}

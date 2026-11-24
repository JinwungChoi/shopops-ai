import "server-only";
import { z } from "zod";
import type { Answer } from "@/lib/demo";
import type { ReportProgress } from "@/lib/chat-progress";
import { orderReference, referenceSchema, type AgentState } from "./agent-intent";
import { runAgentLoop } from "./agent-loop";
import { createToolSelector, productFilters, type PresentedOrder } from "./agent-routing";
import { runAgentWorkflow } from "./agent-workflow";
import { catalogAnswer, type CatalogFilters } from "./catalog";
import { listOrders, listReturnEligibility, orderLoginRequired, trackShipment } from "./mock-orders";

const orderContextSchema = z.object({
  reference: referenceSchema, name: z.string().max(200), status: z.string(), orderedAt: z.string(),
  quantity: z.int().positive(), total: z.int().nullable(),
  eligibility: z.enum(["eligible", "not_delivered", "too_late", "already_submitted", "review"]).optional(),
});
const orderContext = z.union([
  z.object({ kind: z.enum(["history", "return_eligibility"]), items: z.array(orderContextSchema).max(20) }),
  z.object({ kind: z.literal("shipment"), order: orderContextSchema }),
]);

export function presentedOrders(value: unknown): PresentedOrder[] {
  const data = orderContext.safeParse(value).data;
  return !data ? [] : data.kind === "shipment" ? [data.order] : data.items;
}

type Inquiry = {
  tenantId: string; sessionId: string; customerId?: string; question: string;
  filters?: CatalogFilters; prior?: AgentState; previousOrders: PresentedOrder[]; lastOrder?: string;
  report?: ReportProgress; policyAnswer: (query: string, prompt: string, policyPart: boolean) => Promise<Answer>;
};

export async function answerInquiry({ tenantId, sessionId, customerId, question, filters, prior, previousOrders, lastOrder, report, policyAnswer }: Inquiry) {
  const select = createToolSelector(question, filters, prior, previousOrders);
  const known = new Set(previousOrders.map(({ reference }) => reference));
  if (prior?.reference) known.add(prior.reference);
  const statedRef = orderReference(question);
  const policies: Answer[] = [];
  let currentOrders = previousOrders;
  let orderResult: Answer | undefined;
  let catalogResult: Answer | undefined;
  let workflowResult: Awaited<ReturnType<typeof runAgentWorkflow>> | undefined;
  let nextFilters: CatalogFilters | undefined;

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
      catalogResult = { ...catalogAnswer(nextFilters), toolUsed: "search_products" };
      return { answer: catalogResult.answer, products: catalogResult.catalog?.products };
    }
    const referenceArg = "orderReference" in tool.args ? tool.args.orderReference : null;
    const reference = statedRef ?? (referenceArg && known.has(referenceArg) ? referenceArg : null);
    const hintArg = "productHint" in tool.args ? tool.args.productHint : null;
    const productHint = hintArg && question.toLowerCase().includes(hintArg.toLowerCase())
      ? hintArg.replaceAll("자켓", "재킷") : null;
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
          orderResult = await listOrders(tenantId, customerId);
          break;
        case "track_shipment":
          orderResult = await trackShipment(tenantId, customerId, reference, productHint);
          break;
        case "list_returnable_orders":
        case "check_order_return_status":
          orderResult = await listReturnEligibility(tenantId, customerId, {
            reference, productHint, presented: tool.args.scope === "previous_orders" ? currentOrders.map((order) => order.reference) : null,
            view: tool.name === "list_returnable_orders" ? "eligible_only" : "order_statuses",
          });
          break;
      }
    }
    const observed = presentedOrders(orderResult.orders);
    if (tool.name === "list_orders" && observed.length) currentOrders = observed;
    for (const order of observed) known.add(order.reference);
    return { answer: orderResult.answer, orders: orderResult.orders };
  });

  const citations = [...new Map(policies.flatMap((policy) => policy.sources)
    .map((source) => [source.documentId, source])).values()];
  const groundedPolicies = policies.filter((policy) => policy.sources.length > 0);
  const policy = groundedPolicies.length ? {
    answer: [...new Set(groundedPolicies.map((entry) => entry.answer))].join("\n\n"),
    sources: citations, abstained: false, toolUsed: "search_policies" as const,
  } : policies[0];
  const answers = [orderResult, catalogResult, workflowResult?.answer].filter((answer) => answer !== undefined);
  const primary = answers.at(-1);
  const clarification = status === "clarify" && !workflowResult?.answer.action
    ? "확인할 주문번호나 상품명을 알려주세요." : undefined;
  const incomplete = status === "incomplete" && !workflowResult?.answer.action
    ? "추가 확인이 필요한 내용은 다시 물어봐 주세요." : undefined;
  const result: Answer | undefined = primary ? {
    ...primary,
    answer: [...new Set([...answers.map((entry) => entry.answer), clarification, incomplete].filter(Boolean))].join("\n\n"),
    orders: orderResult?.orders, catalog: catalogResult?.catalog,
    abstained: answers.every((answer) => answer.abstained),
  } : policy ?? {
    answer: clarification ?? "어떤 내용을 확인할지 조금 더 자세히 알려주세요.",
    sources: [], abstained: true,
  };
  return { result, supplementaryPolicy: primary ? policy : undefined, filters: nextFilters, checkpoint: workflowResult?.checkpoint };
}

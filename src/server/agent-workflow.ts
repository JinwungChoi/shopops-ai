import "server-only";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import type { ReportProgress } from "@/lib/chat-progress";
import type { ActionDecision, Answer } from "@/lib/demo";
import { orderReference, reasonLabels, type ActionIntent, type AgentState } from "./agent-intent";
import { DemoError } from "./demo-core";
import { findActionOrders, returnEligibilityOf } from "./mock-orders";
import { serverClient } from "./supabase";

type Scope = { tenantId: string; sessionId: string; customerId?: string };
type Candidate = Awaited<ReturnType<typeof findActionOrders>>[number];
const rpcResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), id: z.uuid(), expiresAt: z.iso.datetime({ offset: true }),
    quantity: z.int().positive().nullable(), fee: z.int().nonnegative().nullable() }),
  z.object({ status: z.literal("confirmed"), kind: z.enum(["return", "support", "checkout"]), receipt: z.uuid(),
    orders: z.array(z.string()).optional(), total: z.int().optional() }),
  z.object({ status: z.enum(["missing", "not_delivered", "already_submitted", "too_late", "review", "invalid",
    "expired", "canceled", "condition_required", "already_confirmed", "cart_changed", "out_of_stock"]) }),
]);

function message(answer: string, props: Partial<Answer> = {}): Answer {
  return { answer, sources: [], abstained: false, ...props };
}

const State = Annotation.Root({
  scope: Annotation<Scope>(),
  question: Annotation<string>(),
  intent: Annotation<ActionIntent | undefined>(),
  decision: Annotation<ActionDecision | undefined>(),
  approvalKind: Annotation<"return" | "support" | "checkout" | undefined>(),
  prior: Annotation<AgentState | undefined>(),
  lastOrder: Annotation<string | undefined>(),
  report: Annotation<ReportProgress | undefined>(),
  checkpoint: Annotation<AgentState | undefined>(),
  candidate: Annotation<Candidate | undefined>(),
  result: Annotation<Answer | undefined>(),
  notice: Annotation<string | undefined>(),
});

type GraphState = typeof State.State;

const scopeArgs = ({ tenantId, sessionId, customerId }: Scope) =>
  ({ p_tenant: tenantId, p_session: sessionId, p_customer: customerId });

const statusMessages = {
  missing: "로그인한 고객의 주문이나 확인 요청에서 찾지 못했어요.",
  not_delivered: "아직 배송 완료 전이에요. 상품을 받은 뒤 반품을 신청해 주세요.",
  already_submitted: "이 주문은 이미 반품 접수됐어요.",
  too_late: "수령 후 7일이 지나 채팅에서 반품을 접수하기 어려워요.",
  review: "상담원이 주문과 반품 조건을 확인해야 해요.",
  invalid: "확인 요청을 다시 만들어 주세요.",
  expired: "확인 시간이 지났어요. 다시 요청해 주세요.",
  canceled: "접수 요청을 취소했어요.",
  condition_required: "미사용 상품이며 태그와 구성품이 모두 있는지 확인해 주세요.",
  already_confirmed: "이미 접수된 요청이에요.",
  cart_changed: "주문 확인 후 장바구니나 가격이 바뀌었어요. 주문 내용을 다시 확인해 주세요.",
  out_of_stock: "그 사이 재고가 부족해져 주문하지 못했어요. 장바구니를 다시 확인해 주세요.",
};

async function locate({ scope, question, intent, prior, lastOrder, report }: GraphState): Promise<Partial<GraphState>> {
  if (!intent) return {};
  const customerId = scope.customerId;
  if (!customerId) return { result: message("주문 상담을 진행하려면 데모 고객으로 로그인해 주세요.", { abstained: true }) };
  report?.(intent.intent === "return" ? "check_return_eligibility" : "list_orders");

  const hint = intent.productHint && question.toLowerCase().includes(intent.productHint.toLowerCase())
    ? intent.productHint.replaceAll("자켓", "재킷") : null;
  const continuedReason = prior?.waiting === "reason" && prior.intent === intent.intent;
  const contextualRef = continuedReason ? prior.reference : lastOrder;
  const reference = orderReference(question) ?? intent.orderReference ?? (
    (continuedReason && !hint || /그\s?(?:거|상품|주문|재킷)|해당 주문/u.test(question) || !hint && intent.reason === "missing_delivery")
    ? contextualRef ?? null : null);
  const reason = intent.reason ?? (continuedReason ? prior.reason : null);
  const checkpoint: AgentState = { intent: intent.intent, reference, reason, waiting: "order" };
  const genericSupport = intent.intent === "support" && reason === "staff_requested" && !reference && !hint;
  const orders = genericSupport ? [] : await findActionOrders(scope.tenantId, customerId, reference, hint);
  if (!genericSupport && !orders.length) {
    return { checkpoint, result: message("로그인한 고객의 주문에서 찾지 못했어요. 주문번호나 상품명을 확인해 주세요.", { abstained: true }) };
  }
  if (orders.length > 1) {
    return { checkpoint, result: message("어느 주문인지 선택해 주세요.", {
      action: { kind: "select_order", items: orders.map(({ summary }) => summary) },
    }) };
  }
  const candidate = orders[0];
  checkpoint.reference = candidate?.summary.reference ?? null;
  if (intent.intent === "return" && !reason && candidate) {
    // 사유를 묻기 전에 서버 판정을 먼저 확인한다. 신청할 수 없는 주문에는 사유를 묻지 않는다.
    const eligibility = await returnEligibilityOf(scope.tenantId, customerId, candidate.summary.reference);
    if (eligibility === "not_delivered" || eligibility === "already_submitted") {
      return { checkpoint: { ...checkpoint, waiting: "closed" }, candidate, result: message(statusMessages[eligibility], {
        toolUsed: "check_return_eligibility" }) };
    }
    if (eligibility === "too_late" || eligibility === "review") {
      return { checkpoint: { ...checkpoint, reason: "policy_review" }, candidate, notice: statusMessages[eligibility] };
    }
  }
  if (intent.intent === "return" && !reason) {
    checkpoint.waiting = "reason";
    return { checkpoint, candidate, result: message(`${candidate.summary.name} 반품 사유를 알려주세요.`, {
      toolUsed: "check_return_eligibility", action: { kind: "return_reason" },
    }) };
  }
  return { checkpoint, candidate };
}

async function prepare({ scope, checkpoint, candidate, notice }: GraphState): Promise<Partial<GraphState>> {
  if (!checkpoint) return {};
  const reason = checkpoint.reason ?? "staff_requested";
  const kind = checkpoint.intent === "return" && reason === "change_of_mind" ? "return" : "support";
  const client = serverClient();
  const prepareAction = async (action: "return" | "support", why: typeof reason) => {
    const { data, error } = await client.rpc("prepare_agent_action", {
      ...scopeArgs(scope), p_order: candidate?.id ?? null, p_kind: action, p_reason: why,
    });
    if (error) throw new DemoError(502, "접수 내용을 준비하지 못했어요. 다시 시도해 주세요.");
    return rpcResponse.parse(data);
  };
  let proposal = await prepareAction(kind, reason);
  let action: "return" | "support" = kind;
  let label = reasonLabels[reason];
  let explanation = notice ? notice + " " : "";
  if (kind === "return" && (proposal.status === "review" || proposal.status === "too_late")) {
    explanation = statusMessages[proposal.status] + " ";
    proposal = await prepareAction("support", "policy_review");
    action = "support";
    label = reasonLabels.policy_review;
  }
  const toolUsed = checkpoint.intent === "return" ? "check_return_eligibility" : undefined;
  if (proposal.status !== "pending") {
    return { checkpoint: { ...checkpoint, waiting: "closed" }, result: message(
      proposal.status === "confirmed" ? "이미 접수된 요청이에요." : statusMessages[proposal.status], { toolUsed },
    ) };
  }
  if (reason === "missing_delivery" && candidate && candidate.summary.status !== "배송 완료") {
    explanation = `주문에 기록된 상태는 '${candidate.summary.status}'이에요. `;
  }
  return { checkpoint: { ...checkpoint, waiting: "approval", approvalId: proposal.id, approvalKind: action }, result: message(
    action === "return" ? "반품을 접수할 수 있어요. 아래 내용을 확인해 주세요."
      : explanation + "상담원이 확인할 수 있도록 문의를 남길까요?",
    { toolUsed, action: { kind: "approval", id: proposal.id, action, reason: label, expiresAt: proposal.expiresAt,
      order: candidate?.summary, quantity: proposal.quantity, fee: proposal.fee } },
  ) };
}

export function decisionContent(decision: ActionDecision) {
  return decision.decision === "confirm" ? "접수 확인" : "접수 취소";
}

async function decide({ scope, decision, approvalKind, report, prior }: GraphState): Promise<Partial<GraphState>> {
  if (!decision || !scope.customerId) throw new DemoError(401, "접수하려면 데모 고객으로 로그인해 주세요.");
  if (decision.decision === "confirm" && approvalKind) {
    report?.(approvalKind === "return" ? "submit_return_request" : approvalKind === "checkout" ? "place_order" : "create_support_ticket");
  }
  const { data, error } = await serverClient().rpc("decide_agent_action", {
    ...scopeArgs(scope), p_approval: decision.approvalId, p_confirm: decision.decision === "confirm",
    p_item_condition_confirmed: decision.itemConditionConfirmed,
  });
  if (error) throw new DemoError(502, "접수 결과를 확인하지 못했어요. 다시 시도해 주세요.");
  const response = rpcResponse.parse(data);
  if (response.status === "missing") throw new DemoError(404, "이 대화의 확인 요청을 찾지 못했어요.");
  if (response.status === "condition_required") throw new DemoError(400, statusMessages.condition_required);
  const checkpoint = prior?.approvalId === decision.approvalId ? { ...prior, waiting: "closed" as const } : undefined;
  if (response.status === "confirmed") {
    if (response.kind === "checkout") {
      const refs = response.orders ?? [];
      return { checkpoint, result: message(`모의 결제로 주문을 완료했어요. 주문번호 ${refs.join(", ")}` +
        (response.total !== undefined ? ` · 결제 금액 ${response.total.toLocaleString("ko-KR")}원` : ""), {
        toolUsed: "place_order",
        action: { kind: "receipt", action: "checkout", id: response.receipt, approvalId: decision.approvalId, orders: refs, total: response.total },
      }) };
    }
    const isReturn = response.kind === "return";
    return { checkpoint, result: message(isReturn ? "반품을 접수했어요." : "상담팀에 문의를 남겼어요.",
      { toolUsed: isReturn ? "submit_return_request" : "create_support_ticket",
        action: { kind: "receipt", action: response.kind, id: response.receipt, approvalId: decision.approvalId } }) };
  }
  const closedMessage = approvalKind === "checkout" && response.status === "canceled" ? "주문을 취소했어요. 장바구니는 그대로 남아 있어요."
    : response.status === "pending" ? "아직 확인을 기다리고 있어요." : statusMessages[response.status];
  return { checkpoint, result: message(closedMessage,
    { action: { kind: "closed", approvalId: decision.approvalId } }) };
}

// Supabase에 저장된 업무 상태만 다시 불러온다. 원문이나 인증 정보는 그래프에 보관하지 않는다.
const graph = new StateGraph(State)
  .addNode("locate", locate)
  .addNode("prepare", prepare)
  .addNode("decide", decide)
  .addConditionalEdges(START, (state) => state.decision ? "decide" : "locate", ["decide", "locate"])
  .addConditionalEdges("locate", (state) => state.result ? END : "prepare", [END, "prepare"])
  .addEdge("prepare", END)
  .addEdge("decide", END)
  .compile();

export const agentWorkflowGraph = graph;

export async function runAgentWorkflow(input: Pick<GraphState, "scope" | "question" | "intent" | "decision" | "approvalKind" | "prior" | "lastOrder" | "report">) {
  const output = await graph.invoke(input, { recursionLimit: 8 });
  if (!output.result) throw new DemoError(502, "요청에 맞는 접수 단계를 확인하지 못했어요.");
  return { answer: output.result, checkpoint: output.checkpoint };
}

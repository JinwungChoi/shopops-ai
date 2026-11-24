// P2-07 다중 턴 회귀: 모델 선택만 가짜로 고정하고 서버 조립(agent-inquiry, mock-orders)은 실제 코드를 쓴다.
// 판정 SQL은 supabase/tests/agent_actions.sql(pgTAP)이 검증하고, 여기서는 서버가 넘기는 범위·인자와 결과 조립, 승인 경계를 확인한다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer, OrderResult } from "@/lib/demo";
import type { AgentRoute, PresentedOrder } from "@/server/agent-routing";

vi.mock("server-only", () => ({}));

type Eligibility = "eligible" | "not_delivered" | "too_late" | "already_submitted" | "review";
type Row = { tenant: string; customer: string; ref: string; name: string; status: "preparing" | "in_transit" | "delivered";
  eligibility: Eligibility; day: number; total: number };

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const customerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const customerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "33333333-3333-4333-8333-333333333333";
const approvalId = "55555555-5555-4555-8555-555555555555";
const receiptId = "66666666-6666-4666-8666-666666666666";

// 고객 A 12건(최신순), 고객 B와 다른 업체 주문은 같은 판정이어도 결과에 섞이면 안 된다.
const a = (ref: string, name: string, status: Row["status"], eligibility: Eligibility, day: number): Row =>
  ({ tenant: tenantId, customer: customerA, ref, name, status, eligibility, day, total: 40000 });
const rows: Row[] = [
  a("STY-1001", "블랙 트윌 재킷", "in_transit", "not_delivered", 22),
  a("STY-1002", "차콜 플리츠 팬츠", "delivered", "eligible", 21),
  a("STY-1003", "화이트 린넨 셔츠", "delivered", "eligible", 20),
  a("STY-1004", "스톤 치노 팬츠", "delivered", "already_submitted", 19),
  a("STY-1005", "아이보리 니트", "delivered", "review", 18),
  a("STY-1006", "블랙 울 코트", "delivered", "eligible", 17),
  a("STY-1007", "그레이 후드", "delivered", "too_late", 16),
  a("STY-1008", "네이비 린넨 셔츠", "delivered", "too_late", 15),
  a("STY-1009", "데님 재킷", "delivered", "too_late", 14),
  a("STY-1010", "카키 카고 팬츠", "delivered", "too_late", 13),
  a("STY-1011", "화이트 스니커즈", "delivered", "too_late", 12),
  a("STY-1012", "브라운 레더 벨트", "delivered", "too_late", 11),
  { ...a("STY-2001", "아이보리 옥스퍼드 셔츠", "delivered", "eligible", 23), customer: customerB },
  { ...a("STY-9001", "다른 업체 린넨 셔츠", "delivered", "eligible", 23), tenant: otherTenant },
];

const toDb = (row: Row) => ({
  id: `00000000-0000-4000-8000-${row.ref.slice(4).padStart(12, "0")}`, order_reference: row.ref, product_name: row.name,
  ordered_at: `2026-10-${String(row.day).padStart(2, "0")}T03:00:00Z`, status: row.status, quantity: 1,
  total_amount: row.total, carrier: null, tracking_number: null,
});
const newestFirst = (list: Row[]) => [...list].sort((x, y) => y.day - x.day);

const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

// list_mock_return_eligibility의 필터 순서(업체·고객 → 주문번호 → 상품 → 표시 범위 → 최신 20건)를 따르는 가짜 DB.
const fakeClient = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    // 승인 RPC 응답은 형식만 흉내 낸다. 소유권·만료·단일 접수 판정은 pgTAP(agent_actions.sql)가 검증한다.
    if (name === "prepare_agent_action") {
      return { data: { status: "pending", id: approvalId, expiresAt: "2026-11-24T12:10:00+00:00", quantity: 1, fee: 6000 }, error: null };
    }
    if (name === "decide_agent_action") {
      return { data: args.p_confirm ? { status: "confirmed", kind: "return", receipt: receiptId } : { status: "canceled" }, error: null };
    }
    if (name !== "list_mock_return_eligibility") return { data: null, error: { message: "unexpected rpc" } };
    const presented = args.p_presented as string[] | null;
    const hint = (args.p_product_hint as string | null)?.toLowerCase();
    const data = newestFirst(rows.filter((row) => row.tenant === args.p_tenant && row.customer === args.p_customer
      && (args.p_reference === null || row.ref === args.p_reference)
      && (!hint || row.name.toLowerCase().includes(hint))
      && (presented === null || presented.includes(row.ref)))).slice(0, 20)
      .map((row) => ({ ...toDb(row), eligibility: row.eligibility }));
    return { data, error: null };
  },
  from: (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let limit = Infinity;
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        const key = ({ tenant_id: "tenant", customer_user_id: "customer", order_reference: "ref", status: "status" } as const)[column];
        if (!key) throw new Error("unexpected column " + column);
        filters.push((row) => row[key] === value);
        return query;
      },
      ilike: (_column: string, pattern: string) => {
        const needle = pattern.replaceAll("%", "").toLowerCase();
        filters.push((row) => row.name.toLowerCase().includes(needle));
        return query;
      },
      order: () => query,
      limit: (count: number) => { limit = count; return query; },
      then: (resolve: (value: { data: unknown; error: null }) => void) => {
        if (table === "mock_shipment_events") return resolve({ data: [], error: null });
        resolve({ data: newestFirst(rows.filter((row) => filters.every((match) => match(row)))).slice(0, limit).map(toDb), error: null });
      },
    };
    return query;
  },
};

vi.mock("@/server/supabase", () => ({ serverClient: () => fakeClient }));

// 모델 대역: 턴마다 받은 입력(질문, 이전 주문 범위)과 도구 결과를 기록하고 정해진 도구를 고른다.
type ModelTurn = { question: string; previousOrders: string[]; observations: unknown[] };
const modelTurns: ModelTurn[] = [];
let script: AgentRoute[] = [];
vi.mock("@/server/agent-routing", async (importActual) => {
  const actual = await importActual<typeof import("@/server/agent-routing")>();
  return {
    ...actual,
    createToolSelector: (question: string, _filters: unknown, _workflow: unknown, orders: PresentedOrder[]) => {
      const turn: ModelTurn = { question, previousOrders: orders.map((order) => order.reference), observations: [] };
      modelTurns.push(turn);
      const routes = [...script];
      return async (observation?: unknown) => {
        if (observation !== undefined) turn.observations.push(observation);
        const next = routes.shift();
        if (!next) throw new Error("모델 대본이 끝났습니다.");
        return next;
      };
    },
  };
});

const { answerInquiry, presentedOrders } = await import("@/server/agent-inquiry");

const feeSource = { documentId: "44444444-4444-4444-8444-444444444444", title: "Style Shop 반품 정책", version: 2,
  excerpt: "단순 변심 반품 배송비는 6,000원입니다." };
const policyAnswer = vi.fn(async (): Promise<Answer> => ({
  answer: "단순 변심 반품 배송비는 6,000원이에요.", sources: [feeSource], abstained: false,
}));

const finish: AgentRoute = { name: "finish", args: { outcome: "answer" } };
const refs = (result: OrderResult | undefined) => result && result.kind !== "shipment" ? result.items.map((item) => item.reference) : [];

// live-chat.ts처럼 직전 턴의 order_response만 다음 턴의 이전 주문 범위로 넘긴다.
async function chat(question: string, routes: AgentRoute[], displayed?: OrderResult, customerId: string | null = customerA) {
  script = routes;
  return answerInquiry({ tenantId, sessionId, customerId: customerId ?? undefined, question, previousOrders: presentedOrders(displayed), report: undefined, policyAnswer });
}

beforeEach(() => {
  rpcCalls.length = 0;
  modelTurns.length = 0;
  policyAnswer.mockClear();
});

describe("주문 내역 → 그중 반품 가능 + 반품비 → 제외 사유", () => {
  it("이전 턴의 주문 범위로 가능한 주문만 카드로 돌려주고, 건수·카드·비용 출처가 같은 결과에서 나온다", async () => {
    const history = await chat("내 주문 내역 보여줘", [{ name: "list_orders", args: { status: null } }, finish]);
    expect(history.result.toolUsed).toBe("list_orders");
    const shown = refs(history.result.orders);
    expect(shown).toHaveLength(12);
    expect(shown).not.toContain("STY-2001");
    expect(shown).not.toContain("STY-9001");

    const eligibilityCall: AgentRoute = { name: "list_returnable_orders",
      args: { scope: "previous_orders", orderReference: null, productHint: null } };
    const returnable = await chat("그중 지금 돌려보낼 수 있는 거랑 반품비 알려줘",
      [eligibilityCall, { name: "search_policies", args: { query: "단순 변심 반품비" } }, finish], history.result.orders);

    // 모델이 받은 상태: 직전에 표시한 12건. 서버가 그 범위를 DB 함수 인자로 바인딩한다.
    expect(modelTurns[1].previousOrders).toEqual(shown);
    expect(rpcCalls).toEqual([{ name: "list_mock_return_eligibility", args: {
      p_tenant: tenantId, p_customer: customerA, p_reference: null, p_product_hint: null, p_presented: shown } }]);

    const cards = returnable.result.orders;
    expect(cards?.kind).toBe("return_eligibility");
    expect(refs(cards)).toEqual(["STY-1002", "STY-1003", "STY-1006"]);
    if (cards?.kind === "return_eligibility") expect(cards.items.every((item) => item.eligibility === "eligible")).toBe(true);
    // 답변의 건수와 카드 수가 같은 서버 결과에서 나온다.
    expect(returnable.result.answer).toContain(`지금 반품을 신청할 수 있는 주문은 ${refs(cards).length}건이에요.`);
    // 모델에 돌려준 도구 결과와 화면 카드가 같은 목록이다.
    expect(modelTurns[1].observations[0]).toMatchObject({ orders: cards });
    // 비용은 정책 검색의 출처와 함께 붙는다(live-chat이 보조 정책으로 합친다).
    expect(policyAnswer).toHaveBeenCalledWith("단순 변심 반품비", "그중 지금 돌려보낼 수 있는 거랑 반품비 알려줘", true);
    expect(returnable.supplementaryPolicy?.sources).toEqual([feeSource]);
    expect(returnable.checkpoint).toBeUndefined();

    const why = await chat("STY-1008 이 주문은 왜 빠졌어?", [{ name: "check_order_return_status",
      args: { scope: "all_orders", orderReference: "STY-1008", productHint: null } }, finish], returnable.result.orders);
    expect(modelTurns[2].previousOrders).toEqual(["STY-1002", "STY-1003", "STY-1006"]);
    expect(rpcCalls.at(-1)?.args).toMatchObject({ p_reference: "STY-1008", p_presented: null });
    expect(refs(why.result.orders)).toEqual(["STY-1008"]);
    expect(why.result.orders).toMatchObject({ kind: "return_eligibility", items: [{ eligibility: "too_late" }] });
    expect(why.result.answer).toBe("수령 후 7일이 지나 반품 신청 기한이 끝났어요.");
  });

  // 모델 대본이 질문을 읽지 않으므로 표현 다양성 자체는 검증하지 않는다(실제 모델 2단계 범위).
  it("같은 이전 주문 범위로 다시 물어도 서버 결과는 같은 카드를 만든다", async () => {
    const history = await chat("뭐 샀는지 목록 좀", [{ name: "list_orders", args: { status: null } }, finish]);
    const route: AgentRoute = { name: "list_returnable_orders", args: { scope: "previous_orders", orderReference: null, productHint: null } };
    const results = [];
    for (const question of ["아까 보여준 주문 중에 반품되는 거 뭐야?", "거기서 지금 환불 보낼 수 있는 옷만 골라줘"]) {
      results.push(refs((await chat(question, [route, finish], history.result.orders)).result.orders));
    }
    expect(results).toEqual([["STY-1002", "STY-1003", "STY-1006"], ["STY-1002", "STY-1003", "STY-1006"]]);
  });

  it("이전에 일부 주문만 보였다면 그중 판정은 그 주문들로 한정된다", async () => {
    const shipment = await chat("린넨 셔츠 배송 어디야?", [{ name: "track_shipment", args: { orderReference: null, productHint: "린넨 셔츠" } }, finish]);
    expect(refs(shipment.result.orders)).toEqual(["STY-1003", "STY-1008"]);
    const scoped = await chat("그중 반품 가능한 거 있어?", [{ name: "list_returnable_orders",
      args: { scope: "previous_orders", orderReference: null, productHint: null } }, finish], shipment.result.orders);
    expect(rpcCalls.at(-1)?.args).toMatchObject({ p_presented: ["STY-1003", "STY-1008"] });
    expect(refs(scoped.result.orders)).toEqual(["STY-1003"]);
    expect(scoped.result.answer).toBe("지금 반품을 신청할 수 있는 주문은 1건이에요.");
  });
});

describe("서버 바인딩 경계", () => {
  it("질문과 조회 결과에 없는 주문번호를 모델이 넣어도 무시하고 다른 고객 주문을 반환하지 않는다", async () => {
    const history = await chat("내 주문 내역 보여줘", [{ name: "list_orders", args: { status: null } }, finish]);
    const result = await chat("이 주문은 왜 빠졌어?", [{ name: "check_order_return_status",
      args: { scope: "all_orders", orderReference: "STY-2001", productHint: null } }, finish], history.result.orders);
    expect(rpcCalls.at(-1)?.args).toMatchObject({ p_tenant: tenantId, p_customer: customerA, p_reference: null });
    expect(refs(result.result.orders)).not.toContain("STY-2001");
    expect(refs(result.result.orders)).toHaveLength(12);
    expect(result.result.answer).toBe("주문 12건의 반품 가능 여부를 확인했어요.");
  });

  it("이전에 보여준 주문이 없으면 그중 조회를 DB에 보내지 않고 보류한다", async () => {
    const result = await chat("그중 반품 가능한 거 알려줘", [{ name: "list_returnable_orders",
      args: { scope: "previous_orders", orderReference: null, productHint: null } }, finish]);
    expect(rpcCalls).toHaveLength(0);
    expect(result.result).toMatchObject({ abstained: true, answer: "앞서 보여드린 주문이 없어요. 먼저 주문 내역을 확인해 주세요." });
  });

  it("로그인하지 않은 고객에게는 주문 조회 없이 로그인을 안내한다", async () => {
    const result = await chat("내 주문 내역 보여줘", [{ name: "list_orders", args: { status: null } }, finish], undefined, null);
    expect(rpcCalls).toHaveLength(0);
    expect(result.result).toMatchObject({ abstained: true, orders: undefined });
  });
});

describe("반품 요청 → 고객 확인 → 접수", () => {
  it("모델 턴은 확인 카드까지만 만들고, 접수는 고객의 확인 결정으로만 실행된다", async () => {
    const { runAgentWorkflow } = await import("@/server/agent-workflow");
    const draft = await chat("STY-1002 단순 변심으로 반품해줘", [{ name: "prepare_return",
      args: { orderReference: "STY-1002", productHint: null, reason: "change_of_mind" } }, finish]);

    // 모델 턴에서는 초안만 만들고 확정 RPC를 부르지 않는다.
    expect(rpcCalls.map(({ name }) => name)).toEqual(["prepare_agent_action"]);
    expect(rpcCalls[0].args).toMatchObject({ p_tenant: tenantId, p_session: sessionId, p_customer: customerA,
      p_order: "00000000-0000-4000-8000-000000001002", p_kind: "return", p_reason: "change_of_mind" });
    expect(draft.result.action).toMatchObject({ kind: "approval", id: approvalId, action: "return", fee: 6000,
      order: { reference: "STY-1002" } });
    expect(draft.checkpoint).toMatchObject({ waiting: "approval", approvalId, approvalKind: "return", reference: "STY-1002" });
    // 승인 ID는 화면 카드에만 있고 모델이 읽는 도구 결과에는 없다.
    expect(modelTurns[0].observations[0]).toEqual({ answer: "반품을 접수할 수 있어요. 아래 내용을 확인해 주세요.",
      awaiting: "approval", orders: undefined });
    expect(JSON.stringify(modelTurns[0].observations)).not.toContain(approvalId);

    rpcCalls.length = 0;
    const receipt = await runAgentWorkflow({ scope: { tenantId, sessionId, customerId: customerA }, question: "접수 확인",
      intent: undefined, decision: { approvalId, decision: "confirm", itemConditionConfirmed: true },
      approvalKind: draft.checkpoint?.approvalKind, prior: draft.checkpoint, lastOrder: undefined, report: undefined });
    expect(rpcCalls).toEqual([{ name: "decide_agent_action", args: { p_tenant: tenantId, p_session: sessionId,
      p_customer: customerA, p_approval: approvalId, p_confirm: true, p_item_condition_confirmed: true } }]);
    expect(receipt.answer).toMatchObject({ answer: "반품을 접수했어요.", toolUsed: "submit_return_request",
      action: { kind: "receipt", action: "return", id: receiptId, approvalId } });
    expect(receipt.checkpoint).toMatchObject({ waiting: "closed", approvalId });
  });

  it("로그인하지 않은 확인 결정은 DB에 보내지 않는다", async () => {
    const { runAgentWorkflow } = await import("@/server/agent-workflow");
    await expect(runAgentWorkflow({ scope: { tenantId, sessionId }, question: "접수 확인", intent: undefined,
      decision: { approvalId, decision: "confirm", itemConditionConfirmed: true }, approvalKind: "return",
      prior: undefined, lastOrder: undefined, report: undefined })).rejects.toMatchObject({ status: 401 });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("일반 쇼핑몰 문의 회귀", () => {
  it("배송 상태로 좁힌 주문 목록은 건수와 카드가 같은 결과에서 나온다", async () => {
    const result = await chat("지금 배송 중인 주문 있어?", [{ name: "list_orders", args: { status: "in_transit" } }, finish]);
    expect(refs(result.result.orders)).toEqual(["STY-1001"]);
    expect(result.result.answer).toBe("배송 중인 주문 1건이에요.");
    const none = await chat("출고 전 주문 있어?", [{ name: "list_orders", args: { status: "preparing" } }, finish]);
    expect(refs(none.result.orders)).toEqual([]);
    expect(none.result.answer).toBe("출고 준비 중인 주문은 없어요.");
  });

  it("도구 없이 끝난 인사에는 주문번호 대신 도움말을 보여준다", async () => {
    const result = await chat("안녕하세요", [{ name: "finish", args: { outcome: "clarify" } }]);
    expect(result.result.answer).toContain("무엇을 확인할까요?");
    expect(result.result.answer).not.toContain("주문번호");
  });

  it("로그인이 필요한 조회만 보류되면 정책 답변이 주 답변이 된다", async () => {
    policyAnswer.mockResolvedValueOnce({ answer: "등록된 정책에서 답변 근거를 찾지 못했어요.", sources: [], abstained: true });
    const result = await chat("무통장 입금도 되나요?", [{ name: "search_policies", args: { query: "무통장 입금" } },
      { name: "offer_support", args: { orderReference: null, productHint: null, reason: "staff_requested" } }, finish], undefined, null);
    expect(result.supplementaryPolicy).toBeUndefined();
    expect(result.result.answer.startsWith("등록된 정책에서 답변 근거를 찾지 못했어요.")).toBe(true);
    expect(result.result.abstained).toBe(true);
  });

  it("반품 기한이 지난 주문은 사유를 묻지 않고 상담 확인으로 넘긴다", async () => {
    const result = await chat("STY-1008 반품해줘", [{ name: "prepare_return",
      args: { orderReference: "STY-1008", productHint: null, reason: null } }, finish]);
    expect(result.result.action).toMatchObject({ kind: "approval", action: "support" });
    expect(result.result.answer).toContain("수령 후 7일이 지나");
    expect(rpcCalls.find(({ name }) => name === "prepare_agent_action")?.args).toMatchObject({ p_kind: "support", p_reason: "policy_review" });
  });

  it("배송 전 주문은 사유를 묻거나 접수 초안을 만들지 않는다", async () => {
    const result = await chat("STY-1001 반품할래요", [{ name: "prepare_return",
      args: { orderReference: "STY-1001", productHint: null, reason: null } }, finish]);
    expect(result.result.answer).toContain("아직 배송 완료 전이에요.");
    expect(result.result.action).toBeUndefined();
    expect(rpcCalls.map(({ name }) => name)).not.toContain("prepare_agent_action");
  });

  it("직전 반품 가능 목록 밖의 상품을 지목해 이유를 물으면 같은 고객의 전체 주문에서 판정을 찾는다", async () => {
    const listed = await chat("반품 가능한 주문 보여줘", [{ name: "list_returnable_orders",
      args: { scope: "all_orders", orderReference: null, productHint: null } }, finish]);
    expect(refs(listed.result.orders)).toEqual(["STY-1002", "STY-1003", "STY-1006"]);
    const why = await chat("블랙 트윌 재킷은 왜 안 돼?", [{ name: "check_order_return_status",
      args: { scope: "previous_orders", orderReference: null, productHint: "블랙 트윌 재킷" } }, finish], listed.result.orders);
    expect(rpcCalls.slice(-2).map(({ args }) => args.p_presented)).toEqual([["STY-1002", "STY-1003", "STY-1006"], null]);
    expect(rpcCalls.at(-1)?.args).toMatchObject({ p_tenant: tenantId, p_customer: customerA });
    expect(refs(why.result.orders)).toEqual(["STY-1001"]);
    expect(why.result.answer).toContain("아직 배송 완료 전이에요.");
  });
});


import "server-only";
import { z } from "zod";
import type { Answer, RequestKind } from "@/lib/demo";
import { DemoError } from "./demo-core";
import { serverClient } from "./supabase";

const statusLabels = { preparing: "출고 준비 중", in_transit: "배송 중", delivered: "배송 완료", canceled: "주문 취소" } as const;
const orderSchema = z.object({
  id: z.uuid(), order_reference: z.string(), product_name: z.string(), ordered_at: z.string(),
  status: z.enum(["preparing", "in_transit", "delivered", "canceled"]), quantity: z.int().positive(),
  total_amount: z.int().nonnegative().nullable(), carrier: z.string().nullable(), tracking_number: z.string().nullable(),
});
type OrderRow = z.infer<typeof orderSchema>;

function toSummary(row: OrderRow) {
  return { reference: row.order_reference, name: row.product_name, orderedAt: row.ordered_at,
    status: statusLabels[row.status], quantity: row.quantity, total: row.total_amount };
}

function ordersFor(tenantId: string, customerId: string) {
  return serverClient().from("mock_orders")
    .select("id,order_reference,product_name,ordered_at,status,quantity,total_amount,carrier,tracking_number")
    .eq("tenant_id", tenantId).eq("customer_user_id", customerId);
}

const addressList = z.array(z.object({ id: z.uuid(), label: z.string(), summary: z.string(), isDefault: z.boolean() }));

// 저장된 합성 배송지만 보여준다. 고객은 카드에서 고르고, 모델은 결과에 나온 ID만 쓸 수 있다.
export async function listAddresses(tenantId: string, customerId: string): Promise<Answer> {
  const { data, error } = await serverClient().rpc("list_mock_addresses", { p_tenant: tenantId, p_customer: customerId });
  if (error) throw new DemoError(502, "저장된 배송지를 확인하지 못했어요.");
  const items = addressList.parse(data);
  return items.length
    ? { answer: "저장된 배송지 " + items.length + "곳이에요. 바꿀 배송지를 골라 주세요.", sources: [], abstained: false,
      toolUsed: "list_addresses", action: { kind: "addresses", items } }
    : { answer: "저장된 배송지가 없어요. 주문 상세에서 배송지를 먼저 등록해 주세요.", sources: [], abstained: true, toolUsed: "list_addresses" };
}

const requestList = z.array(z.object({
  id: z.uuid(), kind: z.enum(["return", "exchange", "cancel", "address", "ticket"]), reference: z.string().nullable(),
  name: z.string().nullable(), createdAt: z.string(), status: z.string(), fee: z.int().nullable(), detail: z.string().nullable(),
})).max(20);
// 받침이 있으면 "이에요", 없으면 "예요". 영문·숫자로 끝나면 "예요".
const copula = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code <= 11171 && code % 28 ? "이에요" : "예요");
};
const won = (value: number) => value.toLocaleString("ko-KR") + "원";

const requestLabels = { return: "반품", exchange: "교환", cancel: "주문 취소", address: "배송지 변경", ticket: "상담 문의" } as const;

async function readRequests(tenantId: string, customerId: string, kind: RequestKind | null, reference: string | null) {
  const { data, error } = await serverClient().rpc("list_mock_requests", { p_tenant: tenantId, p_customer: customerId, p_kind: kind, p_reference: reference });
  if (error) throw new DemoError(502, "접수 내역을 확인하지 못했어요.");
  return requestList.parse(data);
}

// 이미 접수한 반품·교환·취소·배송지 변경·상담 문의. 건수와 카드는 같은 결과에서 만든다.
export async function listRequests(tenantId: string, customerId: string, kind: RequestKind | null, reference: string | null = null): Promise<Answer> {
  const items = await readRequests(tenantId, customerId, kind, reference);
  const label = (reference ? reference + " " : "") + (kind ? requestLabels[kind] : "접수");
  return {
    answer: items.length ? `${label} 내역 ${items.length}건이에요.` : `${label} 내역이 없어요.`,
    orders: { kind: "requests", filter: kind, items }, sources: [], abstained: false, toolUsed: "list_requests",
  };
}

const detailSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), size: z.string().nullable(), address: z.string().nullable(),
    paymentMethod: z.string().nullable(), paidTotal: z.int().nullable() }),
  z.object({ status: z.literal("missing") }),
]);

// 주문 한 건의 사이즈·배송지·결제와 그 주문의 접수 내역.
export async function orderDetail(tenantId: string, customerId: string, reference: string | null, productHint: string | null): Promise<Answer> {
  const orders = await findCustomerOrders(tenantId, customerId, reference, productHint);
  if (!orders.length) {
    return { answer: "로그인한 고객의 주문에서 찾지 못했어요. 상품명이나 주문번호를 확인해 주세요.", sources: [], abstained: true, toolUsed: "get_order_detail" };
  }
  if (orders.length > 1) {
    return { answer: "상세를 확인할 주문을 골라 주세요.", orders: { kind: "history", items: orders.map(toSummary) },
      sources: [], abstained: false, toolUsed: "get_order_detail" };
  }
  const order = orders[0];
  const { data, error } = await serverClient().rpc("mock_order_detail", { p_tenant: tenantId, p_customer: customerId, p_reference: order.order_reference });
  if (error) throw new DemoError(502, "주문 상세를 확인하지 못했어요.");
  const detail = detailSchema.parse(data);
  if (detail.status === "missing") {
    return { answer: "로그인한 고객의 주문에서 찾지 못했어요.", sources: [], abstained: true, toolUsed: "get_order_detail" };
  }
  const { status: _status, ...info } = detail;
  void _status;
  const requests = await readRequests(tenantId, customerId, null, order.order_reference);
  const summary = toSummary(order);
  const facts = [
    `${info.size ?? "사이즈 기록 없음"} · ${order.quantity}개`,
    info.paidTotal !== null ? `결제 ${won(info.paidTotal)}${info.paymentMethod ? "(" + info.paymentMethod + ")" : ""}` : null,
    info.address ? `배송지 ${info.address}` : null,
  ].filter(Boolean).join(", ");
  const pending = requests.map((item) => `${requestLabels[item.kind]} ${item.status}${item.fee !== null ? "(반품비 " + won(item.fee) + ")" : ""}`);
  return {
    answer: [`${order.order_reference} ${order.product_name}: ${facts}. 지금 ${copula(summary.status)}.`,
      pending.length ? `이 주문의 접수 내역: ${pending.join(", ")}.` : null].filter(Boolean).join(" "),
    orders: { kind: "detail", order: summary, info, requests }, sources: [], abstained: false, toolUsed: "get_order_detail",
  };
}

export function orderLoginRequired(toolUsed: "list_orders" | "track_shipment" | "check_return_eligibility" | "list_requests" | "get_order_detail"): Answer {
  return { answer: "내 주문 정보를 보려면 데모 고객으로 로그인해 주세요.", sources: [], abstained: true, toolUsed };
}

const returnOrderSchema = orderSchema.extend({
  eligibility: z.enum(["eligible", "not_delivered", "too_late", "already_submitted", "review", "canceled"]),
});

const returnStatusMessages = {
  eligible: "지금 반품을 신청할 수 있어요.",
  not_delivered: "아직 배송 완료 전이에요. 상품을 받은 뒤 반품을 신청할 수 있어요.",
  too_late: "수령 후 7일이 지나 반품 신청 기한이 끝났어요.",
  already_submitted: "이 주문은 이미 반품을 접수했어요.",
  review: "반품 가능 여부를 확인하려면 상담원 확인이 필요해요.",
  canceled: "취소된 주문이라 반품 대상이 아니에요.",
};

type ReturnLookup = {
  reference?: string | null;
  productHint?: string | null;
  presented?: string[] | null;
  view: "eligible_only" | "order_statuses";
};

export async function listReturnEligibility(tenantId: string, customerId: string, {
  reference = null, productHint = null, presented = null, view,
}: ReturnLookup): Promise<Answer> {
  if (presented?.length === 0) {
    return { answer: "앞서 보여드린 주문이 없어요. 먼저 주문 내역을 확인해 주세요.", sources: [], abstained: true,
      toolUsed: "check_return_eligibility" };
  }
  const { data, error } = await serverClient().rpc("list_mock_return_eligibility", {
    p_tenant: tenantId, p_customer: customerId, p_reference: reference, p_product_hint: reference ? null : productHint, p_presented: presented,
  });
  if (error) throw new DemoError(502, "주문별 반품 가능 여부를 확인하지 못했어요.");
  const rows = z.array(returnOrderSchema).parse(data);
  const matching = view === "eligible_only" ? rows.filter((row) => row.eligibility === "eligible") : rows;
  const items = matching.map((row) => ({ ...toSummary(row), eligibility: row.eligibility }));
  const scope = rows.length === 20 ? "최근 주문 20건 중 " : "";
  let answer = "로그인한 고객의 주문에서 찾지 못했어요.";
  if (rows.length && view === "eligible_only") {
    answer = items.length ? `${scope}지금 반품을 신청할 수 있는 주문은 ${items.length}건이에요.`
      : `${scope}지금 반품을 신청할 수 있는 주문은 없어요.`;
  } else if (matching.length === 1) {
    answer = returnStatusMessages[matching[0].eligibility];
  } else if (matching.length) {
    const reasons = { eligible: "반품 가능", not_delivered: "아직 배송 완료 전", too_late: "반품 기한 지남",
      already_submitted: "이미 반품 접수됨", review: "상담원 확인 필요", canceled: "취소된 주문" } as const;
    answer = `주문 ${items.length}건을 확인했어요. ` + (items.length <= 5
      ? items.map((item) => `${item.reference} ${item.name}: ${reasons[item.eligibility]}`).join(", ") + "."
      : "주문별 판정은 아래 목록에서 확인해 주세요.");
  }
  return { answer, sources: [], abstained: !rows.length, toolUsed: "check_return_eligibility",
    orders: { kind: "return_eligibility", items } };
}

// status가 있으면 DB에서 해당 배송 상태만 조회한다. 답변 건수와 카드는 같은 결과에서 만든다.
// 한 주문의 현재 반품 판정만 DB 함수로 확인한다. 고객 범위는 호출자가 서버에서 바인딩한다.
export async function returnEligibilityOf(tenantId: string, customerId: string, reference: string) {
  const { data, error } = await serverClient().rpc("list_mock_return_eligibility", {
    p_tenant: tenantId, p_customer: customerId, p_reference: reference, p_product_hint: null, p_presented: null,
  });
  if (error) throw new DemoError(502, "주문별 반품 가능 여부를 확인하지 못했어요.");
  return z.array(returnOrderSchema).parse(data)[0]?.eligibility ?? null;
}

export async function listOrders(tenantId: string, customerId: string, status: OrderRow["status"] | null = null): Promise<Answer> {
  const scoped = ordersFor(tenantId, customerId);
  const { data, error } = await (status ? scoped.eq("status", status) : scoped)
    .order("ordered_at", { ascending: false }).order("id", { ascending: false }).limit(20);
  if (error) throw new DemoError(502, "주문 내역을 조회하지 못했어요.");
  const orders = z.array(orderSchema).parse(data).map(toSummary);
  const label = status ? `${statusLabels[status]}인 주문` : "최근 주문";
  return {
    answer: orders.length ? `${label} ${orders.length}건이에요.` : status ? `${statusLabels[status]}인 주문은 없어요.` : "조회할 주문 내역이 없어요.",
    orders: { kind: "history", items: orders }, sources: [], abstained: false, toolUsed: "list_orders",
  };
}

const time = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
});

export async function trackShipment(tenantId: string, customerId: string, reference: string | null, productHint: string | null): Promise<Answer> {
  const orders = await findCustomerOrders(tenantId, customerId, reference, productHint);
  if (!orders.length) {
    return { answer: "로그인한 고객의 주문에서 찾지 못했어요. 상품명이나 주문번호를 확인해 주세요.", sources: [], abstained: true, toolUsed: "track_shipment" };
  }
  // 같은 상품 주문이 여러 건이어도 배송 중인 주문이 하나뿐이면 그 주문을 추적한다. 그 외에는 고객이 고르게 한다.
  const moving = orders.filter((order) => order.status === "in_transit");
  const order = orders.length === 1 ? orders[0] : moving.length === 1 ? moving[0] : null;
  if (!order) {
    return { answer: "배송을 확인할 주문번호를 알려주세요.", orders: { kind: "history", items: orders.map(toSummary) },
      sources: [], abstained: false, toolUsed: "track_shipment" };
  }

  const events = await serverClient().from("mock_shipment_events").select("occurred_at,location,description")
    .eq("tenant_id", tenantId).eq("order_id", order.id).order("occurred_at", { ascending: false }).limit(6);
  if (events.error) throw new DemoError(502, "택배 이동 기록을 읽지 못했어요.");
  const history = z.array(z.object({ occurred_at: z.string(), location: z.string(), description: z.string() }))
    .parse(events.data).map(({ occurred_at, location, description }) => ({ occurredAt: occurred_at, location, description }));
  const last = history[0];

  return {
    answer: last
      ? `마지막 스캔 위치는 ${copula(last.location)}. ${time.format(new Date(last.occurredAt))}에 ${last.description} 기록이 남았어요.`
        + (order.tracking_number ? ` 운송장 번호는 ${order.carrier ? order.carrier + " " : ""}${order.tracking_number}이에요.` : "")
      : `${order.product_name}은 ${statusLabels[order.status]}이에요. 아직 확인할 수 있는 택배 스캔 기록은 없어요.`,
    orders: { kind: "shipment", order: toSummary(order), carrier: order.carrier, trackingNumber: order.tracking_number, events: history },
    sources: [], abstained: false, toolUsed: "track_shipment",
  };
}

async function findCustomerOrders(tenantId: string, customerId: string, reference: string | null, productHint: string | null) {
  const scoped = ordersFor(tenantId, customerId);
  const lookup = reference ? scoped.eq("order_reference", reference)
    : productHint ? scoped.ilike("product_name", "%" + productHint + "%") : scoped;
  const { data, error } = await lookup.order("ordered_at", { ascending: false }).order("id", { ascending: false }).limit(5);
  if (error) throw new DemoError(502, "주문 정보를 조회하지 못했어요.");
  return z.array(orderSchema).parse(data);
}

export async function findActionOrders(tenantId: string, customerId: string, reference: string | null, productHint: string | null) {
  return (await findCustomerOrders(tenantId, customerId, reference, productHint))
    .map((order) => ({ id: order.id, summary: toSummary(order) }));
}

import "server-only";
import { z } from "zod";
import type { Answer } from "@/lib/demo";
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

export function orderLoginRequired(toolUsed: "list_orders" | "track_shipment" | "check_return_eligibility"): Answer {
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
    answer = `주문 ${items.length}건의 반품 가능 여부를 확인했어요.`;
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
      ? `마지막 스캔 위치는 ${last.location}이에요. ${time.format(new Date(last.occurredAt))}에 ${last.description} 기록이 남았어요.`
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

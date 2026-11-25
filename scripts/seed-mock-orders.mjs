import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const day = 86_400_000;
const additionalOrders = [
  ["STY-1003", "크림 코튼 셔츠", "delivered", 4, 2, 39000],
  ["STY-1004", "인디고 스트레이트 데님", "preparing", 0, null, 54000],
  ["STY-1005", "아이보리 립 니트", "in_transit", 2, 1, 42000],
  ["STY-1006", "베이지 와이드 치노", "delivered", 17, 14, 49000],
  ["STY-1007", "네이비 린넨 셔츠", "delivered", 6, 3, 45000],
  ["STY-1008", "네이비 린넨 셔츠", "delivered", 32, 28, 45000],
  ["STY-1009", "그레이 테이퍼드 슬랙스", "delivered", 13, null, 52000],
  ["STY-1010", "블랙 코튼 카디건", "delivered", 10, 5, 58000],
  ["STY-1011", "화이트 스트라이프 티셔츠", "delivered", 42, 39, 28000],
  ["STY-1012", "브라운 레더 벨트", "delivered", 52, 48, 25000],
  ["STY-2002", "라이트 블루 린넨 셔츠", "preparing", 1, null, 45000],
  ["STY-2003", "스톤 칼라 재킷", "in_transit", 3, 1, 79000],
  ["STY-2004", "오프화이트 와이드 데님", "delivered", 5, 2, 55000],
  ["STY-2005", "와인 브이넥 니트", "delivered", 15, 11, 49000],
  ["STY-2006", "차콜 울 카디건", "delivered", 8, 5, 62000],
  ["STY-2007", "올리브 코튼 팬츠", "delivered", 22, null, 48000],
  ["STY-2008", "블랙 코듀로이 셔츠", "delivered", 38, 34, 52000],
];

async function seed() {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid");
  const key = process.env.SUPABASE_SECRET_KEY;
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !key) throw Error("로컬 Supabase만 지원합니다.");
  const client = createClient(url.origin, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const tenant = await client.from("tenants").select("id").eq("public_widget_key", "202dbac4609c4aaa9a7cd4ea0aa604a5")
    .eq("name", "Style Shop").eq("is_active", true).maybeSingle();
  if (tenant.error || !tenant.data) throw Error("Style Shop 시연 업체를 찾지 못했습니다.");

  const fixtures = [
    { email: "style-customer-a@example.com", reference: "STY-1001", product: "블랙 트윌 재킷", status: "in_transit",
      orderedAt: "2026-11-20T06:00:00Z", total: 69000, tracking: "DEMO-1001", events: [
        ["2026-11-21T08:20:00Z", "성수 집화점", "상품 접수"],
        ["2026-11-22T00:40:00Z", "군포 물류센터", "분류 완료"],
        ["2026-11-22T05:18:00Z", "군포 물류센터", "간선 차량 상차"],
      ] },
    { email: "style-customer-a@example.com", reference: "STY-1002", product: "차콜 플리츠 팬츠", status: "delivered",
      orderedAt: "2026-11-14T04:00:00Z", total: 59000, tracking: "DEMO-1002",
      events: [["2026-11-17T02:29:00Z", "서울 광진 배송점", "배달 완료"]] },
    { email: "style-customer-b@example.com", reference: "STY-2001", product: "아이보리 옥스퍼드 셔츠", status: "delivered",
      orderedAt: "2026-11-17T06:00:00Z", total: 49000, tracking: "DEMO-2001",
      events: [["2026-11-20T06:20:00Z", "서울 마포 배송점", "배달 완료"]] },
  ];
  const demoCustomers = new Set(fixtures.map((fixture) => fixture.email));
  const existing = new Map();
  for (let page = 1; ; page++) {
    const users = await client.auth.admin.listUsers({ page, perPage: 100 });
    if (users.error) throw Error("로컬 데모 고객을 확인하지 못했습니다.");
    for (const user of users.data.users) {
      if (fixtures.some((fixture) => fixture.email === user.email)) existing.set(user.email, user.id);
    }
    if (users.data.users.length < 100 || existing.size === demoCustomers.size) break;
  }

  for (const fixture of fixtures) {
    let id = existing.get(fixture.email);
    if (!id) {
      const created = await client.auth.admin.createUser({
        email: fixture.email, password: "StyleShop-Demo-2026!", email_confirm: true,
      });
      if (created.error || !created.data.user) throw Error("로컬 데모 고객을 등록하지 못했습니다.");
      id = created.data.user.id;
      existing.set(fixture.email, id);
    }
    const order = await client.from("mock_orders").upsert({
      tenant_id: tenant.data.id, customer_user_id: id, order_reference: fixture.reference,
      product_name: fixture.product, ordered_at: fixture.orderedAt, status: fixture.status, quantity: 1,
      total_amount: fixture.total, carrier: "한빛택배", tracking_number: fixture.tracking,
    }, { onConflict: "tenant_id,order_reference" }).select("id").single();
    if (order.error) throw Error("모의 주문을 등록하지 못했습니다.");
    const events = await client.from("mock_shipment_events").upsert(
      fixture.events.map(([occurred_at, location, description]) => ({
        tenant_id: tenant.data.id, order_id: order.data.id, occurred_at, location, description,
      })), { onConflict: "tenant_id,order_id,occurred_at" });
    if (events.error) throw Error("모의 택배 스캔을 등록하지 못했습니다.");
  }

  // 시드 재실행 시 기존 주문일과 구매자의 반품 기록을 보존한다.
  const seedTime = Date.now();
  for (const [reference, product, status, orderedDaysAgo, scanDaysAgo, total] of additionalOrders) {
    const email = reference.startsWith("STY-1") ? "style-customer-a@example.com" : "style-customer-b@example.com";
    const customerId = existing.get(email);
    const inserted = await client.from("mock_orders").upsert({
      tenant_id: tenant.data.id, customer_user_id: customerId, order_reference: reference, product_name: product,
      ordered_at: new Date(seedTime - orderedDaysAgo * day).toISOString(), status, total_amount: total,
      carrier: status === "preparing" ? null : "한빛택배",
      tracking_number: status === "preparing" ? null : reference.replace("STY-", "DEMO-"),
    }, { onConflict: "tenant_id,order_reference", ignoreDuplicates: true }).select("id,ordered_at").maybeSingle();
    if (inserted.error) throw Error("추가 모의 주문을 등록하지 못했습니다.");
    if (scanDaysAgo === null) continue;
    let order = inserted.data;
    if (!order) {
      const saved = await client.from("mock_orders").select("id,ordered_at")
        .eq("tenant_id", tenant.data.id).eq("customer_user_id", customerId).eq("order_reference", reference).single();
      if (saved.error) throw Error("추가 모의 주문을 확인하지 못했습니다.");
      order = saved.data;
    }
    const scan = await client.from("mock_shipment_events").upsert({
      tenant_id: tenant.data.id, order_id: order.id,
      occurred_at: new Date(Date.parse(order.ordered_at) + (orderedDaysAgo - scanDaysAgo) * day).toISOString(),
      location: status === "delivered" ? "서울 배송점" : "군포 물류센터",
      description: status === "delivered" ? "배달 완료" : "간선 차량 상차",
    }, { onConflict: "tenant_id,order_id,occurred_at", ignoreDuplicates: true });
    if (scan.error) throw Error("추가 모의 배송 기록을 등록하지 못했습니다.");
  }

  // 합성 배송지. 채팅의 배송지 변경은 이 목록에서만 고른다.
  const places = [["집", "서울 마포구 합정동 (합성 주소)", true], ["회사", "서울 중구 을지로 (합성 주소)", false]];
  for (const email of demoCustomers) {
    const saved = await client.from("mock_addresses").upsert(places.map(([label, summary, isDefault]) => ({
      tenant_id: tenant.data.id, customer_user_id: existing.get(email), label, summary, is_default: isDefault,
    })), { onConflict: "tenant_id,customer_user_id,label" });
    if (saved.error) throw Error("합성 배송지를 등록하지 못했습니다.");
  }

  console.log(`Style Shop 로컬 데모 고객 2명과 기본 모의 주문 ${fixtures.length + additionalOrders.length}건을 확인했습니다.`);

  if (process.argv.includes("--fresh-return")) {
    const customer = "style-customer-b@example.com";
    const reference = "STY-" + randomInt(10_000_000, 100_000_000);
    const orderedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const deliveredAt = new Date(Date.now() - 86_400_000).toISOString();
    const order = await client.from("mock_orders").insert({
      tenant_id: tenant.data.id, customer_user_id: existing.get(customer), order_reference: reference,
      product_name: "반품 시연용 데님 셔츠", ordered_at: orderedAt, status: "delivered", quantity: 1, total_amount: 49000,
    }).select("id").single();
    if (order.error) throw Error("신규 반품 시연 주문을 등록하지 못했습니다.");
    const event = await client.from("mock_shipment_events").insert({
      tenant_id: tenant.data.id, order_id: order.data.id, occurred_at: deliveredAt,
      location: "서울 마포 배송점", description: "배달 완료",
    });
    if (event.error) throw Error("신규 반품 시연 주문의 배송 기록을 등록하지 못했습니다.");
    console.log(`반품 시연 주문 ${reference} · ${customer}`);
  }
}

seed().catch((error) => {
  console.error(error instanceof Error ? error.message : "모의 주문 초기화에 실패했습니다.");
  process.exitCode = 1;
});

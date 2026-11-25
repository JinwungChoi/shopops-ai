// 공개 데모 스냅샷: 시드를 넣은 직후 한 번 실행한다. 매일 04:00 KST pg_cron이 이 상태로 되돌린다.
// 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY (값은 출력하지 않는다).
import { createClient } from "@supabase/supabase-js";

const widget = "202dbac4609c4aaa9a7cd4ea0aa604a5";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw Error("NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SECRET_KEY가 필요합니다.");
const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const shop = await client.from("tenants").select("id").eq("public_widget_key", widget).single();
if (shop.error) throw Error("Style Shop을 찾지 못했습니다. 시드를 먼저 실행하세요.");
const { data, error } = await client.rpc("take_demo_snapshot", { p_tenant: shop.data.id });
if (error) throw Error("스냅샷을 만들지 못했습니다: " + error.message);
console.log(`Style Shop 데모 스냅샷 저장 · 주문 ${data.orders}건 · 매일 04:00 KST에 이 상태로 초기화`);

// Style Shop 합성 상품·옵션 재고를 로컬 Supabase에 넣는다. 재고는 demo/catalog.json 값으로 되돌린다.
// 실행: 로컬 NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SECRET_KEY를 지정한 뒤 node scripts/seed-catalog.mjs
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const product = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/), name: z.string().min(1).max(100),
  category: z.enum(["jacket", "shirt", "trousers", "knit", "coat", "accessory"]), color: z.string().regex(/^[a-z]{3,20}$/),
  price: z.int().min(0), releasedAt: z.iso.date(), isNew: z.boolean(), material: z.string().max(200), fit: z.string().max(200),
  care: z.string().max(200), image: z.string().nullable(),
  options: z.array(z.object({ size: z.enum(["S", "M", "L", "XL", "FREE"]), stock: z.int().min(0) })).min(1),
});

const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid");
const secret = process.env.SUPABASE_SECRET_KEY;
if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !secret) {
  throw Error("격리된 로컬 Supabase 설정이 필요합니다.");
}
const client = createClient(url.origin, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const { style } = z.object({ style: z.array(product) }).parse(JSON.parse(await readFile(new URL("../demo/catalog.json", import.meta.url), "utf8")));
const tenant = await client.from("tenants").select("id").eq("public_widget_key", "202dbac4609c4aaa9a7cd4ea0aa604a5").eq("is_active", true).single();
if (tenant.error) throw Error("Style Shop 로컬 업체를 찾지 못했습니다.");
const tenantId = tenant.data.id;

const products = await client.from("mock_products").upsert(style.map((item) => ({
  tenant_id: tenantId, id: item.id, name: item.name, category: item.category, color: item.color, price: item.price,
  released_at: item.releasedAt, is_new: item.isNew, material: item.material, fit: item.fit, care: item.care, image: item.image, is_active: true,
})), { onConflict: "tenant_id,id" });
if (products.error) throw Error("상품을 저장하지 못했습니다: " + products.error.message);
const options = await client.from("mock_product_options").upsert(style.flatMap((item) => item.options.map((option) => ({
  tenant_id: tenantId, product_id: item.id, size: option.size, stock: option.stock,
}))), { onConflict: "tenant_id,product_id,size" });
if (options.error) throw Error("옵션 재고를 저장하지 못했습니다: " + options.error.message);

// 기존 합성 주문은 같은 이름의 상품과 연결한다(교환 기능에서 사용).
let linked = 0;
for (const item of style) {
  const { data, error } = await client.from("mock_orders").update({ product_id: item.id })
    .eq("tenant_id", tenantId).eq("product_name", item.name).is("product_id", null).select("id");
  if (error) throw Error("주문과 상품을 연결하지 못했습니다.");
  linked += data.length;
}
console.log(`Style Shop · 상품 ${style.length}개 · 옵션 ${style.reduce((n, item) => n + item.options.length, 0)}개 · 연결한 기존 주문 ${linked}건`);

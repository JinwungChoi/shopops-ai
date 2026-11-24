begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(25);

-- 모든 데이터는 트랜잭션 안의 합성 값이며 마지막에 롤백한다.
insert into public.tenants (name, slug, public_widget_key)
values ('Shopping test', 'shopping-rollback', '202dbac4609c4aaa9a7cd4ea0aa604a5')
on conflict (public_widget_key) do nothing;
create temporary table shop_fixture as
  select id as tenant,
    '11000000-0000-4000-8000-000000000001'::uuid as customer,
    '11000000-0000-4000-8000-000000000002'::uuid as other,
    '21000000-0000-4000-8000-000000000001'::uuid as session_id,
    '21000000-0000-4000-8000-000000000002'::uuid as other_session
  from public.tenants where public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5';
insert into auth.users(id,email)
  select customer,'shopping-test-a@example.invalid' from shop_fixture union all
  select other,'shopping-test-b@example.invalid' from shop_fixture;
insert into public.chat_sessions(id,tenant_id,customer_user_id,token_hash,expires_at)
  select session_id,tenant,customer,'shop-test-a',now()+interval '20 minutes' from shop_fixture union all
  select other_session,tenant,other,'shop-test-b',now()+interval '20 minutes' from shop_fixture;
insert into public.mock_products(tenant_id,id,name,category,color,price,released_at,material,fit,care)
  select tenant,'test-coat','검증 코트','coat','black',40000,current_date,'울','레귤러','드라이' from shop_fixture union all
  select tenant,'test-shirt','검증 셔츠','shirt','white',20000,current_date,'면','레귤러','세탁기' from shop_fixture;
insert into public.mock_product_options(tenant_id,product_id,size,stock)
  select tenant,'test-coat','M',3 from shop_fixture union all
  select tenant,'test-coat','L',0 from shop_fixture union all
  select tenant,'test-shirt','M',5 from shop_fixture;

-- 권한: 고객 역할은 테이블과 함수를 직접 쓸 수 없다.
select extensions.ok(not has_table_privilege('authenticated','public.mock_cart_items','SELECT'), '고객이 장바구니 테이블을 직접 읽을 수 없음');
select extensions.ok(not has_table_privilege('anon','public.mock_product_options','UPDATE'), '익명 사용자가 재고를 직접 바꿀 수 없음');
select extensions.ok(not has_function_privilege('authenticated','public.update_mock_cart(uuid,uuid,uuid,text,text,text,integer,text)','EXECUTE'), '고객이 장바구니 RPC를 직접 실행할 수 없음');
select extensions.ok(not has_function_privilege('anon','public.prepare_mock_checkout(uuid,uuid,uuid)','EXECUTE'), '익명 사용자가 주문 초안 RPC를 실행할 수 없음');
select extensions.ok(not has_function_privilege('authenticated','public.confirm_mock_checkout(uuid,uuid,uuid,uuid)','EXECUTE'), '고객이 주문 확정 RPC를 직접 실행할 수 없음');

-- 장바구니: 세션 소유자만, 재고·수량 한도 안에서, 같은 요청은 한 번만 반영한다.
select extensions.is(public.update_mock_cart(tenant,other_session,customer,'r0','test-coat','M',1,'add')->>'status','missing','다른 고객 세션으로 장바구니 변경 차단') from shop_fixture;
select extensions.is(public.update_mock_cart(tenant,session_id,customer,'r1','test-coat','M',1,'add')->>'status','ok','장바구니 담기') from shop_fixture;
select extensions.is(public.update_mock_cart(tenant,session_id,customer,'r1','test-coat','M',1,'add')->>'status','duplicate','같은 요청 재전송은 중복 반영하지 않음') from shop_fixture;
select extensions.is((select quantity from public.mock_cart_items where customer_user_id = customer and product_id = 'test-coat'),1,'재전송 후 수량 유지') from shop_fixture;
select extensions.is(public.update_mock_cart(tenant,session_id,customer,'r2','test-coat','L',1,'add')->>'status','out_of_stock','품절 옵션 담기 차단') from shop_fixture;
select extensions.is(public.update_mock_cart(tenant,session_id,customer,'r3','test-coat','M',5,'add')->>'status','out_of_stock','재고보다 많이 담기 차단') from shop_fixture;
select extensions.is(public.update_mock_cart(tenant,session_id,customer,'r4','test-coat','XL',1,'add')->>'status','not_found','없는 옵션 차단') from shop_fixture;
select extensions.is(public.update_mock_cart(tenant,session_id,customer,'r5','test-shirt','M',1,'add')->>'status','ok','두 번째 상품 담기') from shop_fixture;
select extensions.is(jsonb_array_length(public.mock_cart_view(tenant,other)->'lines'),0,'다른 고객의 장바구니에는 보이지 않음') from shop_fixture;
select extensions.is((public.mock_cart_view(tenant,customer)->>'total')::integer,60000,'가격은 상품 테이블 기준, 5만 원 이상 무료배송') from shop_fixture;

-- 주문: 초안은 주문을 만들지 않고, 확정 시 재고 차감과 장바구니 비우기가 한 번만 일어난다.
create temporary table shop_checkout as
  select (public.prepare_mock_checkout(tenant,session_id,customer)->>'id')::uuid as approval from shop_fixture;
select extensions.is((select count(*)::int from public.mock_orders where customer_user_id = customer),0,'초안 단계에서는 주문 없음') from shop_fixture;
select extensions.is(public.decide_agent_action(tenant,other_session,other,approval,true,false)->>'status','missing','다른 고객이 주문 승인 불가') from shop_checkout, shop_fixture;
update public.mock_products set price = 45000 where id = 'test-coat';
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'status','cart_changed','초안 후 가격이 바뀌면 확정 거부') from shop_checkout, shop_fixture;
update public.mock_products set price = 40000 where id = 'test-coat';
create temporary table shop_checkout2 as
  select (public.prepare_mock_checkout(tenant,session_id,customer)->>'id')::uuid as approval from shop_fixture;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'status','confirmed','고객 확인 후 주문 생성') from shop_checkout2, shop_fixture;
select extensions.is((select count(*)::int from public.mock_orders where customer_user_id = customer and status = 'preparing'),2,'장바구니 줄마다 출고 준비 주문 생성') from shop_fixture;
select extensions.is((select stock from public.mock_product_options where product_id = 'test-coat' and size = 'M'),2,'재고 차감') from shop_fixture;
select extensions.is(jsonb_array_length(public.mock_cart_view(tenant,customer)->'lines'),0,'주문 후 장바구니 비움') from shop_fixture;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'receipt',
  (select id::text from public.mock_checkouts where approval_id = approval),'같은 승인 재시도는 같은 주문 반환') from shop_checkout2, shop_fixture;
select extensions.is((select stock from public.mock_product_options where product_id = 'test-coat' and size = 'M'),2,'재시도해도 재고 한 번만 차감') from shop_fixture;
select extensions.is(public.prepare_mock_checkout(tenant,session_id,customer)->>'status','empty','빈 장바구니는 주문 초안 불가') from shop_fixture;

select * from extensions.finish();
rollback;

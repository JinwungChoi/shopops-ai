begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(16);

-- 모든 데이터는 트랜잭션 안의 합성 값이며 마지막에 롤백한다.
insert into public.tenants (id, name, slug, public_widget_key)
values ('a1000000-0000-4000-8000-000000000001', 'Demo guard test', 'demo-guard-rollback', 'd1000000000000000000000000000001');
create temporary table g as select 'a1000000-0000-4000-8000-000000000001'::uuid as tenant,
  'a2000000-0000-4000-8000-000000000001'::uuid as customer,
  'a3000000-0000-4000-8000-000000000001'::uuid as seed_session,
  'a3000000-0000-4000-8000-000000000002'::uuid as new_session;
insert into auth.users(id,email) select customer,'demo-guard@example.invalid' from g;
insert into public.chat_sessions(id,tenant_id,customer_user_id,token_hash,expires_at)
  select seed_session,tenant,customer,'dg-seed',now()+interval '1 day' from g;
insert into public.mock_products(tenant_id,id,name,category,color,price,released_at,material,fit,care)
  select tenant,'dg-shirt','가드 검증 셔츠','shirt','white',30000,current_date,'면','레귤러','세탁기' from g;
insert into public.mock_product_options(tenant_id,product_id,size,stock)
  select tenant,'dg-shirt','M',5 from g;
insert into public.mock_orders(id,tenant_id,customer_user_id,order_reference,product_name,ordered_at,status,quantity,product_id,option_size)
  select 'a4000000-0000-4000-8000-000000000001'::uuid,tenant,customer,'STY-88000001','가드 검증 셔츠',now()-interval '3 days','delivered',1,'dg-shirt','M' from g union all
  select 'a4000000-0000-4000-8000-000000000002'::uuid,tenant,customer,'STY-88000002','가드 검증 셔츠',now()-interval '10 minutes','preparing',1,'dg-shirt','M' from g;
insert into public.mock_shipment_events(tenant_id,order_id,occurred_at,location,description)
  select tenant,'a4000000-0000-4000-8000-000000000001'::uuid,now()-interval '2 days','서울 배송점','배달 완료' from g;

-- 권한: 고객·익명 역할은 한도·스냅샷·초기화 함수를 실행할 수 없다.
select extensions.ok(not has_function_privilege('authenticated','public.take_daily_budget(text,integer)','EXECUTE'), '고객이 하루 한도 함수를 직접 실행할 수 없음');
select extensions.ok(not has_function_privilege('anon','public.reset_demo(uuid)','EXECUTE'), '익명 사용자가 데모 초기화를 실행할 수 없음');
select extensions.ok(not has_function_privilege('authenticated','public.take_demo_snapshot(uuid)','EXECUTE'), '고객이 스냅샷을 만들 수 없음');

-- 하루 한도: 한도까지만 통과한다.
select extensions.ok(public.take_daily_budget(repeat('a',64),2), '하루 한도 1회차 통과');
select extensions.ok(public.take_daily_budget(repeat('a',64),2), '하루 한도 2회차 통과');
select extensions.ok(not public.take_daily_budget(repeat('a',64),2), '하루 한도를 넘으면 거부');

select extensions.is(public.reset_demo(tenant)->>'status','snapshot_missing','스냅샷이 없으면 초기화하지 않음') from g;
select extensions.is(public.take_demo_snapshot(tenant)->>'status','ok','시드 직후 스냅샷') from g;

-- 스냅샷 이후의 시연: 새 대화, 주문 취소, 재고 변화, 새 채팅 주문, 장바구니.
insert into public.chat_sessions(id,tenant_id,customer_user_id,token_hash,expires_at)
  select new_session,tenant,customer,'dg-new',now()+interval '1 day' from g;
update public.mock_orders set status = 'canceled' where id = 'a4000000-0000-4000-8000-000000000002';
update public.mock_product_options set stock = 1 where product_id = 'dg-shirt';
insert into public.mock_orders(id,tenant_id,customer_user_id,order_reference,product_name,ordered_at,status,quantity,product_id,option_size)
  select 'a4000000-0000-4000-8000-000000000003'::uuid,tenant,customer,'STY-88000003','가드 검증 셔츠',now(),'preparing',1,'dg-shirt','M' from g;
insert into public.mock_cart_items(tenant_id,customer_user_id,product_id,size,quantity) select tenant,customer,'dg-shirt','M',2 from g;
-- 스냅샷이 하루 전에 찍힌 것처럼 옮겨, 초기화 뒤에도 주문 경과 시간이 유지되는지 본다.
update private.demo_snapshots set taken_at = taken_at - interval '1 day',
  orders = (select jsonb_agg(o || jsonb_build_object('ordered_at', (o->>'ordered_at')::timestamptz - interval '1 day')) from jsonb_array_elements(orders) o)
  where tenant_id = (select tenant from g);

select extensions.is(public.reset_demo(tenant)->>'status','ok','초기화 실행') from g;
select extensions.is((select count(*)::int from public.mock_orders where tenant_id = (select tenant from g)),2,'채팅으로 생긴 주문 삭제');
select extensions.is((select status from public.mock_orders where id = 'a4000000-0000-4000-8000-000000000002'),'preparing','취소한 주문 상태 복구');
select extensions.is((select stock from public.mock_product_options where product_id = 'dg-shirt'),5,'재고 복구');
select extensions.ok((select count(*) = 0 from public.chat_sessions where id = (select new_session from g))
  and (select count(*) = 1 from public.chat_sessions where id = (select seed_session from g))
  and (select count(*) = 0 from public.mock_cart_items where tenant_id = (select tenant from g)), '새 대화와 장바구니만 삭제, 시드 대화는 유지');
select extensions.ok((select ordered_at > now() - interval '3 days 1 minute' and ordered_at < now() - interval '2 days 23 hours'
  from public.mock_orders where id = 'a4000000-0000-4000-8000-000000000001'), '주문 시각은 지금 기준 3일 전으로 유지');

select extensions.ok(not has_function_privilege('anon','public.reset_all_demos()','EXECUTE'), '익명 사용자가 전체 초기화를 실행할 수 없음');
select extensions.is((select schedule from cron.job where jobname = 'shopops-demo-reset'),'0 19 * * *','매일 04:00 KST 초기화 작업 등록');
select * from extensions.finish();
rollback;

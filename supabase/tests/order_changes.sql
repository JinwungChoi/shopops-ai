begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(26);

-- 모든 데이터는 트랜잭션 안의 합성 값이며 마지막에 롤백한다.
insert into public.tenants (name, slug, public_widget_key)
values ('Order change test', 'order-change-rollback', '202dbac4609c4aaa9a7cd4ea0aa604a5')
on conflict (public_widget_key) do nothing;
create temporary table oc as
  select id as tenant,
    '12000000-0000-4000-8000-000000000001'::uuid as customer,
    '12000000-0000-4000-8000-000000000002'::uuid as other,
    '22000000-0000-4000-8000-000000000001'::uuid as session_id,
    '22000000-0000-4000-8000-000000000002'::uuid as other_session
  from public.tenants where public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5';
insert into auth.users(id,email)
  select customer,'order-change-a@example.invalid' from oc union all
  select other,'order-change-b@example.invalid' from oc;
insert into public.chat_sessions(id,tenant_id,customer_user_id,token_hash,expires_at)
  select session_id,tenant,customer,'oc-a',now()+interval '20 minutes' from oc union all
  select other_session,tenant,other,'oc-b',now()+interval '20 minutes' from oc;
insert into public.mock_products(tenant_id,id,name,category,color,price,released_at,material,fit,care)
  select tenant,'oc-shirt','변경 검증 셔츠','shirt','white',30000,current_date,'면','레귤러','세탁기' from oc;
insert into public.mock_product_options(tenant_id,product_id,size,stock)
  select tenant,'oc-shirt','M',2 from oc union all
  select tenant,'oc-shirt','L',1 from oc union all
  select tenant,'oc-shirt','XL',0 from oc;
insert into public.mock_addresses(id,tenant_id,customer_user_id,label,summary,is_default)
  select '32000000-0000-4000-8000-000000000001'::uuid,tenant,customer,'집','서울 마포구 (합성)',true from oc union all
  select '32000000-0000-4000-8000-000000000002'::uuid,tenant,customer,'회사','서울 중구 (합성)',false from oc union all
  select '32000000-0000-4000-8000-000000000003'::uuid,tenant,other,'집','부산 해운대구 (합성)',true from oc;
insert into public.mock_orders(id,tenant_id,customer_user_id,order_reference,product_name,ordered_at,status,quantity,product_id,option_size)
  select '42000000-0000-4000-8000-000000000001'::uuid,tenant,customer,'STY-77000001','변경 검증 셔츠',now()-interval '5 minutes','preparing',1,'oc-shirt','M' from oc union all
  select '42000000-0000-4000-8000-000000000002'::uuid,tenant,customer,'STY-77000002','변경 검증 셔츠',now()-interval '2 hours','preparing',1,'oc-shirt','M' from oc union all
  select '42000000-0000-4000-8000-000000000003'::uuid,tenant,customer,'STY-77000003','변경 검증 셔츠',now()-interval '3 days','in_transit',1,'oc-shirt','M' from oc union all
  select '42000000-0000-4000-8000-000000000004'::uuid,tenant,customer,'STY-77000004','변경 검증 셔츠',now()-interval '3 days','delivered',1,'oc-shirt','M' from oc union all
  select '42000000-0000-4000-8000-000000000005'::uuid,tenant,customer,'STY-77000005','변경 검증 셔츠',now()-interval '12 days','delivered',1,'oc-shirt','M' from oc union all
  select '42000000-0000-4000-8000-000000000006'::uuid,tenant,customer,'STY-77000006','변경 검증 셔츠',now()-interval '3 days','delivered',1,'oc-shirt',null from oc;
insert into public.mock_shipment_events(tenant_id,order_id,occurred_at,location,description)
  select tenant,'42000000-0000-4000-8000-000000000004'::uuid,now()-interval '2 days','서울 배송점','배달 완료' from oc union all
  select tenant,'42000000-0000-4000-8000-000000000005'::uuid,now()-interval '10 days','서울 배송점','배달 완료' from oc union all
  select tenant,'42000000-0000-4000-8000-000000000006'::uuid,now()-interval '2 days','서울 배송점','배달 완료' from oc;

-- 권한: 고객 역할은 변경 함수와 배송지 테이블을 직접 쓸 수 없다.
select extensions.ok(not has_function_privilege('authenticated','public.prepare_order_change(uuid,uuid,uuid,uuid,text,uuid,text)','EXECUTE'), '고객이 주문 변경 초안 RPC를 직접 실행할 수 없음');
select extensions.ok(not has_function_privilege('authenticated','public.confirm_order_change(uuid,uuid,uuid,boolean)','EXECUTE'), '고객이 주문 변경 확정 RPC를 직접 실행할 수 없음');
select extensions.ok(not has_table_privilege('authenticated','public.mock_addresses','SELECT'), '고객이 배송지 테이블을 직접 읽을 수 없음');

-- 취소: 출고 준비 중 주문만, 다른 고객은 불가, 확정 시 재고 복구는 한 번만.
select extensions.is(public.prepare_order_change(tenant,other_session,other,'42000000-0000-4000-8000-000000000001'::uuid,'cancel',null,null)->>'status','missing','다른 고객 주문 취소 초안 차단') from oc;
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000003'::uuid,'cancel',null,null)->>'status','shipped','배송 중 주문은 취소 불가') from oc;
create temporary table cancel_draft as
  select (public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000001'::uuid,'cancel',null,null)->>'id')::uuid as approval from oc;
select extensions.is((select status from public.mock_orders where id = '42000000-0000-4000-8000-000000000001'),'preparing','초안 단계에서는 주문 상태 유지');
select extensions.is(public.decide_agent_action(tenant,other_session,other,approval,true,false)->>'status','missing','다른 고객이 취소 승인 불가') from cancel_draft, oc;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'status','confirmed','고객 확인 후 취소') from cancel_draft, oc;
select extensions.is((select status from public.mock_orders where id = '42000000-0000-4000-8000-000000000001'),'canceled','주문 상태가 취소로 바뀜');
select extensions.is((select stock from public.mock_product_options where product_id = 'oc-shirt' and size = 'M'),3,'취소한 수량만큼 재고 복구');
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'receipt',
  (select id::text from public.mock_order_changes where approval_id = approval),'같은 승인 재시도는 같은 접수 반환') from cancel_draft, oc;
select extensions.is((select stock from public.mock_product_options where product_id = 'oc-shirt' and size = 'M'),3,'재시도해도 재고는 한 번만 복구');
select extensions.is(public.check_mock_return(tenant,customer,'42000000-0000-4000-8000-000000000001'::uuid)->>'status','canceled','취소된 주문은 반품 대상 아님') from oc;

-- 배송지: 주문 후 30분 이내 출고 준비 중 주문, 본인 저장 배송지만.
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000002'::uuid,'address','32000000-0000-4000-8000-000000000002'::uuid,null)->>'status','address_locked','주문 후 30분이 지나면 배송지 변경 불가') from oc;
update public.mock_orders set ordered_at = now() - interval '1 minute', status = 'preparing' where id = '42000000-0000-4000-8000-000000000002';
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000002'::uuid,'address','32000000-0000-4000-8000-000000000003'::uuid,null)->>'status','address_missing','다른 고객의 배송지 선택 차단') from oc;
create temporary table address_draft as
  select (public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000002'::uuid,'address','32000000-0000-4000-8000-000000000002'::uuid,null)->>'id')::uuid as approval from oc;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'status','confirmed','고객 확인 후 배송지 변경') from address_draft, oc;
select extensions.is((select address_id from public.mock_orders where id = '42000000-0000-4000-8000-000000000002'),'32000000-0000-4000-8000-000000000002'::uuid,'주문 배송지가 선택한 배송지로 바뀜');

-- 교환: 배송 완료 후 5일 이내, 상품 상태 확인 필수, 새 사이즈 재고 차감, 같은 주문은 한 번만.
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000005'::uuid,'exchange',null,'L')->>'status','too_late','수령 후 5일이 지나면 교환 불가') from oc;
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000006'::uuid,'exchange',null,null)->>'status','size_missing','사이즈 기록이 없는 주문도 새 사이즈 미지정이면 사이즈를 묻는다') from oc;
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000004'::uuid,'exchange',null,null)->'sizes','["L"]'::jsonb,'사이즈 목록은 재고가 있는 다른 사이즈만') from oc;
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000004'::uuid,'exchange',null,'XL')->>'status','out_of_stock','품절 사이즈로 교환 불가') from oc;
create temporary table exchange_draft as
  select (public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000004'::uuid,'exchange',null,'L')->>'id')::uuid as approval from oc;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'status','condition_required','상품 상태 확인 없이는 교환 불가') from exchange_draft, oc;
update public.mock_product_options set stock = 0 where product_id = 'oc-shirt' and size = 'L';
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,true)->>'status','out_of_stock','초안 뒤 재고가 없어지면 확정 거부') from exchange_draft, oc;
update public.mock_product_options set stock = 1 where product_id = 'oc-shirt' and size = 'L';
create temporary table exchange_draft2 as
  select (public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000004'::uuid,'exchange',null,'L')->>'id')::uuid as approval from oc;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,true)->>'status','confirmed','상태 확인 후 교환 접수') from exchange_draft2, oc;
select extensions.is((select stock from public.mock_product_options where product_id = 'oc-shirt' and size = 'L'),0,'교환 사이즈 재고 차감') from oc;
select extensions.is(public.prepare_order_change(tenant,session_id,customer,'42000000-0000-4000-8000-000000000004'::uuid,'exchange',null,'M')->>'status','already_requested','같은 주문은 교환을 한 번만 접수') from oc;

select * from extensions.finish();
rollback;

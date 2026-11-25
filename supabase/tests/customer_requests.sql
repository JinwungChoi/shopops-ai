begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(9);

-- 모든 데이터는 트랜잭션 안의 합성 값이며 마지막에 롤백한다.
insert into public.tenants (id, name, slug, public_widget_key) values
  ('b1000000-0000-4000-8000-000000000001', 'Request test A', 'request-a-rollback', 'e1000000000000000000000000000001'),
  ('b1000000-0000-4000-8000-000000000002', 'Request test B', 'request-b-rollback', 'e1000000000000000000000000000002');
create temporary table q as select
  'b1000000-0000-4000-8000-000000000001'::uuid as tenant, 'b1000000-0000-4000-8000-000000000002'::uuid as other_tenant,
  'b2000000-0000-4000-8000-000000000001'::uuid as customer, 'b2000000-0000-4000-8000-000000000002'::uuid as other,
  'b3000000-0000-4000-8000-000000000001'::uuid as session_id;
insert into auth.users(id,email) select customer,'request-a@example.invalid' from q union all select other,'request-b@example.invalid' from q;
insert into public.chat_sessions(id,tenant_id,customer_user_id,token_hash,expires_at)
  select session_id,tenant,customer,'rq-a',now()+interval '1 hour' from q;
insert into public.mock_addresses(id,tenant_id,customer_user_id,label,summary,is_default)
  select 'b5000000-0000-4000-8000-000000000001'::uuid,tenant,customer,'집','서울 (합성)',true from q;
insert into public.mock_orders(id,tenant_id,customer_user_id,order_reference,product_name,ordered_at,status,quantity,total_amount)
  select 'b4000000-0000-4000-8000-000000000001'::uuid,tenant,customer,'STY-66000001','요청 검증 셔츠',now()-interval '3 days','delivered',1,30000 from q union all
  select 'b4000000-0000-4000-8000-000000000002'::uuid,tenant,other,'STY-66000002','다른 고객 셔츠',now()-interval '3 days','delivered',1,30000 from q union all
  select 'b4000000-0000-4000-8000-000000000003'::uuid,other_tenant,customer,'STY-66000003','다른 업체 셔츠',now()-interval '3 days','delivered',1,30000 from q;
insert into public.agent_approvals(id,tenant_id,session_id,order_id,customer_user_id,kind,reason,quantity,fee,status,expires_at)
  select 'b6000000-0000-4000-8000-000000000001'::uuid,tenant,session_id,'b4000000-0000-4000-8000-000000000001'::uuid,customer,'return','change_of_mind',1,6000,'confirmed',now()+interval '10 minutes' from q;
insert into public.mock_return_requests(tenant_id,order_id,approval_id,quantity,fee)
  select tenant,'b4000000-0000-4000-8000-000000000001'::uuid,'b6000000-0000-4000-8000-000000000001'::uuid,1,6000 from q;
insert into public.support_tickets(tenant_id,session_id,title,description,status,order_reference,reason)
  select tenant,session_id,'문의','합성 문의','open','STY-66000001','staff_requested' from q;

select extensions.ok(not has_function_privilege('authenticated','public.list_mock_requests(uuid,uuid,text,text)','EXECUTE'), '고객이 접수 내역 RPC를 직접 실행할 수 없음');
select extensions.ok(not has_function_privilege('anon','public.mock_order_detail(uuid,uuid,text)','EXECUTE'), '익명 사용자가 주문 상세 RPC를 실행할 수 없음');
select extensions.is(jsonb_array_length(public.list_mock_requests(tenant,customer,null,null)),2,'본인 반품 1건과 상담 문의 1건') from q;
select extensions.is(public.list_mock_requests(tenant,customer,'return',null)->0->>'reference','STY-66000001','반품만 걸러서 조회') from q;
select extensions.is((public.list_mock_requests(tenant,customer,'return',null)->0->>'fee')::int,6000,'반품비 함께 반환') from q;
select extensions.is(jsonb_array_length(public.list_mock_requests(tenant,other,null,null)),0,'다른 고객에게는 보이지 않음') from q;
select extensions.is(jsonb_array_length(public.list_mock_requests(other_tenant,customer,null,null)),0,'다른 업체 범위에서는 보이지 않음') from q;
select extensions.is(public.mock_order_detail(tenant,other,'STY-66000001')->>'status','missing','다른 고객 주문 상세 차단') from q;
select extensions.is(public.mock_order_detail(tenant,customer,'STY-66000001')->>'address','집 · 서울 (합성) (기본 배송지)','배송지 미지정 주문은 기본 배송지 표시') from q;

select * from extensions.finish();
rollback;

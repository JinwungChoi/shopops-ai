begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(26);

insert into public.tenants (name, slug, public_widget_key)
values ('Agent test', 'agent-action-rollback', '202dbac4609c4aaa9a7cd4ea0aa604a5')
on conflict (public_widget_key) do nothing;
create temporary table action_fixture as
  select id as tenant,
    '10000000-0000-4000-8000-000000000001'::uuid as customer,
    '10000000-0000-4000-8000-000000000002'::uuid as other,
    '20000000-0000-4000-8000-000000000001'::uuid as session_id,
    '20000000-0000-4000-8000-000000000002'::uuid as other_session,
    '30000000-0000-4000-8000-000000000001'::uuid as purchase,
    '30000000-0000-4000-8000-000000000002'::uuid as old_purchase
  from public.tenants where public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5';

insert into auth.users(id,email)
  select customer,'agent-action-test-a@example.invalid' from action_fixture union all
  select other,'agent-action-test-b@example.invalid' from action_fixture;
insert into public.chat_sessions(id,tenant_id,customer_user_id,token_hash,expires_at)
  select session_id,tenant,customer,'agent-test-a',now()+interval '20 minutes' from action_fixture union all
  select other_session,tenant,other,'agent-test-b',now()+interval '20 minutes' from action_fixture;
insert into public.mock_orders(id,tenant_id,customer_user_id,order_reference,product_name,status,ordered_at)
  select purchase,tenant,customer,'STY-99999991','검증용 팬츠','delivered',now()-interval '3 days' from action_fixture union all
  select old_purchase,tenant,customer,'STY-99999992','검증용 셔츠','delivered',now()-interval '9 days' from action_fixture;
insert into public.mock_shipment_events(tenant_id,order_id,occurred_at,location,description)
  select tenant,purchase,now()-interval '2 days','검증 센터','배달 완료' from action_fixture union all
  select tenant,old_purchase,now()-interval '8 days','검증 센터','배달 완료' from action_fixture;

select extensions.ok(not has_table_privilege('authenticated','public.agent_approvals','SELECT'), '고객이 승인 테이블을 직접 읽을 수 없음');
select extensions.ok(not has_table_privilege('authenticated','public.mock_return_requests','INSERT'), '고객이 반품 레코드를 직접 쓸 수 없음');
select extensions.ok(not has_function_privilege('authenticated','public.decide_agent_action(uuid,uuid,uuid,uuid,boolean,boolean)','EXECUTE'), '고객이 확인 RPC 직접 실행 불가');
select extensions.ok(not has_function_privilege('anon','public.prepare_agent_action(uuid,uuid,uuid,uuid,text,text)','EXECUTE'), '익명 초안 RPC 직접 실행 불가');
select extensions.is(public.check_mock_return(tenant,customer,old_purchase)->>'status','too_late','수령 후 7일 초과') from action_fixture;
select extensions.ok(not has_function_privilege('authenticated','public.list_mock_return_eligibility(uuid,uuid,text,text)','EXECUTE'), '고객에게 반품 가능 목록 RPC를 직접 공개하지 않음');
select extensions.is((select count(*)::int from public.list_mock_return_eligibility(tenant,other,null,null)),0,'다른 고객 주문 미노출') from action_fixture;
select extensions.is((select count(*)::int from public.list_mock_return_eligibility(gen_random_uuid(),customer,null,null)),0,'다른 쇼핑몰 주문 미노출') from action_fixture;
select extensions.is((select eligibility from public.list_mock_return_eligibility(tenant,customer,'STY-99999991',null)),'eligible','주문별 반품 가능 판정') from action_fixture;
select extensions.is((select eligibility from public.list_mock_return_eligibility(tenant,customer,null,'검증용 셔츠')),'too_late','주문별 기한 초과 판정') from action_fixture;
select extensions.ok(not has_function_privilege('authenticated','public.list_mock_return_eligibility(uuid,uuid,text,text,text[])','EXECUTE'), '문맥 조회 RPC 직접 실행 차단');
select extensions.is((select array_agg(order_reference) from public.list_mock_return_eligibility(tenant,customer,null,null,array['STY-99999992'])),'{STY-99999992}'::text[],'직전에 제시한 주문만 반환') from action_fixture;
select extensions.is((select count(*)::int from public.list_mock_return_eligibility(tenant,other,null,null,array['STY-99999992'])),0,'직전 참조를 보내도 다른 고객 주문 차단') from action_fixture;
select extensions.is(public.prepare_agent_action(tenant,other_session,other,purchase,'return','change_of_mind')->>'status','missing','다른 구매자의 주문 차단') from action_fixture;
create temporary table action_approval as select *, (public.prepare_agent_action(tenant,session_id,customer,purchase,'return','change_of_mind')->>'id')::uuid as approval from action_fixture;
select extensions.ok(approval is not null,'승인 초안 생성') from action_approval;
select extensions.is((select count(*)::int from public.mock_return_requests where order_id = purchase),0,'초안만으로 반품이 생성되지 않음') from action_approval;
select extensions.is(public.decide_agent_action(tenant,other_session,other,approval,true,true)->>'status','missing','다른 세션과 고객 승인 차단') from action_approval;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,null,true)->>'status','invalid','결정 값이 없는 요청 차단') from action_approval;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'status','condition_required','상품 상태 확인 필요') from action_approval;
update public.mock_orders set status = 'in_transit' where id = (select purchase from action_approval);
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,true)->>'status','not_delivered','최종 승인 시 최신 배송 상태 재검증') from action_approval;
update public.mock_orders set status = 'delivered' where id = (select purchase from action_approval);
update action_approval set approval = (public.prepare_agent_action(tenant,session_id,customer,purchase,'return','change_of_mind')->>'id')::uuid;
update public.agent_approvals set expires_at = now() where id = (select approval from action_approval);
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,true)->>'status','expired','만료된 승인 실행 차단') from action_approval;
update action_approval set approval = (public.prepare_agent_action(tenant,session_id,customer,purchase,'return','change_of_mind')->>'id')::uuid;
create temporary table action_receipt as select (public.decide_agent_action(tenant,session_id,customer,approval,true,true)->>'receipt') as receipt from action_approval;
select extensions.ok(receipt is not null,'승인 후 반품 번호 발급') from action_receipt;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,true)->>'receipt',(select receipt from action_receipt),'재전송 시 같은 접수 번호 반환') from action_approval;
select extensions.is((select count(*)::int from public.mock_return_requests where order_id = purchase),1,'반품 레코드는 한 건') from action_approval;
update action_approval set approval = (public.prepare_agent_action(tenant,session_id,customer,purchase,'support','missing_delivery')->>'id')::uuid;
select extensions.is(public.decide_agent_action(tenant,session_id,customer,approval,true,false)->>'status','confirmed','상담 문의 고객 승인 후 저장') from action_approval;
select extensions.is((select last_scan->>'location' from public.support_tickets where approval_id = approval),'검증 센터','업무 데이터에서 마지막 배송 기록 복사') from action_approval;

select * from extensions.finish();
rollback;

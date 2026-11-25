-- 고객의 접수 내역(반품·교환·취소·배송지 변경·상담 문의)과 주문 상세 조회.
-- "반품 신청건 보여줘"처럼 이미 접수한 내역을 묻는 질문에 답한다. 읽기 전용이며 service_role만 실행한다.

alter table public.chat_messages drop constraint chat_messages_tool_name_check;
alter table public.chat_messages add constraint chat_messages_tool_name_check
  check (tool_name is null or (role = 'assistant' and tool_name in (
    'search_policies','search_products','get_order_status','list_orders','track_shipment',
    'check_return_eligibility','submit_return_request','create_support_ticket',
    'get_product','view_cart','update_cart','prepare_checkout','place_order',
    'list_addresses','prepare_order_change','change_order',
    'list_requests','get_order_detail'
  )));

-- p_kind: return | exchange | cancel | address | ticket | null(전체). p_reference가 있으면 그 주문의 접수만.
create function public.list_mock_requests(p_tenant uuid, p_customer uuid, p_kind text, p_reference text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with requests as (
    select r.id, 'return'::text as kind, o.order_reference as reference, o.product_name as name, r.created_at,
      '접수됨'::text as status, r.fee, a.reason as detail
    from public.mock_return_requests r
    join public.mock_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
    left join public.agent_approvals a on a.tenant_id = r.tenant_id and a.id = r.approval_id
    where r.tenant_id = p_tenant and o.customer_user_id = p_customer
    union all
    select c.id, c.kind, o.order_reference, o.product_name, c.created_at,
      case c.kind when 'cancel' then '취소 완료' when 'address' then '변경 완료' else '접수됨' end,
      null::integer,
      case c.kind when 'exchange' then coalesce(c.detail->>'fromSize', '기존') || ' → ' || (c.detail->>'size')
        when 'address' then c.detail->>'label' else null end
    from public.mock_order_changes c
    join public.mock_orders o on o.tenant_id = c.tenant_id and o.id = c.order_id
    where c.tenant_id = p_tenant and o.customer_user_id = p_customer
    union all
    select t.id, 'ticket', t.order_reference,
      (select o.product_name from public.mock_orders o where o.tenant_id = t.tenant_id and o.customer_user_id = p_customer
        and o.order_reference = t.order_reference limit 1),
      t.created_at,
      case t.status when 'open' then '접수됨' when 'in_progress' then '처리 중' else '해결됨' end,
      null::integer, t.reason
    from public.support_tickets t
    join public.chat_sessions s on s.tenant_id = t.tenant_id and s.id = t.session_id
    where t.tenant_id = p_tenant and s.customer_user_id = p_customer
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'reference', reference, 'name', name,
      'createdAt', created_at, 'status', status, 'fee', fee, 'detail', detail) order by created_at desc), '[]'::jsonb)
  from (select * from requests
    where (p_kind is null or kind = p_kind) and (p_reference is null or reference = p_reference)
    order by created_at desc limit 20) latest;
$$;
revoke all on function public.list_mock_requests(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.list_mock_requests(uuid, uuid, text, text) to service_role;

-- 주문 상세: 사이즈, 배송지, 결제 정보. 본인 주문이 아니면 missing.
create function public.mock_order_detail(p_tenant uuid, p_customer uuid, p_reference text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object('status', 'ok', 'size', o.option_size,
      'address', coalesce(addr.label || ' · ' || addr.summary,
        (select d.label || ' · ' || d.summary || ' (기본 배송지)' from public.mock_addresses d
          where d.tenant_id = p_tenant and d.customer_user_id = p_customer and d.is_default limit 1)),
      'paymentMethod', case when ch.id is not null then '모의 결제' else null end,
      'paidTotal', coalesce(ch.total, o.total_amount))
    from public.mock_orders o
    left join public.mock_addresses addr on addr.tenant_id = o.tenant_id and addr.id = o.address_id
    left join public.mock_checkouts ch on ch.tenant_id = o.tenant_id and ch.id = o.checkout_id
    where o.tenant_id = p_tenant and o.customer_user_id = p_customer and o.order_reference = p_reference
  ), jsonb_build_object('status', 'missing'));
$$;
revoke all on function public.mock_order_detail(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mock_order_detail(uuid, uuid, text) to service_role;

alter table public.chat_messages drop constraint chat_messages_tool_name_check;
alter table public.chat_messages add constraint chat_messages_tool_name_check
  check (tool_name is null or (role = 'assistant' and tool_name in (
    'search_policies','search_products','get_order_status','list_orders','track_shipment',
    'check_return_eligibility','submit_return_request','create_support_ticket'
  )));
alter table public.chat_messages
  add column agent_response jsonb check (agent_response is null or role = 'assistant'),
  add column agent_state jsonb check (agent_state is null or role = 'assistant'),
  add column agent_input jsonb check (agent_input is null or role = 'user');

create table public.agent_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id uuid not null,
  order_id uuid,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('return','support')),
  reason text not null check (reason in ('change_of_mind','damaged','wrong_item','missing_delivery','policy_review','staff_requested')),
  quantity integer check (quantity > 0),
  fee integer check (fee >= 0),
  status text not null default 'pending' check (status in ('pending','canceled','confirmed','invalid')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  decided_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, session_id) references public.chat_sessions(tenant_id, id) on delete cascade,
  foreign key (tenant_id, order_id) references public.mock_orders(tenant_id, id) on delete cascade,
  check (kind <> 'return' or (order_id is not null and quantity is not null and fee is not null))
);
create unique index agent_one_pending_per_session on public.agent_approvals(tenant_id, session_id) where status = 'pending';

create table public.mock_return_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  approval_id uuid not null,
  quantity integer not null check (quantity > 0),
  fee integer not null check (fee >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, approval_id),
  unique (tenant_id, order_id),
  foreign key (tenant_id, approval_id) references public.agent_approvals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, order_id) references public.mock_orders(tenant_id, id) on delete cascade
);

alter table public.support_tickets
  add column approval_id uuid,
  add column order_reference text,
  add column reason text,
  add column last_scan jsonb,
  add unique (tenant_id, approval_id),
  add foreign key (tenant_id, approval_id) references public.agent_approvals(tenant_id, id) on delete cascade;
create index support_tickets_inbox_idx on public.support_tickets(tenant_id, created_at desc, id);

alter table public.agent_approvals enable row level security;
alter table public.mock_return_requests enable row level security;
revoke all on public.agent_approvals, public.mock_return_requests from public, anon, authenticated;
grant all on public.agent_approvals, public.mock_return_requests to service_role;

-- 실행 정책은 RAG 문서나 모델 출력과 분리한다. 수령 시간은 모의 택배 완료 기록을 사용한다.
create function public.check_mock_return(p_tenant uuid, p_customer uuid, p_order uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  purchase public.mock_orders%rowtype;
  delivered_at timestamptz;
begin
  select * into purchase from public.mock_orders
    where tenant_id = p_tenant and customer_user_id = p_customer and id = p_order;
  if not found then return jsonb_build_object('status','missing'); end if;
  if exists (select 1 from public.mock_return_requests where tenant_id = p_tenant and order_id = p_order) then
    return jsonb_build_object('status','already_submitted');
  end if;
  if purchase.status <> 'delivered' then return jsonb_build_object('status','not_delivered'); end if;
  select max(occurred_at) into delivered_at from public.mock_shipment_events
    where tenant_id = p_tenant and order_id = p_order and description = '배달 완료';
  if delivered_at is null or delivered_at > now() then return jsonb_build_object('status','review'); end if;
  if now() > delivered_at + interval '168 hours' then return jsonb_build_object('status','too_late'); end if;
  return jsonb_build_object('status','eligible','quantity',purchase.quantity,'fee',6000);
end;
$$;

create function public.prepare_agent_action(p_tenant uuid, p_session uuid, p_customer uuid, p_order uuid, p_kind text, p_reason text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  approval public.agent_approvals%rowtype;
  eligible jsonb;
begin
  perform 1 from public.chat_sessions s join public.tenants t on t.id = s.tenant_id
    where s.id = p_session and s.tenant_id = p_tenant and s.customer_user_id = p_customer
      and s.expires_at > now() and s.revoked_at is null and t.is_active
      and t.public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5' for update of s;
  if not found then return jsonb_build_object('status','missing'); end if;
  if p_order is not null and not exists (select 1 from public.mock_orders
    where tenant_id = p_tenant and customer_user_id = p_customer and id = p_order) then
    return jsonb_build_object('status','missing');
  end if;
  if p_kind = 'return' then
    if p_reason is distinct from 'change_of_mind' then return jsonb_build_object('status','review'); end if;
    eligible := public.check_mock_return(p_tenant, p_customer, p_order);
    if eligible->>'status' <> 'eligible' then return eligible; end if;
  elsif p_kind is distinct from 'support' or p_reason is null or p_reason = 'change_of_mind' then
    return jsonb_build_object('status','invalid');
  end if;
  update public.agent_approvals set status = 'canceled', decided_at = now()
    where tenant_id = p_tenant and session_id = p_session and status = 'pending';
  insert into public.agent_approvals(tenant_id, session_id, customer_user_id, order_id, kind, reason, quantity, fee)
    values (p_tenant, p_session, p_customer, p_order, p_kind, p_reason,
      (eligible->>'quantity')::integer, (eligible->>'fee')::integer) returning * into approval;
  return jsonb_build_object('status','pending','id',approval.id,'quantity',approval.quantity,
    'fee',approval.fee,'expiresAt',approval.expires_at);
end;
$$;

create or replace function public.decide_agent_action(p_tenant uuid, p_session uuid, p_customer uuid,
  p_approval uuid, p_confirm boolean, p_item_condition_confirmed boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  approval public.agent_approvals%rowtype;
  purchase public.mock_orders%rowtype;
  eligible jsonb;
  receipt uuid;
  scan jsonb;
begin
  if p_confirm is null then return jsonb_build_object('status','invalid'); end if;
  perform 1 from public.chat_sessions s join public.tenants t on t.id = s.tenant_id
    where s.id = p_session and s.tenant_id = p_tenant and s.customer_user_id = p_customer
      and s.expires_at > now() and s.revoked_at is null and t.is_active
      and t.public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5' for update of s;
  if not found then return jsonb_build_object('status','missing'); end if;
  select * into approval from public.agent_approvals where id = p_approval
    and tenant_id = p_tenant and session_id = p_session and customer_user_id = p_customer for update;
  if not found then return jsonb_build_object('status','missing'); end if;

  if approval.status = 'confirmed' then
    if not p_confirm then return jsonb_build_object('status','already_confirmed'); end if;
    if approval.kind = 'return' then
      select id into receipt from public.mock_return_requests where tenant_id = p_tenant and approval_id = approval.id;
    else
      select id into receipt from public.support_tickets where tenant_id = p_tenant and approval_id = approval.id;
    end if;
    return jsonb_build_object('status','confirmed','kind',approval.kind,'receipt',receipt);
  end if;
  if approval.status <> 'pending' then return jsonb_build_object('status',approval.status); end if;
  if approval.expires_at <= now() then
    update public.agent_approvals set status = 'invalid', decided_at = now() where id = approval.id;
    return jsonb_build_object('status','expired');
  end if;
  if not p_confirm then
    update public.agent_approvals set status = 'canceled', decided_at = now() where id = approval.id;
    return jsonb_build_object('status','canceled');
  end if;
  if approval.kind = 'return' and p_item_condition_confirmed is distinct from true then
    return jsonb_build_object('status','condition_required');
  end if;

  if approval.order_id is not null then
    select * into purchase from public.mock_orders where tenant_id = p_tenant
      and id = approval.order_id and customer_user_id = p_customer for update;
    if not found then return jsonb_build_object('status','missing'); end if;
  end if;
  if approval.kind = 'return' then
    eligible := public.check_mock_return(p_tenant, p_customer, approval.order_id);
    if eligible->>'status' <> 'eligible' then
      update public.agent_approvals set status = 'invalid', decided_at = now() where id = approval.id;
      return eligible;
    end if;
    if approval.quantity <> (eligible->>'quantity')::integer or approval.fee <> (eligible->>'fee')::integer then
      update public.agent_approvals set status = 'invalid', decided_at = now() where id = approval.id;
      return jsonb_build_object('status','invalid');
    end if;
    insert into public.mock_return_requests(tenant_id,order_id,approval_id,quantity,fee)
      values(p_tenant,approval.order_id,approval.id,approval.quantity,approval.fee) returning id into receipt;
  else
    select jsonb_build_object('at',occurred_at,'location',location,'description',description) into scan
      from public.mock_shipment_events where tenant_id = p_tenant and order_id = approval.order_id
      order by occurred_at desc limit 1;
    insert into public.support_tickets(tenant_id,session_id,approval_id,order_reference,reason,last_scan,title,description)
      values(p_tenant,p_session,approval.id,purchase.order_reference,approval.reason,scan,
        '채팅 상담 요청','세부 문의는 연결된 채팅에서 확인할 수 있습니다.') returning id into receipt;
  end if;
  update public.agent_approvals set status = 'confirmed', decided_at = now() where id = approval.id;
  return jsonb_build_object('status','confirmed','kind',approval.kind,'receipt',receipt);
end;
$$;

revoke all on function public.check_mock_return(uuid,uuid,uuid),
  public.prepare_agent_action(uuid,uuid,uuid,uuid,text,text),
  public.decide_agent_action(uuid,uuid,uuid,uuid,boolean,boolean) from public, anon, authenticated;
grant execute on function public.check_mock_return(uuid,uuid,uuid),
  public.prepare_agent_action(uuid,uuid,uuid,uuid,text,text),
  public.decide_agent_action(uuid,uuid,uuid,uuid,boolean,boolean) to service_role;

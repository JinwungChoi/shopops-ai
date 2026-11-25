-- P2-11: 주문 취소·배송지 변경·교환. 모델은 확인 카드 초안까지만 만들고, 실행은 고객이 카드에서 확인할 때만 한다.
-- 판정 규칙은 check_order_change 하나에 두고 초안과 확정에서 같은 함수로 다시 검사한다.

alter table public.chat_messages drop constraint chat_messages_tool_name_check;
alter table public.chat_messages add constraint chat_messages_tool_name_check
  check (tool_name is null or (role = 'assistant' and tool_name in (
    'search_policies','search_products','get_order_status','list_orders','track_shipment',
    'check_return_eligibility','submit_return_request','create_support_ticket',
    'get_product','view_cart','update_cart','prepare_checkout','place_order',
    'list_addresses','prepare_order_change','change_order'
  )));

alter table public.mock_orders drop constraint mock_orders_status_check;
alter table public.mock_orders add constraint mock_orders_status_check
  check (status in ('preparing','in_transit','delivered','canceled'));

-- 합성 배송지. 채팅에서는 주소 원문을 입력받지 않고 저장된 배송지 중에서만 고른다.
create table public.mock_addresses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 20),
  summary text not null check (char_length(summary) between 1 and 80),
  is_default boolean not null default false,
  unique (tenant_id, id),
  unique (tenant_id, customer_user_id, label)
);
create unique index mock_addresses_one_default on public.mock_addresses(tenant_id, customer_user_id) where is_default;
alter table public.mock_addresses enable row level security;
revoke all on public.mock_addresses from public, anon, authenticated;
grant all on public.mock_addresses to service_role;

alter table public.mock_orders add column address_id uuid;
alter table public.mock_orders add constraint mock_orders_address_fk
  foreign key (tenant_id, address_id) references public.mock_addresses(tenant_id, id) on delete set null (address_id);

alter table public.agent_approvals drop constraint agent_approvals_kind_check;
alter table public.agent_approvals add constraint agent_approvals_kind_check
  check (kind in ('return','support','checkout','cancel','address','exchange'));
alter table public.agent_approvals add constraint agent_approvals_change_detail
  check (kind not in ('cancel','address','exchange') or (order_id is not null and detail is not null));

create table public.mock_order_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  approval_id uuid not null,
  kind text not null check (kind in ('cancel','address','exchange')),
  detail jsonb not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, approval_id),
  foreign key (tenant_id, approval_id) references public.agent_approvals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, order_id) references public.mock_orders(tenant_id, id) on delete cascade
);
create unique index mock_order_changes_one_exchange on public.mock_order_changes(tenant_id, order_id) where kind = 'exchange';
alter table public.mock_order_changes enable row level security;
revoke all on public.mock_order_changes from public, anon, authenticated;
grant all on public.mock_order_changes to service_role;

-- 취소된 주문은 반품 대상이 아니다.
create or replace function public.check_mock_return(p_tenant uuid, p_customer uuid, p_order uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  purchase public.mock_orders%rowtype;
  delivered_at timestamptz;
begin
  select * into purchase from public.mock_orders
    where tenant_id = p_tenant and customer_user_id = p_customer and id = p_order;
  if not found then return jsonb_build_object('status','missing'); end if;
  if purchase.status = 'canceled' then return jsonb_build_object('status','canceled'); end if;
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

-- 주문 변경 판정. 취소: 출고 준비 중. 배송지: 출고 준비 중이고 주문 후 30분 이내, 본인 저장 배송지.
-- 교환: 배송 완료 후 5일(120시간) 이내, 반품·교환 이력 없음, 다른 사이즈 재고가 주문 수량 이상.
create function public.check_order_change(p_tenant uuid, p_customer uuid, p_order uuid, p_kind text, p_address uuid, p_size text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  purchase public.mock_orders%rowtype;
  place public.mock_addresses%rowtype;
  delivered_at timestamptz;
  available integer;
begin
  select * into purchase from public.mock_orders
    where tenant_id = p_tenant and customer_user_id = p_customer and id = p_order;
  if not found then return jsonb_build_object('status','missing'); end if;
  if purchase.status = 'canceled' then return jsonb_build_object('status','already_canceled'); end if;
  if p_kind = 'cancel' then
    if purchase.status <> 'preparing' then return jsonb_build_object('status','shipped'); end if;
    return jsonb_build_object('status','ok','detail',jsonb_build_object());
  elsif p_kind = 'address' then
    if purchase.status <> 'preparing' then return jsonb_build_object('status','shipped'); end if;
    if purchase.ordered_at < now() - interval '30 minutes' then return jsonb_build_object('status','address_locked'); end if;
    select * into place from public.mock_addresses
      where tenant_id = p_tenant and customer_user_id = p_customer and id = p_address;
    if not found then return jsonb_build_object('status','address_missing'); end if;
    if purchase.address_id is not distinct from place.id then return jsonb_build_object('status','same_address'); end if;
    return jsonb_build_object('status','ok','detail',jsonb_build_object('addressId',place.id,'label',place.label,'summary',place.summary));
  elsif p_kind = 'exchange' then
    if purchase.status <> 'delivered' then return jsonb_build_object('status','not_delivered'); end if;
    if exists (select 1 from public.mock_return_requests where tenant_id = p_tenant and order_id = p_order)
      or exists (select 1 from public.mock_order_changes where tenant_id = p_tenant and order_id = p_order and kind = 'exchange') then
      return jsonb_build_object('status','already_requested');
    end if;
    select max(occurred_at) into delivered_at from public.mock_shipment_events
      where tenant_id = p_tenant and order_id = p_order and description = '배달 완료';
    if delivered_at is null or delivered_at > now() or purchase.product_id is null then
      return jsonb_build_object('status','review');
    end if;
    if now() > delivered_at + interval '120 hours' then return jsonb_build_object('status','too_late'); end if;
    if p_size is not distinct from purchase.option_size then return jsonb_build_object('status','same_size'); end if;
    select stock into available from public.mock_product_options
      where tenant_id = p_tenant and product_id = purchase.product_id and size = p_size;
    if not found then
      return jsonb_build_object('status','size_missing','sizes',(select coalesce(jsonb_agg(size order by size), '[]'::jsonb)
        from public.mock_product_options where tenant_id = p_tenant and product_id = purchase.product_id));
    end if;
    if available < purchase.quantity then return jsonb_build_object('status','out_of_stock'); end if;
    return jsonb_build_object('status','ok','detail',jsonb_build_object('size',p_size,'fromSize',purchase.option_size));
  end if;
  return jsonb_build_object('status','invalid');
end;
$$;

create function public.list_mock_addresses(p_tenant uuid, p_customer uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'summary',summary,'isDefault',is_default)
    order by is_default desc, label), '[]'::jsonb)
  from public.mock_addresses where tenant_id = p_tenant and customer_user_id = p_customer;
$$;

create function public.prepare_order_change(p_tenant uuid, p_session uuid, p_customer uuid, p_order uuid,
  p_kind text, p_address uuid, p_size text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  approval public.agent_approvals%rowtype;
  verdict jsonb;
begin
  perform 1 from public.chat_sessions s join public.tenants t on t.id = s.tenant_id
    where s.id = p_session and s.tenant_id = p_tenant and s.customer_user_id = p_customer
      and s.expires_at > now() and s.revoked_at is null and t.is_active
      and t.public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5' for update of s;
  if not found then return jsonb_build_object('status','missing'); end if;
  verdict := public.check_order_change(p_tenant, p_customer, p_order, p_kind, p_address, p_size);
  if verdict->>'status' <> 'ok' then return verdict; end if;
  update public.agent_approvals set status = 'canceled', decided_at = now()
    where tenant_id = p_tenant and session_id = p_session and status = 'pending';
  insert into public.agent_approvals(tenant_id, session_id, customer_user_id, order_id, kind, reason, detail)
    values (p_tenant, p_session, p_customer, p_order, p_kind, 'customer_request', verdict->'detail') returning * into approval;
  return jsonb_build_object('status','pending','id',approval.id,'expiresAt',approval.expires_at,'detail',approval.detail);
end;
$$;

-- 확정: 같은 판정을 다시 하고, 초안과 대상이 달라졌으면 거부한다. 재고는 주문 행을 잠근 뒤 한 번만 바꾼다.
create function public.confirm_order_change(p_tenant uuid, p_customer uuid, p_approval uuid, p_item_condition_confirmed boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  approval public.agent_approvals%rowtype;
  purchase public.mock_orders%rowtype;
  verdict jsonb;
  receipt uuid;
begin
  select * into approval from public.agent_approvals where tenant_id = p_tenant and id = p_approval
    and customer_user_id = p_customer and status = 'pending' for update;
  if not found then return jsonb_build_object('status','missing'); end if;
  if approval.kind = 'exchange' and p_item_condition_confirmed is distinct from true then
    return jsonb_build_object('status','condition_required');
  end if;
  select * into purchase from public.mock_orders where tenant_id = p_tenant and id = approval.order_id
    and customer_user_id = p_customer for update;
  if not found then return jsonb_build_object('status','missing'); end if;
  verdict := public.check_order_change(p_tenant, p_customer, approval.order_id, approval.kind,
    (approval.detail->>'addressId')::uuid, approval.detail->>'size');
  if verdict->>'status' <> 'ok' or verdict->'detail' is distinct from approval.detail then
    update public.agent_approvals set status = 'invalid', decided_at = now() where id = approval.id;
    return case when verdict->>'status' = 'ok' then jsonb_build_object('status','invalid') else verdict end;
  end if;
  if approval.kind = 'cancel' then
    update public.mock_orders set status = 'canceled' where id = purchase.id;
    if purchase.product_id is not null and purchase.option_size is not null then
      update public.mock_product_options set stock = stock + purchase.quantity
        where tenant_id = p_tenant and product_id = purchase.product_id and size = purchase.option_size;
    end if;
  elsif approval.kind = 'address' then
    update public.mock_orders set address_id = (approval.detail->>'addressId')::uuid where id = purchase.id;
  else
    update public.mock_product_options set stock = stock - purchase.quantity
      where tenant_id = p_tenant and product_id = purchase.product_id and size = approval.detail->>'size'
        and stock >= purchase.quantity;
    if not found then
      update public.agent_approvals set status = 'invalid', decided_at = now() where id = approval.id;
      return jsonb_build_object('status','out_of_stock');
    end if;
  end if;
  insert into public.mock_order_changes(tenant_id, order_id, approval_id, kind, detail)
    values (p_tenant, purchase.id, approval.id, approval.kind, approval.detail) returning id into receipt;
  update public.agent_approvals set status = 'confirmed', decided_at = now() where id = approval.id;
  return jsonb_build_object('status','confirmed','kind',approval.kind,'receipt',receipt,'detail',approval.detail);
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
    if approval.kind = 'checkout' then
      select id into receipt from public.mock_checkouts where tenant_id = p_tenant and approval_id = approval.id;
      return jsonb_build_object('status','confirmed','kind','checkout','receipt',receipt,
        'orders',(select coalesce(jsonb_agg(order_reference order by order_reference), '[]'::jsonb) from public.mock_orders
          where tenant_id = p_tenant and checkout_id = receipt),
        'total',(select total from public.mock_checkouts where id = receipt));
    elsif approval.kind in ('cancel','address','exchange') then
      select id into receipt from public.mock_order_changes where tenant_id = p_tenant and approval_id = approval.id;
      return jsonb_build_object('status','confirmed','kind',approval.kind,'receipt',receipt,'detail',approval.detail);
    elsif approval.kind = 'return' then
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
  if approval.kind = 'checkout' then
    return public.confirm_mock_checkout(p_tenant, p_session, p_customer, approval.id);
  end if;
  if approval.kind in ('cancel','address','exchange') then
    return public.confirm_order_change(p_tenant, p_customer, approval.id, p_item_condition_confirmed);
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

revoke all on function public.check_order_change(uuid,uuid,uuid,text,uuid,text), public.list_mock_addresses(uuid,uuid),
  public.prepare_order_change(uuid,uuid,uuid,uuid,text,uuid,text), public.confirm_order_change(uuid,uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.check_order_change(uuid,uuid,uuid,text,uuid,text), public.list_mock_addresses(uuid,uuid),
  public.prepare_order_change(uuid,uuid,uuid,uuid,text,uuid,text), public.confirm_order_change(uuid,uuid,uuid,boolean)
  to service_role;

-- P2-09/P2-10: 상품·옵션 재고, 고객 장바구니, 채팅 모의 주문(모의 결제).
-- 가격·재고·소유권·세션 검증은 이 함수들이 판정한다. 모델이 넘긴 값은 상품 ID·사이즈·수량 후보로만 쓴다.

alter table public.chat_messages drop constraint chat_messages_tool_name_check;
alter table public.chat_messages add constraint chat_messages_tool_name_check
  check (tool_name is null or (role = 'assistant' and tool_name in (
    'search_policies','search_products','get_order_status','list_orders','track_shipment',
    'check_return_eligibility','submit_return_request','create_support_ticket',
    'get_product','view_cart','update_cart','prepare_checkout','place_order'
  )));

create table public.mock_products (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null check (id ~ '^[a-z0-9-]{3,60}$'),
  name text not null check (char_length(name) between 1 and 100),
  category text not null check (category in ('jacket','shirt','trousers','knit','coat','accessory')),
  color text not null check (color ~ '^[a-z]{3,20}$'),
  price integer not null check (price between 0 and 10000000),
  released_at date not null,
  is_new boolean not null default false,
  material text not null check (char_length(material) <= 200),
  fit text not null check (char_length(fit) <= 200),
  care text not null check (char_length(care) <= 200),
  image text check (image is null or image ~ '^/demo-products/[a-z0-9-]+\.png$'),
  is_active boolean not null default true,
  primary key (tenant_id, id)
);

create table public.mock_product_options (
  tenant_id uuid not null,
  product_id text not null,
  size text not null check (size in ('S','M','L','XL','FREE')),
  stock integer not null check (stock between 0 and 100000),
  primary key (tenant_id, product_id, size),
  foreign key (tenant_id, product_id) references public.mock_products(tenant_id, id) on delete cascade
);

create table public.mock_cart_items (
  tenant_id uuid not null,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  size text not null,
  quantity integer not null check (quantity between 1 and 10),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, customer_user_id, product_id, size),
  foreign key (tenant_id, product_id, size) references public.mock_product_options(tenant_id, product_id, size) on delete cascade
);

-- 같은 채팅 요청이 재전송돼도 장바구니를 한 번만 바꾼다.
create table public.mock_cart_requests (
  tenant_id uuid not null,
  session_id uuid not null,
  request_key text not null check (char_length(request_key) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (tenant_id, session_id, request_key),
  foreign key (tenant_id, session_id) references public.chat_sessions(tenant_id, id) on delete cascade
);

alter table public.agent_approvals drop constraint agent_approvals_kind_check;
alter table public.agent_approvals add constraint agent_approvals_kind_check check (kind in ('return','support','checkout'));
alter table public.agent_approvals drop constraint agent_approvals_reason_check;
alter table public.agent_approvals add constraint agent_approvals_reason_check check (reason in (
  'change_of_mind','damaged','wrong_item','missing_delivery','policy_review','staff_requested','customer_request'));
alter table public.agent_approvals add column detail jsonb;
alter table public.agent_approvals add constraint agent_approvals_checkout_detail
  check (kind <> 'checkout' or (detail is not null and order_id is null));

create table public.mock_checkouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  approval_id uuid not null,
  subtotal integer not null check (subtotal >= 0),
  shipping_fee integer not null check (shipping_fee >= 0),
  total integer not null check (total >= 0),
  payment_method text not null default 'mock_card' check (payment_method = 'mock_card'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, approval_id),
  foreign key (tenant_id, approval_id) references public.agent_approvals(tenant_id, id) on delete cascade
);

alter table public.mock_orders
  add column product_id text,
  add column option_size text check (option_size is null or option_size in ('S','M','L','XL','FREE')),
  add column checkout_id uuid,
  add foreign key (tenant_id, product_id) references public.mock_products(tenant_id, id),
  add foreign key (tenant_id, checkout_id) references public.mock_checkouts(tenant_id, id) on delete cascade;

alter table public.mock_products enable row level security;
alter table public.mock_product_options enable row level security;
alter table public.mock_cart_items enable row level security;
alter table public.mock_cart_requests enable row level security;
alter table public.mock_checkouts enable row level security;
revoke all on public.mock_products, public.mock_product_options, public.mock_cart_items,
  public.mock_cart_requests, public.mock_checkouts from public, anon, authenticated;
grant all on public.mock_products, public.mock_product_options, public.mock_cart_items,
  public.mock_cart_requests, public.mock_checkouts to service_role;

-- Style Shop 공개 위젯의 유효한 고객 세션인지 확인한다.
create function public.mock_customer_session(p_tenant uuid, p_session uuid, p_customer uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.chat_sessions s join public.tenants t on t.id = s.tenant_id
    where s.id = p_session and s.tenant_id = p_tenant and s.customer_user_id = p_customer
      and s.expires_at > now() and s.revoked_at is null and t.is_active
      and t.public_widget_key = '202dbac4609c4aaa9a7cd4ea0aa604a5'
  );
$$;

-- 장바구니 금액은 항상 현재 상품 가격으로 계산한다. 5만 원 이상이면 기본 배송비를 받지 않는다.
create function public.mock_cart_view(p_tenant uuid, p_customer uuid)
returns jsonb language sql stable set search_path = '' as $$
  with lines as (
    select c.product_id, p.name, c.size, c.quantity, p.price, c.quantity * p.price as line_total, o.stock
    from public.mock_cart_items c
    join public.mock_products p on p.tenant_id = c.tenant_id and p.id = c.product_id
    join public.mock_product_options o on o.tenant_id = c.tenant_id and o.product_id = c.product_id and o.size = c.size
    where c.tenant_id = p_tenant and c.customer_user_id = p_customer and p.is_active
  ), total as (select coalesce(sum(line_total), 0)::integer as subtotal from lines)
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('productId', product_id, 'name', name, 'size', size,
      'quantity', quantity, 'unitPrice', price, 'lineTotal', line_total) order by product_id, size) from lines), '[]'::jsonb),
    'shortages', coalesce((select jsonb_agg(jsonb_build_object('productId', product_id, 'size', size, 'stock', stock)
      order by product_id, size) from lines where stock < quantity), '[]'::jsonb),
    'subtotal', subtotal,
    'shippingFee', case when subtotal = 0 or subtotal >= 50000 then 0 else 3000 end,
    'total', subtotal + case when subtotal = 0 or subtotal >= 50000 then 0 else 3000 end)
  from total;
$$;

create function public.update_mock_cart(p_tenant uuid, p_session uuid, p_customer uuid, p_request text,
  p_product text, p_size text, p_quantity integer, p_mode text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  option_row public.mock_product_options%rowtype;
  current_quantity integer;
  next_quantity integer;
begin
  if not public.mock_customer_session(p_tenant, p_session, p_customer) then return jsonb_build_object('status','missing'); end if;
  if p_mode not in ('add','set') or p_quantity is null or p_request is null
    or (p_mode = 'add' and p_quantity not between 1 and 10) or (p_mode = 'set' and p_quantity not between 0 and 10) then
    return jsonb_build_object('status','invalid');
  end if;
  if exists (select 1 from public.mock_cart_requests where tenant_id = p_tenant and session_id = p_session and request_key = p_request) then
    return jsonb_build_object('status','duplicate','cart',public.mock_cart_view(p_tenant, p_customer));
  end if;
  select o.* into option_row from public.mock_product_options o
    join public.mock_products p on p.tenant_id = o.tenant_id and p.id = o.product_id
    where o.tenant_id = p_tenant and o.product_id = p_product and o.size = p_size and p.is_active;
  if not found then
    return jsonb_build_object('status','not_found','sizes',(select coalesce(jsonb_agg(size order by size), '[]'::jsonb)
      from public.mock_product_options where tenant_id = p_tenant and product_id = p_product));
  end if;
  select quantity into current_quantity from public.mock_cart_items
    where tenant_id = p_tenant and customer_user_id = p_customer and product_id = p_product and size = p_size for update;
  next_quantity := case when p_mode = 'add' then coalesce(current_quantity, 0) + p_quantity else p_quantity end;
  if next_quantity > 10 then return jsonb_build_object('status','limit','quantity',coalesce(current_quantity, 0)); end if;
  if next_quantity > option_row.stock then return jsonb_build_object('status','out_of_stock','stock',option_row.stock); end if;
  insert into public.mock_cart_requests(tenant_id, session_id, request_key) values (p_tenant, p_session, p_request)
    on conflict do nothing;
  if not found then return jsonb_build_object('status','duplicate','cart',public.mock_cart_view(p_tenant, p_customer)); end if;
  if next_quantity = 0 then
    delete from public.mock_cart_items where tenant_id = p_tenant and customer_user_id = p_customer
      and product_id = p_product and size = p_size;
  else
    insert into public.mock_cart_items(tenant_id, customer_user_id, product_id, size, quantity)
      values (p_tenant, p_customer, p_product, p_size, next_quantity)
      on conflict (tenant_id, customer_user_id, product_id, size)
      do update set quantity = excluded.quantity, updated_at = now();
  end if;
  return jsonb_build_object('status','ok','cart',public.mock_cart_view(p_tenant, p_customer));
end;
$$;

-- 주문 확인 카드용 초안. 금액은 현재 장바구니와 상품 가격의 스냅샷이며 확정 시 다시 비교한다.
create function public.prepare_mock_checkout(p_tenant uuid, p_session uuid, p_customer uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  cart jsonb;
  approval public.agent_approvals%rowtype;
begin
  perform 1 from public.chat_sessions s where s.id = p_session and s.tenant_id = p_tenant for update;
  if not public.mock_customer_session(p_tenant, p_session, p_customer) then return jsonb_build_object('status','missing'); end if;
  cart := public.mock_cart_view(p_tenant, p_customer);
  if jsonb_array_length(cart->'lines') = 0 then return jsonb_build_object('status','empty'); end if;
  if jsonb_array_length(cart->'shortages') > 0 then
    return jsonb_build_object('status','out_of_stock','shortages',cart->'shortages');
  end if;
  update public.agent_approvals set status = 'canceled', decided_at = now()
    where tenant_id = p_tenant and session_id = p_session and status = 'pending';
  insert into public.agent_approvals(tenant_id, session_id, customer_user_id, kind, reason, detail)
    values (p_tenant, p_session, p_customer, 'checkout', 'customer_request', cart - 'shortages') returning * into approval;
  return jsonb_build_object('status','pending','id',approval.id,'expiresAt',approval.expires_at,'cart',approval.detail);
end;
$$;

-- 확정: 장바구니가 초안과 같고 재고가 충분할 때만 주문을 만들고 재고를 차감한다.
create function public.confirm_mock_checkout(p_tenant uuid, p_session uuid, p_customer uuid, p_approval uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  approval public.agent_approvals%rowtype;
  cart jsonb;
  line record;
  receipt uuid;
  reference text;
  refs text[] := '{}';
  first_line boolean := true;
begin
  select * into approval from public.agent_approvals where id = p_approval and tenant_id = p_tenant
    and session_id = p_session and customer_user_id = p_customer and kind = 'checkout' for update;
  if not found then return jsonb_build_object('status','missing'); end if;
  cart := public.mock_cart_view(p_tenant, p_customer);
  if (cart - 'shortages') is distinct from approval.detail then
    update public.agent_approvals set status = 'invalid', decided_at = now() where id = approval.id;
    return jsonb_build_object('status','cart_changed');
  end if;
  for line in select c.product_id, c.size, c.quantity, o.stock from public.mock_cart_items c
      join public.mock_product_options o on o.tenant_id = c.tenant_id and o.product_id = c.product_id and o.size = c.size
      where c.tenant_id = p_tenant and c.customer_user_id = p_customer order by c.product_id, c.size for update of o loop
    if line.stock < line.quantity then
      update public.agent_approvals set status = 'invalid', decided_at = now() where id = approval.id;
      return jsonb_build_object('status','out_of_stock');
    end if;
  end loop;
  insert into public.mock_checkouts(tenant_id, customer_user_id, approval_id, subtotal, shipping_fee, total)
    values (p_tenant, p_customer, approval.id, (cart->>'subtotal')::integer, (cart->>'shippingFee')::integer, (cart->>'total')::integer)
    returning id into receipt;
  for line in select c.product_id, c.size, c.quantity, p.name, p.price from public.mock_cart_items c
      join public.mock_products p on p.tenant_id = c.tenant_id and p.id = c.product_id
      where c.tenant_id = p_tenant and c.customer_user_id = p_customer order by c.product_id, c.size loop
    update public.mock_product_options set stock = stock - line.quantity
      where tenant_id = p_tenant and product_id = line.product_id and size = line.size;
    loop
      reference := 'STY-' || (floor(random() * 90000000) + 10000000)::bigint::text;
      exit when not exists (select 1 from public.mock_orders where tenant_id = p_tenant and order_reference = reference);
    end loop;
    insert into public.mock_orders(tenant_id, customer_user_id, order_reference, product_name, ordered_at, status,
      quantity, total_amount, product_id, option_size, checkout_id)
      values (p_tenant, p_customer, reference, line.name, now(), 'preparing', line.quantity,
        line.quantity * line.price + case when first_line then (cart->>'shippingFee')::integer else 0 end,
        line.product_id, line.size, receipt);
    refs := refs || reference;
    first_line := false;
  end loop;
  delete from public.mock_cart_items where tenant_id = p_tenant and customer_user_id = p_customer;
  update public.agent_approvals set status = 'confirmed', decided_at = now() where id = approval.id;
  return jsonb_build_object('status','confirmed','kind','checkout','receipt',receipt,'orders',to_jsonb(refs),'total',(cart->>'total')::integer);
end;
$$;

-- 기존 결정 함수에 모의 주문 분기를 더한다. 반품·상담 동작은 이전과 같다.
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

revoke all on function public.mock_customer_session(uuid,uuid,uuid), public.mock_cart_view(uuid,uuid),
  public.update_mock_cart(uuid,uuid,uuid,text,text,text,integer,text), public.prepare_mock_checkout(uuid,uuid,uuid),
  public.confirm_mock_checkout(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.mock_customer_session(uuid,uuid,uuid), public.mock_cart_view(uuid,uuid),
  public.update_mock_cart(uuid,uuid,uuid,text,text,text,integer,text), public.prepare_mock_checkout(uuid,uuid,uuid),
  public.confirm_mock_checkout(uuid,uuid,uuid,uuid) to service_role;

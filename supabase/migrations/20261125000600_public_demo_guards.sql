-- 공개 데모 안전장치: 하루 총량 제한, 데모 데이터 스냅샷과 매일 초기화.
-- 모두 service_role 전용이다. 고객·관리자 역할은 직접 실행할 수 없다.

-- 1) 하루 총량 제한. 분 단위 request_limits는 1시간 뒤 지워지므로 별도 테이블에 둔다.
create table private.daily_limits (
  scope_hash text not null,
  day date not null,
  hits integer not null,
  primary key (scope_hash, day)
);
alter table private.daily_limits enable row level security;

create function public.take_daily_budget(p_scope_hash text, p_limit integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_hits integer;
begin
  if p_scope_hash !~ '^[a-f0-9]{64}$' or p_limit not between 1 and 100000 then
    raise exception 'invalid_budget';
  end if;
  delete from private.daily_limits where day < v_day - 7;
  insert into private.daily_limits (scope_hash, day, hits)
  values (p_scope_hash, v_day, 1)
  on conflict (scope_hash, day) do update set hits = daily_limits.hits + 1
  where daily_limits.hits < p_limit
  returning hits into v_hits;
  return v_hits is not null;
end;
$$;
revoke all on function public.take_daily_budget(text, integer) from public, anon, authenticated;
grant execute on function public.take_daily_budget(text, integer) to service_role;

-- 2) 데모 스냅샷: 시드 직후 상태를 기록한다. 주문·배송 시각은 스냅샷 시각 기준의 경과 시간으로 되돌려,
--    며칠이 지나도 반품·교환 기한 시연이 같은 상태로 유지되게 한다.
create table private.demo_snapshots (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  taken_at timestamptz not null,
  session_ids uuid[] not null,
  approval_ids uuid[] not null,
  orders jsonb not null,
  events jsonb not null,
  options jsonb not null
);
alter table private.demo_snapshots enable row level security;

create function public.take_demo_snapshot(p_tenant uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  insert into private.demo_snapshots (tenant_id, taken_at, session_ids, approval_ids, orders, events, options)
  select p_tenant, now(),
    coalesce((select array_agg(id) from public.chat_sessions where tenant_id = p_tenant), '{}'),
    coalesce((select array_agg(id) from public.agent_approvals where tenant_id = p_tenant), '{}'),
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'status', status, 'address_id', address_id, 'ordered_at', ordered_at))
      from public.mock_orders where tenant_id = p_tenant), '[]'),
    coalesce((select jsonb_agg(jsonb_build_object('order_id', order_id, 'occurred_at', occurred_at, 'location', location, 'description', description))
      from public.mock_shipment_events where tenant_id = p_tenant), '[]'),
    coalesce((select jsonb_agg(jsonb_build_object('product_id', product_id, 'size', size, 'stock', stock))
      from public.mock_product_options where tenant_id = p_tenant), '[]')
  on conflict (tenant_id) do update set taken_at = excluded.taken_at, session_ids = excluded.session_ids,
    approval_ids = excluded.approval_ids, orders = excluded.orders, events = excluded.events, options = excluded.options;
  return jsonb_build_object('status', 'ok',
    'orders', (select jsonb_array_length(orders) from private.demo_snapshots where tenant_id = p_tenant));
end;
$$;
revoke all on function public.take_demo_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.take_demo_snapshot(uuid) to service_role;

-- 3) 초기화: 스냅샷 이후에 생긴 대화·승인·주문·장바구니를 지우고, 주문 상태·배송지·재고·시각을 되돌린다.
create function public.reset_demo(p_tenant uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  snap private.demo_snapshots;
  v_shift interval;
  v_sessions integer;
  v_orders integer;
begin
  select * into snap from private.demo_snapshots where tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('status', 'snapshot_missing'); end if;
  v_shift := now() - snap.taken_at;

  -- 새로 생긴 주문(채팅 주문)부터 지운다. 배송 이벤트·변경·반품 기록은 FK cascade로 함께 지워진다.
  delete from public.mock_orders
    where tenant_id = p_tenant and not (id = any (select (o->>'id')::uuid from jsonb_array_elements(snap.orders) o));
  get diagnostics v_orders = row_count;
  -- 스냅샷 이후의 승인(반품·교환·주문 확인)과 대화. 접수 기록과 상담 문의도 cascade로 지워진다.
  delete from public.agent_approvals where tenant_id = p_tenant and not (id = any (snap.approval_ids));
  delete from public.chat_sessions where tenant_id = p_tenant and not (id = any (snap.session_ids));
  get diagnostics v_sessions = row_count;
  delete from public.mock_cart_items where tenant_id = p_tenant;

  update public.mock_orders o set status = s.status, address_id = s.address_id, ordered_at = s.ordered_at + v_shift
    from jsonb_to_recordset(snap.orders) as s(id uuid, status text, address_id uuid, ordered_at timestamptz)
    where o.tenant_id = p_tenant and o.id = s.id;
  delete from public.mock_shipment_events where tenant_id = p_tenant;
  insert into public.mock_shipment_events (tenant_id, order_id, occurred_at, location, description)
    select p_tenant, s.order_id, s.occurred_at + v_shift, s.location, s.description
    from jsonb_to_recordset(snap.events) as s(order_id uuid, occurred_at timestamptz, location text, description text)
    where exists (select 1 from public.mock_orders o where o.tenant_id = p_tenant and o.id = s.order_id);
  update public.mock_product_options p set stock = s.stock
    from jsonb_to_recordset(snap.options) as s(product_id text, size text, stock integer)
    where p.tenant_id = p_tenant and p.product_id = s.product_id and p.size = s.size;

  -- 다음 초기화가 이번 시각 기준으로 같은 경과 시간을 유지하도록 기준 시각을 옮긴다.
  update private.demo_snapshots set taken_at = now(),
    orders = (select jsonb_agg(o || jsonb_build_object('ordered_at', (o->>'ordered_at')::timestamptz + v_shift)) from jsonb_array_elements(snap.orders) o),
    events = (select coalesce(jsonb_agg(e || jsonb_build_object('occurred_at', (e->>'occurred_at')::timestamptz + v_shift)), '[]') from jsonb_array_elements(snap.events) e)
    where tenant_id = p_tenant;
  return jsonb_build_object('status', 'ok', 'removedOrders', v_orders, 'removedSessions', v_sessions);
end;
$$;
revoke all on function public.reset_demo(uuid) from public, anon, authenticated;
grant execute on function public.reset_demo(uuid) to service_role;

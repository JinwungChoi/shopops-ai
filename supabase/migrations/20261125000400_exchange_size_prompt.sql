-- 교환 사이즈 미지정 판정 수정: 사이즈 기록이 없는 기존 주문에서 null = null을 같은 사이즈로 판정하던 문제.
-- 미지정이면 재고 있는 다른 사이즈 목록을 돌려준다.
create or replace function public.check_order_change(p_tenant uuid, p_customer uuid, p_order uuid, p_kind text, p_address uuid, p_size text)
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
    -- 새 사이즈를 아직 고르지 않았으면 가능한 사이즈를 돌려준다. 기존 주문에 사이즈 기록이 없어도 null끼리 같은 사이즈로 보지 않는다.
    if p_size is null then
      return jsonb_build_object('status','size_missing','sizes',(select coalesce(jsonb_agg(size order by size), '[]'::jsonb)
        from public.mock_product_options where tenant_id = p_tenant and product_id = purchase.product_id
          and stock >= purchase.quantity and size is distinct from purchase.option_size));
    end if;
    if p_size = purchase.option_size then return jsonb_build_object('status','same_size'); end if;
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

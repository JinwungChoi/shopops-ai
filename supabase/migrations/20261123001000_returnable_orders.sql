create function public.list_mock_return_eligibility(p_tenant uuid, p_customer uuid, p_reference text, p_product_hint text)
returns table (
  id uuid, order_reference text, product_name text, ordered_at timestamptz,
  status text, quantity integer, total_amount integer, carrier text, tracking_number text, eligibility text
)
language sql stable set search_path = '' as $$
  select orders.id, orders.order_reference, orders.product_name, orders.ordered_at,
    orders.status, orders.quantity, orders.total_amount, orders.carrier, orders.tracking_number,
    public.check_mock_return(p_tenant, p_customer, orders.id)->>'status'
  from (
    select purchase.* from public.mock_orders purchase
    where purchase.tenant_id = p_tenant and purchase.customer_user_id = p_customer
      and (p_reference is null or purchase.order_reference = p_reference)
      and (p_product_hint is null or strpos(lower(purchase.product_name), lower(p_product_hint)) > 0)
    order by purchase.ordered_at desc, purchase.id desc
    limit 20
  ) orders
  order by orders.ordered_at desc, orders.id desc;
$$;

revoke all on function public.list_mock_return_eligibility(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.list_mock_return_eligibility(uuid,uuid,text,text) to service_role;

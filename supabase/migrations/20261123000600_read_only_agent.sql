alter table public.chat_sessions add column customer_user_id uuid references auth.users(id) on delete cascade;
alter table public.chat_messages add column tool_name text
  check (tool_name is null or (role = 'assistant' and tool_name in ('search_policies','search_products','get_order_status')));

create table public.mock_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  order_reference text not null check (order_reference ~ '^STY-[0-9]{4,8}$'),
  product_name text not null check (char_length(product_name) between 1 and 200),
  ordered_at timestamptz not null,
  status text not null check (status in ('preparing','in_transit','delivered')),
  unique (tenant_id, order_reference)
);
create index mock_orders_customer_idx on public.mock_orders(tenant_id, customer_user_id, ordered_at desc);
alter table public.mock_orders enable row level security;
revoke all on public.mock_orders from public, anon, authenticated;
grant select on public.mock_orders to authenticated;
grant all on public.mock_orders to service_role;

create policy own_mock_orders on public.mock_orders for select to authenticated
  using (customer_user_id = (select auth.uid()));

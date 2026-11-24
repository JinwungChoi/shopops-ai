alter table public.mock_orders
  add column quantity integer not null default 1 check (quantity between 1 and 100),
  add column total_amount integer check (total_amount >= 0),
  add column carrier text,
  add column tracking_number text,
  add constraint mock_orders_tenant_id_id_key unique (tenant_id, id);

create table public.mock_shipment_events (
  tenant_id uuid not null,
  order_id uuid not null,
  occurred_at timestamptz not null,
  location text not null,
  description text not null,
  primary key (tenant_id, order_id, occurred_at),
  foreign key (tenant_id, order_id) references public.mock_orders(tenant_id, id) on delete cascade
);
alter table public.mock_shipment_events enable row level security;
revoke all on public.mock_shipment_events from public, anon, authenticated;
grant all on public.mock_shipment_events to service_role;

alter table public.chat_messages drop constraint chat_messages_check;
alter table public.chat_messages add constraint chat_messages_tool_name_check
  check (tool_name is null or (role = 'assistant' and tool_name in (
    'search_policies','search_products','get_order_status','list_orders','track_shipment'
  )));
alter table public.chat_messages add column order_response jsonb
  check (order_response is null or (role = 'assistant' and jsonb_typeof(order_response) = 'object'));

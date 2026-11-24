alter table public.chat_messages add column reply_to_id uuid;
alter table public.chat_messages add constraint reply_in_same_tenant
  foreign key (tenant_id, reply_to_id) references public.chat_messages(tenant_id, id) on delete cascade;
create unique index chat_messages_one_answer on public.chat_messages (reply_to_id) where reply_to_id is not null;

create table private.request_limits (
  scope_hash text not null,
  window_start timestamptz not null,
  hits integer not null,
  primary key (scope_hash, window_start)
);
alter table private.request_limits enable row level security;

create function public.take_request_budget(p_scope_hash text, p_limit integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := date_trunc('minute', now());
  v_hits integer;
begin
  if p_scope_hash !~ '^[a-f0-9]{64}$' or p_limit not between 1 and 500 then
    raise exception 'invalid_budget';
  end if;
  delete from private.request_limits where window_start < v_window - interval '1 hour';
  insert into private.request_limits (scope_hash, window_start, hits)
  values (p_scope_hash, v_window, 1)
  on conflict (scope_hash, window_start) do update set hits = request_limits.hits + 1
  where request_limits.hits < p_limit
  returning hits into v_hits;
  return v_hits is not null;
end;
$$;

revoke all on function public.take_request_budget(text, integer) from public, anon, authenticated;
grant execute on function public.take_request_budget(text, integer) to service_role;

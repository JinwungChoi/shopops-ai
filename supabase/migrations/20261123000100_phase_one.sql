create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create schema if not exists private;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,49}$'),
  public_widget_key text not null unique default replace(gen_random_uuid()::text, '-', ''),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members(user_id, tenant_id);

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('faq', 'markdown')),
  title text not null check (char_length(title) between 1 and 200),
  content text not null check (char_length(content) between 1 and 10000),
  version integer not null default 1 check (version >= 1),
  active_version integer,
  index_status text not null default 'pending'
     check (index_status in ('pending','indexing','ready','failed')),
  error_code text,
  deleted_at timestamptz,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (active_version is null or active_version <= version), check (index_status <> 'ready' or active_version is not distinct from version)
);
create index knowledge_documents_tenant_status_idx
  on public.knowledge_documents(tenant_id, index_status) where deleted_at is null;

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  document_version integer not null check (document_version >= 1),
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  embedding extensions.vector(1536) not null,
  embedding_model text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.knowledge_documents(tenant_id, id) on delete cascade,
  unique (tenant_id, document_id, document_version, chunk_index)
);
create index knowledge_chunks_tenant_doc_idx
  on public.knowledge_chunks(tenant_id, document_id, document_version);
-- MVP는 tenant-scoped exact scan으로 시작한다. 실제 데이터/EXPLAIN을 확인한 뒤 HNSW 검토.
-- create index knowledge_chunks_hnsw_idx on public.knowledge_chunks
--   using hnsw (embedding extensions.vector_cosine_ops);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index chat_sessions_tenant_created_idx
  on public.chat_sessions(tenant_id, created_at desc);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  session_id uuid not null,
  role text not null check (role in ('user','assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  source_refs jsonb not null default '[]'::jsonb,
  abstained boolean not null default false,
  client_request_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, session_id)
    references public.chat_sessions(tenant_id, id) on delete cascade,
  check (jsonb_typeof(source_refs) = 'array')
);
create index chat_messages_session_idx
  on public.chat_messages(tenant_id, session_id, created_at);
create unique index chat_messages_request_dedupe_idx
  on public.chat_messages(tenant_id, session_id, client_request_id)
  where client_request_id is not null and role = 'user';

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  session_id uuid not null,
  title text not null,
  description text not null,
  status text not null default 'open'
    check (status in ('open','in_progress','resolved')),
  contact_info jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, session_id)
    references public.chat_sessions(tenant_id, id) on delete cascade
);
create index support_tickets_tenant_status_idx
  on public.support_tickets(tenant_id, status, created_at desc);

create table public.answer_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  rating text not null check (rating in ('helpful','unhelpful')),
  created_at timestamptz not null default now(),
  unique (message_id)
);
-- answer_feedback.tenant_id의 메시지 일치는 서버에서 검증해야 하며,
-- 실제 구현에서는 아래 복합 FK를 추가해 DB에서도 강제한다.
create unique index chat_messages_tenant_id_id_uq
  on public.chat_messages(tenant_id, id);
alter table public.answer_feedback
  add constraint feedback_same_tenant_fk
  foreign key (tenant_id, message_id)
  references public.chat_messages(tenant_id, id) on delete cascade;

create table public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id uuid,
  request_id uuid not null,
  provider text not null default 'openai',
  model text not null,
  operation text not null check (operation in ('embedding','generation','vision')),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_usd numeric(16,8),
  duration_ms integer,
  status text not null check (status in ('success','failed')),
  created_at timestamptz not null default now(),
  unique (request_id, operation),
  foreign key (tenant_id, session_id)
    references public.chat_sessions(tenant_id, id) on delete set null (session_id)
);
create index llm_usage_tenant_date_idx
  on public.llm_usage(tenant_id, created_at desc);

create table public.index_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  document_version integer not null,
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed')),
  attempt_count integer not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.knowledge_documents(tenant_id, id) on delete cascade,
  unique (tenant_id, document_id, document_version)
);


create or replace function private.is_tenant_member(p_tenant_id uuid)
returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.can_edit_tenant(p_tenant_id uuid)
returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'staff')
  );
$$;

revoke all on function private.is_tenant_member(uuid) from public;
revoke all on function private.can_edit_tenant(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_tenant_member(uuid) to authenticated;
grant execute on function private.can_edit_tenant(uuid) to authenticated;


create or replace function public.create_tenant(p_owner uuid, p_name text, p_slug text)
returns public.tenants language plpgsql security definer
set search_path = '' as $$
declare
  v_tenant public.tenants;
  v_user uuid := p_owner;
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;
  if char_length(p_name) not between 2 and 120
     or p_slug !~ '^[a-z0-9][a-z0-9-]{2,49}$' then
    raise exception 'invalid_tenant_input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));
  if (select count(*) from public.tenant_members
      where user_id = v_user and role = 'owner') >= 3 then
    raise exception 'tenant_quota_exceeded';
  end if;
  insert into public.tenants(name, slug)
    values (p_name, p_slug) returning * into v_tenant;
  insert into public.tenant_members(tenant_id, user_id, role)
    values (v_tenant.id, v_user, 'owner');
  return v_tenant;
end;
$$;
revoke all on function public.create_tenant(uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_tenant(uuid,text,text) to service_role;


alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.support_tickets enable row level security;
alter table public.answer_feedback enable row level security;
alter table public.llm_usage enable row level security;
alter table public.index_jobs enable row level security;

create policy tenant_read on public.tenants
  for select to authenticated
  using ((select private.is_tenant_member(id)));

create policy member_read on public.tenant_members
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

create policy documents_read on public.knowledge_documents
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

create policy sessions_read on public.chat_sessions
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

create policy messages_read on public.chat_messages
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

create policy tickets_read on public.support_tickets
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

create policy usage_read on public.llm_usage
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

create policy feedback_read on public.answer_feedback
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

create policy index_jobs_read on public.index_jobs
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

-- knowledge_chunks: 관리자/고객에게 직접 SELECT 정책을 주지 않는다.
-- 쓰기(INSERT/UPDATE/DELETE) 정책: 생성하지 않는다.
-- privileged 서버의 쓰기에는 반드시 API 계층의 선행 권한 검사가 필요.


revoke all on public.tenants, public.tenant_members, public.knowledge_documents,
  public.knowledge_chunks, public.chat_sessions, public.chat_messages, public.support_tickets,
  public.answer_feedback, public.llm_usage, public.index_jobs from anon, authenticated;
grant select on public.tenants, public.tenant_members, public.knowledge_documents,
  public.chat_messages, public.support_tickets, public.answer_feedback, public.llm_usage,
  public.index_jobs to authenticated;
grant select (id, tenant_id, expires_at, revoked_at, created_at) on public.chat_sessions to authenticated;
grant all on public.tenants, public.tenant_members, public.knowledge_documents,
  public.knowledge_chunks, public.chat_sessions, public.chat_messages, public.support_tickets,
  public.answer_feedback, public.llm_usage, public.index_jobs to service_role;

create or replace function public.search_tenant_chunks(
  p_tenant_id uuid,
  p_query_embedding extensions.vector(1536),
  p_match_count integer default 5,
  p_embedding_model text default 'text-embedding-3-small'
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_version integer,
  title text,
  content text,
  distance double precision
)
language sql stable security invoker
set search_path = public, extensions
as $$
  select c.id, c.document_id, c.document_version, d.title, c.content,
         (c.embedding <=> p_query_embedding)::double precision
  from public.knowledge_chunks c
  join public.knowledge_documents d
    on d.id = c.document_id and d.tenant_id = c.tenant_id
  where c.tenant_id = p_tenant_id
    and d.deleted_at is null
    and d.index_status = 'ready'
    and d.active_version = c.document_version
    and c.embedding_model = p_embedding_model
  order by c.embedding <=> p_query_embedding, c.id
  limit least(greatest(p_match_count, 1), 10);
$$;

revoke all on function public.search_tenant_chunks(uuid,extensions.vector,integer,text)
  from public, anon, authenticated;
grant execute on function public.search_tenant_chunks(uuid,extensions.vector,integer,text)
  to service_role;


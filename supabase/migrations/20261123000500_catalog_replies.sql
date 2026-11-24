alter table public.chat_messages add column catalog_response jsonb;
alter table public.chat_messages add column catalog_filters jsonb;

alter table public.chat_messages add constraint catalog_reply_shape check (
  (catalog_response is null and catalog_filters is null)
  or (role = 'assistant' and catalog_response is not null and catalog_filters is not null
    and jsonb_typeof(catalog_response) = 'object' and jsonb_typeof(catalog_filters) = 'object')
);

create index chat_messages_catalog_context_idx
  on public.chat_messages(tenant_id, session_id, created_at desc, id desc)
  where catalog_filters is not null;

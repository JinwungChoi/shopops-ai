create or replace function public.publish_document_chunks(
  p_tenant_id uuid,
  p_document_id uuid,
  p_version integer,
  p_model text,
  p_chunks jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document public.knowledge_documents;
begin
  select * into v_document from public.knowledge_documents
  where tenant_id = p_tenant_id and id = p_document_id for update;

  if not found or v_document.deleted_at is not null or v_document.version <> p_version
    or v_document.index_status <> 'pending' then
    return false;
  end if;

  if p_model is null or p_chunks is null or jsonb_typeof(p_chunks) <> 'array'
    or jsonb_array_length(p_chunks) not between 1 and 32 then
    raise exception 'invalid_chunks';
  end if;

  insert into public.knowledge_chunks
    (tenant_id, document_id, document_version, chunk_index, content, embedding, embedding_model)
  select p_tenant_id, p_document_id, p_version, (position - 1)::integer,
    chunk->>'content', (chunk->>'embedding')::extensions.vector(1536), p_model
  from jsonb_array_elements(p_chunks) with ordinality as chunks(chunk, position);

  update public.knowledge_documents
  set active_version = p_version, index_status = 'ready', indexed_at = now(), error_code = null
  where tenant_id = p_tenant_id and id = p_document_id;
  return true;
end;
$$;

revoke all on function public.publish_document_chunks(uuid,uuid,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.publish_document_chunks(uuid,uuid,integer,text,jsonb) to service_role;

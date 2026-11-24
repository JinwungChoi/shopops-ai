alter table public.index_jobs add column attempt_id uuid;
alter table public.index_jobs add column lease_until timestamptz;

create function public.claim_document_index(p_tenant_id uuid, p_document_id uuid, p_version integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_document public.knowledge_documents;
  v_attempt uuid;
begin
  select * into v_document from public.knowledge_documents
  where tenant_id = p_tenant_id and id = p_document_id for update;
  if not found or v_document.deleted_at is not null or v_document.version <> p_version
    or v_document.index_status = 'ready' then
    return null;
  end if;

  insert into public.index_jobs as jobs
    (tenant_id, document_id, document_version, status, attempt_count, attempt_id, lease_until)
  values
    (p_tenant_id, p_document_id, p_version, 'running', 1, gen_random_uuid(), now() + interval '45 seconds')
  on conflict (tenant_id, document_id, document_version) do update
  set status = 'running', attempt_count = jobs.attempt_count + 1, attempt_id = gen_random_uuid(),
      lease_until = now() + interval '45 seconds', error_code = null, updated_at = now()
  where jobs.status <> 'running' or jobs.lease_until is null or jobs.lease_until <= now()
  returning attempt_id into v_attempt;

  if v_attempt is not null then
    update public.knowledge_documents set index_status = 'indexing', active_version = null, error_code = null
    where id = p_document_id and tenant_id = p_tenant_id;
  end if;
  return v_attempt;
end;
$$;

create or replace function public.publish_document_chunks(
  p_tenant_id uuid, p_document_id uuid, p_version integer, p_model text, p_chunks jsonb
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_document public.knowledge_documents;
  v_attempt uuid := (p_chunks->>'attemptId')::uuid;
  v_chunks jsonb := p_chunks->'chunks';
begin
  select * into v_document from public.knowledge_documents
  where tenant_id = p_tenant_id and id = p_document_id for update;
  if not found or v_document.deleted_at is not null or v_document.version <> p_version
    or v_document.index_status <> 'indexing' then
    return false;
  end if;

  if p_model is null or v_chunks is null or jsonb_typeof(v_chunks) <> 'array'
    or jsonb_array_length(v_chunks) not between 1 and 32 then
    raise exception 'invalid_chunks';
  end if;

  update public.index_jobs set status = 'completed', lease_until = null, updated_at = now()
  where tenant_id = p_tenant_id and document_id = p_document_id and document_version = p_version
    and status = 'running' and attempt_id = v_attempt and lease_until > now();
  if not found then return false; end if;

  insert into public.knowledge_chunks
    (tenant_id, document_id, document_version, chunk_index, content, embedding, embedding_model)
  select p_tenant_id, p_document_id, p_version, (position - 1)::integer,
    chunk->>'content', (chunk->>'embedding')::extensions.vector(1536), p_model
  from jsonb_array_elements(v_chunks) with ordinality as chunks(chunk, position);

  update public.knowledge_documents
  set active_version = p_version, index_status = 'ready', indexed_at = now(), error_code = null
  where tenant_id = p_tenant_id and id = p_document_id;
  return true;
end;
$$;

create function public.fail_document_index(p_tenant_id uuid, p_document_id uuid, p_version integer, p_attempt_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.knowledge_documents
  where tenant_id = p_tenant_id and id = p_document_id and version = p_version
    and deleted_at is null and index_status = 'indexing' for update;
  if not found then return; end if;

  update public.index_jobs set status = 'failed', lease_until = null, error_code = 'INDEXING_FAILED', updated_at = now()
  where tenant_id = p_tenant_id and document_id = p_document_id and document_version = p_version
    and status = 'running' and attempt_id = p_attempt_id;
  if not found then return; end if;

  update public.knowledge_documents set index_status = 'failed', active_version = null, error_code = 'INDEXING_FAILED'
  where tenant_id = p_tenant_id and id = p_document_id;
end;
$$;

revoke all on function public.claim_document_index(uuid,uuid,integer), public.fail_document_index(uuid,uuid,integer,uuid)
  from public, anon, authenticated;
grant execute on function public.claim_document_index(uuid,uuid,integer), public.fail_document_index(uuid,uuid,integer,uuid)
  to service_role;

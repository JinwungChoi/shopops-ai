begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(16);

insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');

set local role service_role;
select public.create_tenant('11111111-1111-4111-8111-111111111111', 'Test Style', 'test-style-a');
select public.create_tenant('22222222-2222-4222-8222-222222222222', 'Test Gadget', 'test-gadget-b');
reset role;

select extensions.is((select count(*) from public.tenant_members where role = 'owner' and user_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')), 2::bigint, '업체 생성과 owner 배정');
insert into public.knowledge_documents (id, tenant_id, kind, title, content, version, active_version, index_status, deleted_at)
select fixture.id, t.id, 'faq', fixture.title, fixture.title, fixture.version, fixture.active_version, fixture.status, fixture.deleted_at
from public.tenants t
join (values
  ('test-style-a', 'a1111111-1111-4111-8111-111111111111'::uuid, 'STYLE', 2, 2, 'ready', null::timestamptz),
  ('test-gadget-b', 'b1111111-1111-4111-8111-111111111111'::uuid, 'GADGET', 1, 1, 'ready', null::timestamptz),
  ('test-style-a', 'a2222222-2222-4222-8222-222222222222'::uuid, 'DELETED', 1, 1, 'ready', now()),
  ('test-style-a', 'a3333333-3333-4333-8333-333333333333'::uuid, 'PENDING', 2, null, 'pending', null::timestamptz)
) fixture(slug, id, title, version, active_version, status, deleted_at) on fixture.slug = t.slug;

insert into public.knowledge_chunks (tenant_id, document_id, document_version, chunk_index, content, embedding, embedding_model)
select d.tenant_id, d.id, chunk.version, chunk.position, chunk.content,
       ('[1' || repeat(',0',1535) || ']')::extensions.vector, chunk.model
from public.knowledge_documents d
join (values
  ('STYLE', 1, 0, 'STALE', 'text-embedding-3-small'),
  ('STYLE', 2, 0, 'A-ONLY', 'text-embedding-3-small'),
  ('STYLE', 2, 1, 'OTHER-MODEL', 'other-model'),
  ('GADGET', 1, 0, 'B-ONLY', 'text-embedding-3-small'),
  ('DELETED', 1, 0, 'DELETED', 'text-embedding-3-small'),
  ('PENDING', 1, 0, 'PENDING', 'text-embedding-3-small')
) chunk(title, version, position, content, model) on d.title = chunk.title;

select extensions.ok(not has_function_privilege('anon','public.search_tenant_chunks(uuid,extensions.vector,integer,text)','EXECUTE'), '익명 검색 실행 권한 차단');
select extensions.ok(not has_function_privilege('authenticated','public.search_tenant_chunks(uuid,extensions.vector,integer,text)','EXECUTE'), '관리자 JWT 검색 실행 권한 차단');
select extensions.ok(not has_function_privilege('authenticated','public.create_tenant(uuid,text,text)','EXECUTE'), '업체 생성은 서버 전용');
select extensions.ok(not has_column_privilege('authenticated','public.chat_sessions','token_hash','SELECT'), '세션 토큰 해시 보호');
select extensions.ok(not has_table_privilege('authenticated','public.knowledge_documents','UPDATE'), '직접 문서 쓰기 차단');
select extensions.ok(not has_table_privilege('anon','public.knowledge_documents','SELECT'), '익명 문서 읽기 차단');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select extensions.is((select count(*) from public.knowledge_documents where title = 'STYLE'), 1::bigint, '자기 업체 문서 읽기');
select extensions.is((select count(*) from public.knowledge_documents where title = 'GADGET'), 0::bigint, '타 업체 문서 RLS 차단');
reset role;

set local role service_role;
select extensions.is(
  (select array_agg(content) from public.search_tenant_chunks(
    (select id from public.tenants where slug = 'test-style-a'),
    ('[1' || repeat(',0',1535) || ']')::extensions.vector)),
  array['A-ONLY']::text[], 'A 검색에서 타 업체, 이전 버전, 삭제, 대기, 다른 모델 제외'
);
select extensions.is(
  (select array_agg(content) from public.search_tenant_chunks(
    (select id from public.tenants where slug = 'test-gadget-b'),
    ('[1' || repeat(',0',1535) || ']')::extensions.vector)),
  array['B-ONLY']::text[], 'B 검색에서 B 청크만 반환'
);
reset role;

select extensions.throws_ok(
  'update public.knowledge_documents set active_version = 1 where title = ''STYLE''',
  '23514', null, 'ready 상태의 이전 버전을 DB 제약이 차단'
);
set local role service_role;
select extensions.ok(public.claim_document_index(
  (select id from public.tenants where slug = 'test-style-a'), 'a3333333-3333-4333-8333-333333333333', 2
) is not null, '대기 중인 문서의 인덱싱 작업을 획득');
select extensions.ok(public.claim_document_index(
  (select id from public.tenants where slug = 'test-style-a'), 'a3333333-3333-4333-8333-333333333333', 2
) is null, '진행 중인 버전은 중복 임베딩 호출 차단');
select public.fail_document_index(
  (select id from public.tenants where slug = 'test-style-a'),
  'a3333333-3333-4333-8333-333333333333', 2,
  (select attempt_id from public.index_jobs where document_id = 'a3333333-3333-4333-8333-333333333333')
);
select extensions.is((select index_status from public.knowledge_documents where title = 'PENDING'), 'failed', '인덱싱 실패 상태를 보존');
select extensions.ok(public.claim_document_index(
  (select id from public.tenants where slug = 'test-style-a'), 'a3333333-3333-4333-8333-333333333333', 2
) is not null, '실패 후 같은 문서 버전을 재시도');
reset role;
select * from extensions.finish();
rollback;

-- 공개 데모 매일 초기화: 스냅샷이 있는 업체만 되돌린다. DB 안의 pg_cron으로 돌려 공개 엔드포인트를 만들지 않는다.
create function public.reset_all_demos()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_count integer := 0;
begin
  for v_tenant in select tenant_id from private.demo_snapshots loop
    perform public.reset_demo(v_tenant);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.reset_all_demos() from public, anon, authenticated;
grant execute on function public.reset_all_demos() to service_role;

create extension if not exists pg_cron with schema pg_catalog;
-- 매일 04:00 KST(19:00 UTC). 같은 이름이면 덮어쓴다.
select cron.schedule('shopops-demo-reset', '0 19 * * *', 'select public.reset_all_demos()');

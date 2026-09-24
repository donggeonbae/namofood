-- Run claims are service-only. The app reads progress through a signed Edge request.
alter table public.namofood_recipe_runs add column if not exists targets jsonb not null default '[]'::jsonb;
create or replace function public.nmf_claim_recipe_run(p_id uuid, p_source text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('nmf_recipe_worker', 0));
  update public.namofood_recipe_runs
    set status='error', finished_at=now(), error='실행 제한시간 초과 — 자동 재시도 대기'
    where status='running' and started_at < now()-interval '4 minutes';
  if exists(select 1 from public.namofood_recipe_runs where status='running') then
    return false;
  end if;
  if exists(
    select 1 from (select status, finished_at from public.namofood_recipe_runs
      where status in ('done','error') order by started_at desc limit 1) r
    where r.status='error' and r.finished_at > now()-interval '2 minutes'
  ) then return false; end if;
  insert into public.namofood_recipe_runs(id,trigger_source,status,note)
    values(p_id,p_source,'running','저장된 식단 확인 중');
  return true;
end $$;
revoke all on function public.nmf_claim_recipe_run(uuid,text) from public,anon,authenticated;
grant execute on function public.nmf_claim_recipe_run(uuid,text) to service_role;
-- Retain the existing Vault-backed HTTP command; change only its cadence.
do $$ declare j record; begin
  for j in select jobid from cron.job where jobname in ('nmf-recipe-fill-10min','nmf-recipe-fill-1min') loop
    perform cron.alter_job(j.jobid, schedule := '* * * * *', active := true);
  end loop;
end $$;

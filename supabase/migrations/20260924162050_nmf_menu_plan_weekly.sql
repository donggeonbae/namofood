-- 나모푸드: AI 식단을 7일 단위로 보충하는 Edge Function 자동 호출.
-- 매일 06:05 KST(전날 21:05 UTC)에 상태를 확인하지만, 함수가 향후 완성 식단이
-- 7일 미만일 때만 OpenCode를 호출하므로 정상 운용 시 실제 생성은 주 1회다.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create table if not exists public.namofood_menu_runs (
    id uuid primary key default gen_random_uuid(),
    run_id uuid unique not null,
    target_start date,
    target_end date,
    trigger_source text not null default '',
    status text not null default 'running',
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    model text not null default '',
    added jsonb not null default '[]'::jsonb,
    headcounts jsonb not null default '{}'::jsonb,
    note text not null default '',
    error text not null default ''
);

alter table public.namofood_menu_runs enable row level security;
revoke all on table public.namofood_menu_runs from anon, authenticated;
grant select, insert, update, delete on table public.namofood_menu_runs to service_role;

create index if not exists idx_namofood_menu_runs_started
    on public.namofood_menu_runs(started_at desc);
create index if not exists idx_namofood_menu_runs_target_start
    on public.namofood_menu_runs(target_start desc);

-- 함수 URL은 Vault에 보관하고 재적용 시 현재 프로젝트 URL로 갱신한다.
do $$
declare
    secret_id uuid;
begin
    select id into secret_id
      from vault.secrets
     where name = 'nmf_menu_plan_url';

    if secret_id is null then
        perform vault.create_secret(
            'https://rycibsczsgbkgtwfxyim.supabase.co/functions/v1/nmf-menu-plan',
            'nmf_menu_plan_url',
            '나모푸드 AI 주간 식단 생성 함수 URL'
        );
    else
        perform vault.update_secret(
            secret_id,
            'https://rycibsczsgbkgtwfxyim.supabase.co/functions/v1/nmf-menu-plan',
            'nmf_menu_plan_url',
            '나모푸드 AI 주간 식단 생성 함수 URL'
        );
    end if;
end $$;

do $$
begin
    if exists (select 1 from cron.job where jobname = 'nmf-menu-plan-daily') then
        perform cron.unschedule('nmf-menu-plan-daily');
    end if;

    perform cron.schedule(
        'nmf-menu-plan-daily',
        '5 21 * * *',
        $cron$
        select net.http_post(
            url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_menu_plan_url'),
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-source', 'supabase_cron',
                'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
            ),
            body := '{}'::jsonb,
            timeout_milliseconds := 300000
        ) as request_id
        where exists (select 1 from vault.decrypted_secrets where name = 'nmf_menu_plan_url')
          and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');
        $cron$
    );
end $$;

-- 최초 2026-09-24 기준 2주(10월 7일까지)를 즉시 보충한다. pg_net 호출은
-- 트랜잭션 커밋 후 실행되어 위 로그 테이블도 함수에서 바로 사용할 수 있다.
select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_menu_plan_url'),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'bootstrap_migration',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
    ),
    body := '{"weeks":2}'::jsonb,
    timeout_milliseconds := 300000
) as request_id
where exists (select 1 from vault.decrypted_secrets where name = 'nmf_menu_plan_url')
  and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');

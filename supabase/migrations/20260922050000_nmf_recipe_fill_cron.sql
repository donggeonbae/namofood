-- 나모푸드: 레시피 자동 채움 Edge Function 을 매일 06:00 KST(21:00 UTC) 에 호출하는 pg_cron
-- 먼저 vault 에 두 비밀을 넣어야 동작합니다 (tools/nmf_cron_setup.ps1 이 대신 해 줍니다):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/nmf-recipe-fill', 'nmf_recipe_fill_url');
--   select vault.create_secret('<NMF_CRON_SECRET 과 같은 값>', 'nmf_recipe_fill_secret');

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create table if not exists public.namofood_recipe_runs (
    id uuid primary key default gen_random_uuid(),
    trigger_source text not null default '',
    status text not null default 'running',
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    added jsonb not null default '[]'::jsonb,
    note text not null default '',
    error text not null default ''
);
alter table public.namofood_recipe_runs enable row level security;
grant select, insert, update, delete on table public.namofood_recipe_runs to service_role;
create index if not exists idx_namofood_recipe_runs_started on public.namofood_recipe_runs(started_at desc);

do $$
begin
    if exists (select 1 from cron.job where jobname = 'nmf-recipe-fill-daily') then
        perform cron.unschedule('nmf-recipe-fill-daily');
    end if;
    perform cron.schedule(
        'nmf-recipe-fill-daily',
        '0 21 * * *',
        $cron$
        select net.http_post(
            url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_url'),
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-source', 'supabase_cron',
                'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
            ),
            body := '{}'::jsonb,
            timeout_milliseconds := 300000
        ) as request_id
        where exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_url')
          and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');
        $cron$
    );
end $$;

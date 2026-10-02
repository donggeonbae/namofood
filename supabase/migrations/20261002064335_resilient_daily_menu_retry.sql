-- Keep per-day attempts and model diagnostics durable for bounded recovery.
alter table public.namofood_menu_runs
  add column if not exists targets jsonb not null default '[]'::jsonb,
  add column if not exists generation jsonb not null default '{}'::jsonb;

-- Main generation stays at KST 06:05. Retry checks do not run models when complete,
-- cooling down, or after the per-date daily attempt cap in nmf-menu-plan.
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name='nmf_menu_plan_url')
     or not exists (select 1 from vault.decrypted_secrets where name='nmf_recipe_fill_secret') then
    raise exception 'Existing menu automation Vault configuration is missing';
  end if;
  perform cron.schedule(
    'nmf-menu-plan-retry',
    '*/15 * * * *',
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name='nmf_menu_plan_url'),
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'x-source','supabase_cron_retry',
          'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='nmf_recipe_fill_secret')
        ),
        body := '{"retry":true}'::jsonb,
        timeout_milliseconds := 130000
      ) as request_id;
    $cron$
  );
end $$;

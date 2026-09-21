-- 레시피 자동 채움을 매일 1회 → 15분마다 확인으로 변경 (함수가 최근 10분 내 저장이면 건너뜀)
do $$
begin
    if exists (select 1 from cron.job where jobname = 'nmf-recipe-fill-daily') then
        perform cron.unschedule('nmf-recipe-fill-daily');
    end if;
    if exists (select 1 from cron.job where jobname = 'nmf-recipe-fill-15min') then
        perform cron.unschedule('nmf-recipe-fill-15min');
    end if;
    perform cron.schedule(
        'nmf-recipe-fill-15min',
        '*/15 * * * *',
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

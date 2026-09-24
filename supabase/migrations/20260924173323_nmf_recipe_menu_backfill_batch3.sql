-- 9/24 AI 식단의 남은 신규 메뉴 레시피를 다음 8개까지 즉시 처리한다.
select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_url'),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'menu_recipe_backfill_batch3',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
    ),
    body := '{"force":true,"max":8}'::jsonb,
    timeout_milliseconds := 300000
) as request_id
where exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_url')
  and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');

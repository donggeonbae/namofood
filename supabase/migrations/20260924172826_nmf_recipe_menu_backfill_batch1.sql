-- 9/24 AI 식단 보충으로 새로 생긴 레시피 대기분을 병렬 생성기로 즉시 처리한다.
select net.http_post(
    url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'nmf_recipe_fill_url'
    ),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'menu_recipe_backfill_batch1',
        'Authorization', 'Bearer ' || (
            select decrypted_secret
              from vault.decrypted_secrets
             where name = 'nmf_recipe_fill_secret'
        )
    ),
    body := '{"force":true,"max":20}'::jsonb,
    timeout_milliseconds := 300000
) as request_id
where exists (
    select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_url'
)
  and exists (
    select 1
      from vault.decrypted_secrets
     where name = 'nmf_recipe_fill_secret'
  );

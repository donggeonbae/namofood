-- 메뉴별 독립 생성·부분 성공 저장 배포 뒤 새 식단의 레시피 대기분을 재처리한다.
select net.http_post(
    url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'nmf_recipe_fill_url'
    ),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'menu_recipe_backfill_batch2',
        'Authorization', 'Bearer ' || (
            select decrypted_secret
              from vault.decrypted_secrets
             where name = 'nmf_recipe_fill_secret'
        )
    ),
    body := '{"force":true,"max":8}'::jsonb,
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

-- 긴 2일 응답과 국 이름 검증 문제를 고친 하루 단위 생성기로
-- 2026-09-24~09-30의 비어 있는 메인2·부찬3·추가메뉴를 다시 보충한다.
select net.http_post(
    url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'nmf_menu_plan_url'
    ),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'sep24_daily_chunk_retry',
        'Authorization', 'Bearer ' || (
            select decrypted_secret
              from vault.decrypted_secrets
             where name = 'nmf_recipe_fill_secret'
        )
    ),
    body := '{"weeks":1}'::jsonb,
    timeout_milliseconds := 300000
) as request_id
where exists (
    select 1 from vault.decrypted_secrets where name = 'nmf_menu_plan_url'
)
  and exists (
    select 1
      from vault.decrypted_secrets
     where name = 'nmf_recipe_fill_secret'
  );

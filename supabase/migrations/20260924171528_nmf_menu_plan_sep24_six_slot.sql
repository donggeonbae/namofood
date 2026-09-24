-- 2026-09-24~09-30 기존 식단의 수동 셀은 보존하면서 새 6칸 기준에서
-- 비어 있는 메인2·부찬3과 선택 추가메뉴를 AI 함수가 보충하도록 한 번 호출한다.
select net.http_post(
    url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'nmf_menu_plan_url'
    ),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'sep24_6_slot_backfill',
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

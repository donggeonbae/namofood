-- 새 식단 함수 배포 뒤 즉시 한 번 실행한다.
-- 이미 7일 이상 채워져 있으면 LLM을 호출하지 않고 쌀밥 기본값, 사진 식수,
-- 10,000원 가격, 오래 남은 running 로그만 멱등하게 정리한다.
select net.http_post(
    url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'nmf_menu_plan_url'
    ),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'finalize_6_slot_menu',
        'Authorization', 'Bearer ' || (
            select decrypted_secret
              from vault.decrypted_secrets
             where name = 'nmf_recipe_fill_secret'
        )
    ),
    body := '{}'::jsonb,
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

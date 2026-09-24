-- 형식 검증 실패 조각 자동 재생성 배포 후 최초 범위를 다시 실행한다.
-- 이미 채워진 셀은 함수의 멱등 병합으로 보존된다.
select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_menu_plan_url'),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'bootstrap_validated_retry',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
    ),
    body := '{"weeks":2}'::jsonb,
    timeout_milliseconds := 300000
) as request_id
where exists (select 1 from vault.decrypted_secrets where name = 'nmf_menu_plan_url')
  and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');

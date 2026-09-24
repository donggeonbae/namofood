-- 식단 전용 저지연 OpenCode 모델과 2일 분할 생성 배포 후 최초 범위를 재시도한다.
-- 함수 병합은 멱등이므로 이미 채워진 셀은 보존된다.
select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_menu_plan_url'),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'bootstrap_flash',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
    ),
    body := '{"weeks":2}'::jsonb,
    timeout_milliseconds := 300000
) as request_id
where exists (select 1 from vault.decrypted_secrets where name = 'nmf_menu_plan_url')
  and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');

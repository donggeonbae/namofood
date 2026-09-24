-- 최초 7일 단일 응답이 모델 제한시간을 넘긴 뒤 2일 단위 생성기로 재시도한다.
-- 이미 식단이 채워졌다면 함수의 멱등 병합으로 메뉴는 바뀌지 않는다.
select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_menu_plan_url'),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'bootstrap_retry_chunked',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
    ),
    body := '{"weeks":2}'::jsonb,
    timeout_milliseconds := 300000
) as request_id
where exists (select 1 from vault.decrypted_secrets where name = 'nmf_menu_plan_url')
  and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');

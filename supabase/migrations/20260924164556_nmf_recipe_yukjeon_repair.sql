-- 2글자 메뉴 유사명 오판(육전→육수) 수정 배포 뒤 육전 레시피를 즉시 다시 채운다.
-- 같은 migration을 새 환경에 적용할 때 Vault 설정이 아직 없으면 호출하지 않는다.
select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_url'),
    headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'manual_yukjeon_fix',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret')
    ),
    body := '{"force":true,"max":1}'::jsonb,
    timeout_milliseconds := 140000
) as request_id
where exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_url')
  and exists (select 1 from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret');

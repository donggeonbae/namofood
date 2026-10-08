-- Recommendation-only preparation. Existing menu/recipe jobs remain untouched.
-- Asia/Seoul today..today+14 is inclusive. Dispatch at most two missing dates;
-- the Edge Function also leases a global two-job pool across devices and cron.
create schema if not exists namofood_private;
revoke all on schema namofood_private from public, anon, authenticated;

create or replace function namofood_private.dispatch_menu_recommendations()
returns table(target_date date, request_id bigint)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  slots_available integer;
  day_to_prepare date;
  cron_secret text;
begin
  select decrypted_secret into cron_secret
  from vault.decrypted_secrets where name = 'nmf_recipe_fill_secret';
  if cron_secret is null or cron_secret = '' then
    raise exception 'Recommendation scheduler credential is unavailable';
  end if;

  select greatest(0, 2 - count(*))::integer into slots_available
  from public.nmf_menu_recommend_banks
  where state_table = 'namofood_state' and room = 'namofood'
    and lease_token is not null and lease_expires_at > now();

  for day_to_prepare in
    select today_kst + offsets.day_offset
    from generate_series(0, 14) as offsets(day_offset)
    left join public.nmf_menu_recommend_banks banks
      on banks.state_table = 'namofood_state' and banks.room = 'namofood'
      and banks.target_date = today_kst + offsets.day_offset
    where banks.response is null
      and (banks.lease_token is null or banks.lease_expires_at <= now())
    -- New dates first, then oldest failed attempt: one failing date cannot
    -- starve the remaining two-week window indefinitely.
    order by banks.updated_at nulls first, offsets.day_offset
    limit slots_available
  loop
    target_date := day_to_prepare;
    request_id := net.http_post(
      url := 'https://rycibsczsgbkgtwfxyim.supabase.co/functions/v1/nmf-menu-recommend',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-source', 'recommendation_cron',
        'Authorization', 'Bearer ' || cron_secret
      ),
      body := jsonb_build_object('action', 'prepare', 'date', day_to_prepare),
      timeout_milliseconds := 150000
    );
    return next;
  end loop;
end;
$function$;

revoke all on function namofood_private.dispatch_menu_recommendations()
  from public, anon, authenticated;

-- cron.schedule with the same job name updates that job rather than adding one.
select cron.schedule(
  'nmf-menu-recommend-daily',
  '5 21 * * *', -- 06:05 KST
  $$select * from namofood_private.dispatch_menu_recommendations();$$
);
select cron.schedule(
  'nmf-menu-recommend-catchup',
  '*/5 * * * *',
  $$select * from namofood_private.dispatch_menu_recommendations();$$
);

-- No bootstrap HTTP request here: root deploys the compatible Edge Function first.

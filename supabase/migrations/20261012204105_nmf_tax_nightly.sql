-- Server-only encrypted daily estimates. No changes to source financial records.
create schema if not exists namofood_private;
revoke all on schema namofood_private from public,anon,authenticated;
create table if not exists namofood_private.tax_daily_runs(
 room text not null check(room='namofood'),run_day date not null,
 status text not null check(status in ('running','done','error')),
 lease_token uuid not null,started_at timestamptz not null default now(),
 completed_at timestamptz,error_code text,report_ciphertext text,
 primary key(room,run_day)
);
alter table namofood_private.tax_daily_runs enable row level security;
revoke all on namofood_private.tax_daily_runs from public,anon,authenticated;
create or replace function namofood_private.dispatch_tax_nightly()
returns bigint language plpgsql security invoker set search_path='' as $body$
declare credential text; request_id bigint;
begin
 select decrypted_secret into credential from vault.decrypted_secrets where name='nmf_recipe_fill_secret';
 if credential is null or credential='' then raise exception 'Nightly tax scheduler credential unavailable';end if;
 select net.http_post(url:='https://rycibsczsgbkgtwfxyim.supabase.co/functions/v1/nmf-tax-nightly',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||credential),
  body:='{"action":"run"}'::jsonb,timeout_milliseconds:=90000) into request_id;
 return request_id;
end;$body$;
revoke all on function namofood_private.dispatch_tax_nightly() from public,anon,authenticated;
select cron.schedule('nmf-tax-nightly','30 14 * * *',$$select namofood_private.dispatch_tax_nightly();$$);
-- 23:30 KST. No catch-up, automatic retries, browser generation or bootstrap run.

-- Supersedes the nightly job. The watcher only dispatches pending work, never idle AI calls.
select cron.unschedule(jobid) from cron.job where jobname = 'nmf-tax-nightly';

create table namofood_private.tax_auto_queue (
  room text primary key,
  revision bigint not null default 0,
  source_changed_at timestamptz not null default now(),
  needs_inspection boolean not null default true,
  finance_hash text,
  due_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  processing boolean not null default false,
  status text not null default 'idle' check(status in ('idle','waiting','running','done','error')),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text
);
create table namofood_private.tax_auto_reports (
  room text not null,
  year integer not null,
  report_ciphertext text not null,
  generated_at timestamptz not null default now(),
  primary key(room,year)
);
alter table namofood_private.tax_auto_queue enable row level security;
alter table namofood_private.tax_auto_reports enable row level security;
revoke all on namofood_private.tax_auto_queue, namofood_private.tax_auto_reports from public,anon,authenticated;
insert into namofood_private.tax_auto_queue(room) values ('namofood');

create function namofood_private.tax_source_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.id='namofood' and (TG_OP='INSERT' or new.data is distinct from old.data) then
    insert into namofood_private.tax_auto_queue(room,revision,source_changed_at,needs_inspection)
      values(new.id,1,clock_timestamp(),true)
      on conflict(room) do update set revision=tax_auto_queue.revision+1,
        source_changed_at=clock_timestamp(), needs_inspection=true;
  end if;
  return new;
end $$;
revoke all on function namofood_private.tax_source_changed() from public,anon,authenticated;
create trigger nmf_tax_source_changed after insert or update of data on public.namofood_state
for each row execute function namofood_private.tax_source_changed();

create function namofood_private.dispatch_tax_auto() returns void
language plpgsql security definer set search_path='' as $$
declare job record; secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name='nmf_recipe_fill_secret' limit 1;
  if secret is null then return; end if;
  for job in
    update namofood_private.tax_auto_queue set lease_token=gen_random_uuid(), lease_until=now()+interval '5 minutes',processing=false
    where (needs_inspection or due_at<=now()) and (lease_until is null or lease_until<now())
    returning room,lease_token
  loop
    perform net.http_post(
      url:='https://rycibsczsgbkgtwfxyim.supabase.co/functions/v1/nmf-tax-auto',
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),
      body:=jsonb_build_object('action','process','token',job.lease_token), timeout_milliseconds:=90000);
  end loop;
end $$;
revoke all on function namofood_private.dispatch_tax_auto() from public,anon,authenticated;
select cron.schedule('nmf-tax-quiet-watcher','10 seconds','select namofood_private.dispatch_tax_auto()');

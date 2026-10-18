-- Only the signed Edge Function and the Mac mini connector use these private tables.
create schema if not exists namofood_private;
create table if not exists namofood_private.coupang_connector (
  room text primary key check(room='namostore'),
  state text not null check(state in ('ready','login_required','blocked','error')),
  last_seen timestamptz not null default now()
);
create table if not exists namofood_private.coupang_jobs (
  id uuid primary key,
  room text not null check(room='namostore'),
  kind text not null check(kind in ('login','import')),
  from_date date,
  to_date date,
  status text not null check(status in ('queued','running','processing','done','error')),
  stage text not null,
  progress integer not null default 0 check(progress between 0 and 100),
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  result_ciphertext text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check((kind='login' and from_date is null and to_date is null) or (kind='import' and from_date<=to_date and to_date-from_date<=92))
);
create index if not exists coupang_jobs_pending on namofood_private.coupang_jobs(room,status,created_at);
alter table namofood_private.coupang_connector enable row level security;
alter table namofood_private.coupang_jobs enable row level security;
revoke all on namofood_private.coupang_connector,namofood_private.coupang_jobs from public,anon,authenticated;
grant all on namofood_private.coupang_connector,namofood_private.coupang_jobs to service_role;

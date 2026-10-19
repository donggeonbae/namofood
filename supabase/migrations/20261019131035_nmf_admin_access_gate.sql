-- Private auth rate buckets only. Access cutoff is a separate, last deployment step.
create schema if not exists namofood_private;
create table if not exists namofood_private.admin_attempts (
  bucket text primary key,
  window_start timestamptz not null,
  attempts integer not null check(attempts>0)
);
revoke all on namofood_private.admin_attempts from public,anon,authenticated;

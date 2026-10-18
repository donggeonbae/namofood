-- Separate store state uses existing encrypted rows, permissions and CAS writes.
-- Only extend the existing revision and private matching room allowlists.
begin;
create or replace function public.nmf_state_revision(room text)
returns table (updated_at timestamptz, revision text)
language sql stable security invoker set search_path = ''
as $$
  select s.updated_at,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.data, 'UTF8')), 'hex')
  from public.namofood_state as s
  where s.id = room and room in ('namofood', 'namocafe', 'namostore');
$$;
revoke all on function public.nmf_state_revision(text) from public;
grant execute on function public.nmf_state_revision(text) to anon, authenticated, service_role;
alter table namofood_private.payment_match_runs
  drop constraint payment_match_runs_room_check;
alter table namofood_private.payment_match_runs
  add constraint payment_match_runs_room_check check(room in ('namofood','namocafe','namostore'));
notify pgrst, 'reload schema';
commit;

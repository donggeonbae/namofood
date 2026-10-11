-- Small polling response only. Keep the caller's existing table/RLS permissions.
-- No data changes, security-definer access, new roles, or row-policy changes.
create or replace function public.nmf_state_revision(room text)
returns table (updated_at timestamptz, revision text)
language sql stable security invoker
set search_path = ''
as $$
  select s.updated_at,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.data, 'UTF8')), 'hex')
  from public.namofood_state as s
  where s.id = room and room in ('namofood', 'namocafe');
$$;

revoke all on function public.nmf_state_revision(text) from public;
grant execute on function public.nmf_state_revision(text) to anon, authenticated, service_role;
comment on function public.nmf_state_revision(text) is
  'Read-only encrypted-state revision for low-egress polling; respects invoker RLS.';
notify pgrst, 'reload schema';

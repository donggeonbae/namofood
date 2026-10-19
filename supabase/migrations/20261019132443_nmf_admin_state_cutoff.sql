-- Apply only after the authenticated proxy and new web bundle are available.
-- No records are deleted, no encryption password is changed. Background SQL and
-- service_role access are unchanged. Do not reopen these grants to fix UI bugs.
revoke all on public.namofood_state from anon,authenticated;
revoke all on public.namofood_recipe_runs from anon,authenticated;
revoke execute on function public.nmf_state_revision(text) from anon,authenticated;

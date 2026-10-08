-- Operator retirement (2026-10-08): never generate AI menus again.
-- Keep the jobs and their history recoverable, but deactivate only menu jobs.
-- Recipe fill/conversion cron jobs and stored food/recipe data are untouched.
do $$
declare
  menu_job record;
begin
  for menu_job in
    select jobid from cron.job
    where jobname in ('nmf-menu-plan-daily', 'nmf-menu-plan-retry')
  loop
    perform cron.alter_job(job_id := menu_job.jobid, active := false);
  end loop;
end $$;

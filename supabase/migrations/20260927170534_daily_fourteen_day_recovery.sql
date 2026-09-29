-- Keep the existing authenticated Vault-backed requests and their schedules (KST 06:05).
-- New function logic targets KST today+14, repairing empty cells only.
do $$ declare j record; begin
  for j in select jobid,command from cron.job where jobname='nmf-menu-plan-daily' loop
    perform cron.alter_job(j.jobid, schedule := '5 21 * * *', active := true);
    execute j.command;
  end loop;
end $$;

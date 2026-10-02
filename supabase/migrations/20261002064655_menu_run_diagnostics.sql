-- Safe to deploy before the new function: existing runs keep their defaults.
alter table public.namofood_menu_runs
  add column if not exists targets jsonb not null default '[]'::jsonb,
  add column if not exists generation jsonb not null default '{}'::jsonb;

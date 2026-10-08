-- Recommendation candidates only. This never writes namofood_state or snapshots.
create table if not exists public.nmf_menu_recommend_banks (
  state_table text not null,
  room text not null,
  target_date date not null,
  catalog_revision text not null,
  response jsonb,
  generated_at timestamptz,
  updated_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  primary key (state_table, room, target_date),
  constraint nmf_menu_recommend_response_object check (response is null or jsonb_typeof(response) = 'object'),
  constraint nmf_menu_recommend_ready_timestamp check ((response is null) = (generated_at is null)),
  constraint nmf_menu_recommend_lease_pair check ((lease_token is null) = (lease_expires_at is null))
);

alter table public.nmf_menu_recommend_banks enable row level security;
revoke all on table public.nmf_menu_recommend_banks from public, anon, authenticated;
grant select, insert, update on table public.nmf_menu_recommend_banks to service_role;

comment on table public.nmf_menu_recommend_banks is
  'Server-only shared daily AI recommendation banks; no automatic meal-menu changes. Lease duration 150 seconds.';

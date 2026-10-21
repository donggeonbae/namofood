-- Durable, non-sensitive cursor; encrypted order previews still expire after 24h.
alter table namofood_private.coupang_connector
  add column if not exists last_import_through date,
  add column if not exists last_import_at timestamptz;

create table namofood_private.payment_match_runs(
 room text not null check(room in ('namofood','namocafe')),
 batch_hash text not null,
 status text not null check(status in ('running','done','error')),
 lease_token uuid not null,
 started_at timestamptz not null default now(),
 completed_at timestamptz,
 error_code text,
 result_ciphertext text,
 primary key(room,batch_hash)
);
alter table namofood_private.payment_match_runs enable row level security;
revoke all on namofood_private.payment_match_runs from public,anon,authenticated;

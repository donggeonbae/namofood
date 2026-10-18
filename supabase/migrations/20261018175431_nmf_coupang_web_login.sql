-- Only public device keys and encrypted handshake metadata; never frames/keystrokes.
alter table namofood_private.coupang_jobs add column if not exists payload_ciphertext text;
alter table namofood_private.coupang_jobs drop constraint coupang_jobs_kind_check;
alter table namofood_private.coupang_jobs drop constraint coupang_jobs_check;
alter table namofood_private.coupang_jobs add constraint coupang_jobs_kind_check check(kind in ('login','import','pair','remote_login'));
alter table namofood_private.coupang_jobs add constraint coupang_jobs_check check((kind in ('login','pair','remote_login') and from_date is null and to_date is null) or (kind='import' and from_date<=to_date and to_date-from_date<=92));

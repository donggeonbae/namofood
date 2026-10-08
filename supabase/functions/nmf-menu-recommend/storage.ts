// Server-only daily recommendation banks. No application-state writes.
import { sql } from "../_shared/database.ts";
import type { RecommendationBank } from "./lib.ts";

export type BankKey = { stateTable: string; room: string; date: string };
export type StoredBank = {
  catalog_revision: string;
  response: unknown;
  updated_at: string;
  lease_expires_at: string | null;
};

export async function readRecommendationBank(
  key: BankKey,
): Promise<StoredBank | null> {
  const rows =
    await sql`select catalog_revision, response, updated_at, lease_expires_at
    from public.nmf_menu_recommend_banks
    where state_table=${key.stateTable} and room=${key.room} and target_date=${key.date}::date`;
  return (rows[0] as StoredBank | undefined) || null;
}

export async function acquireRecommendationLease(
  key: BankKey,
  revision: string,
  token: string,
  observedUpdatedAt: string | null,
): Promise<boolean> {
  // Compare the row version as well as lease expiry: a second reader must not
  // overwrite a bank saved after its read. A brief room lock limits every
  // isolate/device/cron combined to two active generations. No model call or
  // network wait happens in this transaction.
  return await sql.begin(async (transaction) => {
    const lockKey = JSON.stringify([key.stateTable, key.room]);
    await transaction`select pg_advisory_xact_lock(hashtextextended(${lockKey},0))`;
    const active = await transaction`select count(*)::integer as count
      from public.nmf_menu_recommend_banks
      where state_table=${key.stateTable} and room=${key.room} and lease_expires_at > now()`;
    if (Number(active[0]?.count || 0) >= 2) return false;
    const rows = await transaction`insert into public.nmf_menu_recommend_banks
    (state_table, room, target_date, catalog_revision, lease_token, lease_expires_at)
    values (${key.stateTable},${key.room},${key.date}::date,${revision},${token}::uuid,now()+interval '150 seconds')
    on conflict (state_table, room, target_date) do update set
      catalog_revision=excluded.catalog_revision, response=null, generated_at=null,
      lease_token=excluded.lease_token, lease_expires_at=excluded.lease_expires_at, updated_at=now()
    where (nmf_menu_recommend_banks.lease_expires_at is null or nmf_menu_recommend_banks.lease_expires_at <= now())
      and nmf_menu_recommend_banks.updated_at=${observedUpdatedAt}::timestamptz
    returning lease_token`;
    return rows.length === 1;
  });
}

export async function saveRecommendationBank(
  key: BankKey,
  revision: string,
  token: string,
  response: RecommendationBank,
): Promise<boolean> {
  if (response.date !== key.date) {
    throw new Error("Recommendation bank date mismatch");
  }
  const rows = await sql`update public.nmf_menu_recommend_banks set
    response=${
    sql.json(response)
  }, generated_at=${response.generatedAt}::timestamptz,
    lease_token=null, lease_expires_at=null, updated_at=now()
    where state_table=${key.stateTable} and room=${key.room} and target_date=${key.date}::date
      and catalog_revision=${revision} and lease_token=${token}::uuid and lease_expires_at > now()
    returning target_date`;
  return rows.length === 1;
}

export async function releaseRecommendationLease(
  key: BankKey,
  token: string,
): Promise<void> {
  await sql`update public.nmf_menu_recommend_banks set
    lease_token=null, lease_expires_at=null, updated_at=now()
    where state_table=${key.stateTable} and room=${key.room} and target_date=${key.date}::date
      and lease_token=${token}::uuid`;
}

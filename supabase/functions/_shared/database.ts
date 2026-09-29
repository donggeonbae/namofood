import postgres from "npm:postgres@3.4.7";

// Server-only connection supplied by Supabase, never passed to the browser.
export const sql = postgres(Deno.env.get("SUPABASE_DB_URL") || "", {
  prepare: false,
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
  connection: { statement_timeout: 15000 },
  types: {
    timestamp: {
      to: 1184,
      from: [1184, 1114],
      serialize: String,
      parse: String,
    },
  },
});

export async function readState(table: string, room: string) {
  return await sql`select data, updated_at from public.${
    sql(table)
  } where id=${room}`;
}
export async function writeState(
  table: string,
  room: string,
  expected: string,
  data: string,
  at: string,
) {
  return await sql`update public.${
    sql(table)
  } set data=${data}, updated_at=${at} where id=${room} and updated_at=${expected} returning id, updated_at`;
}
export async function snapshotState(
  table: string,
  id: string,
  data: string,
  at: string,
) {
  await sql`insert into public.${
    sql(table)
  } (id,data,updated_at) values (${id},${data},${at}) on conflict(id) do update set data=excluded.data,updated_at=excluded.updated_at`;
}
// JSON fields must stay JSONB, not Postgres arrays. Only server-created records enter here.
export function logValues(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map((
      [k, v],
    ) => [
      k,
      ["targets", "added", "headcounts"].includes(k)
        ? sql.json(v as postgres.JSONValue)
        : v,
    ]),
  ) as Record<string, postgres.ParameterOrJSON<never>>;
}

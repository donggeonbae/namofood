import { sql } from "../_shared/database.ts";

const room = "namostore";
export const queue = {
  async info() {
    const [row] =
      await sql`select state,last_seen from namofood_private.coupang_connector where room=${room}`;
    return {
      state: row?.state || "offline",
      lastSeen: row?.last_seen || null,
      online: !!row && Date.now() - Date.parse(String(row.last_seen)) < 65000,
    };
  },
  async heartbeat(state: string, jobId?: string, lease?: string) {
    await sql`insert into namofood_private.coupang_connector(room,state,last_seen) values(${room},${state},now()) on conflict(room) do update set state=excluded.state,last_seen=excluded.last_seen`;
    if (jobId && lease) {
      await sql`update namofood_private.coupang_jobs set lease_until=now()+interval '3 minutes' where id=${jobId}::uuid and lease_token=${lease}::uuid and status in ('running','processing')`;
    }
  },
  async get(id: string) {
    const [row] =
      await sql`select id,kind,status,stage,progress,error_code,result_ciphertext,created_at,completed_at from namofood_private.coupang_jobs where id=${id}::uuid and room=${room} and created_at>now()-interval '1 day'`;
    return row || null;
  },
  async latest() {
    const [row] =
      await sql`select id,kind,status,stage,progress,error_code,result_ciphertext,created_at,completed_at from namofood_private.coupang_jobs where room=${room} and kind='import' and created_at>now()-interval '1 day' order by created_at desc limit 1`;
    return row || null;
  },
  async enqueue(
    id: string,
    kind: string,
    from: string | null,
    to: string | null,
    payload: string | null = null,
  ) {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('nmf-coupang-queue',0))`;
      await tx`update namofood_private.coupang_jobs set status='error',error_code='worker_timeout',completed_at=now() where room=${room} and ((status in ('running','processing') and lease_until<now()) or (status='queued' and created_at<now()-interval '5 minutes'))`;
      await tx`delete from namofood_private.coupang_jobs where created_at<now()-interval '1 day' and status not in ('running','processing')`;
      const [same] =
        await tx`select id from namofood_private.coupang_jobs where room=${room} and (id=${id}::uuid or (kind=${kind} and kind in ('login','import') and status in ('queued','running','processing') and from_date is not distinct from ${from}::date and to_date is not distinct from ${to}::date)) order by created_at desc limit 1`;
      if (same) return String(same.id);
      const [rate] =
        await tx`select count(*) filter(where created_at>now()-interval '1 minute') as recent,count(*) filter(where status in ('queued','running','processing')) as pending,count(*) filter(where kind in ('pair','remote_login') and status in ('queued','running','processing')) as pending_remote,count(*) filter(where kind='pair' and created_at>now()-interval '10 minutes') as recent_pair from namofood_private.coupang_jobs where room=${room}`;
      if (Number(rate.recent) >= 6 || Number(rate.pending) >= 3) {
        throw Error("rate_limited");
      }
      if (
        ["pair", "remote_login"].includes(kind) &&
          Number(rate.pending_remote) > 0 ||
        kind === "pair" && Number(rate.recent_pair) >= 3
      ) throw Error("rate_limited");
      await tx`insert into namofood_private.coupang_jobs(id,room,kind,from_date,to_date,status,stage,progress,payload_ciphertext) values(${id}::uuid,${room},${kind},${from}::date,${to}::date,'queued','queued',0,${payload})`;
      return id;
    });
  },
  async claim() {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('nmf-coupang-queue',0))`;
      await tx`update namofood_private.coupang_jobs set status='error',error_code='worker_timeout',completed_at=now() where (status in ('running','processing') and lease_until<now()) or (status='queued' and created_at<now()-interval '5 minutes')`;
      const [active] =
        await tx`select id from namofood_private.coupang_jobs where status in ('running','processing') limit 1`;
      if (active) return null;
      const lease = crypto.randomUUID();
      const [row] =
        await tx`update namofood_private.coupang_jobs set status='running',stage='opening',progress=5,lease_token=${lease}::uuid,lease_until=now()+interval '3 minutes' where id=(select id from namofood_private.coupang_jobs where room=${room} and status='queued' order by created_at limit 1 for update skip locked) returning id,kind,from_date::text as from_date,to_date::text as to_date,payload_ciphertext`;
      return row
        ? {
          id: String(row.id),
          kind: row.kind,
          from: String(row.from_date || "").slice(0, 10),
          to: String(row.to_date || "").slice(0, 10),
          lease,
          payloadCiphertext: row.payload_ciphertext || null,
        }
        : null;
    });
  },
  async progress(id: string, lease: string, stage: string, progress: number) {
    await sql`update namofood_private.coupang_jobs set stage=${stage},progress=greatest(progress,${progress}),lease_until=now()+interval '3 minutes' where id=${id}::uuid and lease_token=${lease}::uuid and status='running' and lease_until>now()`;
  },
  async beginFinish(id: string, lease: string) {
    const [row] =
      await sql`update namofood_private.coupang_jobs set status='processing',stage='ai',progress=80,lease_until=now()+interval '3 minutes' where id=${id}::uuid and lease_token=${lease}::uuid and status='running' and lease_until>now() returning kind,from_date::text as from_date,to_date::text as to_date,payload_ciphertext`;
    return row || null;
  },
  async done(id: string, lease: string, ciphertext: string) {
    await sql`update namofood_private.coupang_jobs set status='done',stage='done',progress=100,result_ciphertext=${ciphertext},completed_at=now() where id=${id}::uuid and lease_token=${lease}::uuid and status='processing' and lease_until>now()`;
  },
  async fail(id: string, lease: string, code: string) {
    await sql`update namofood_private.coupang_jobs set status='error',stage='error',error_code=${code},completed_at=now() where id=${id}::uuid and lease_token=${lease}::uuid and status in ('running','processing')`;
  },
};

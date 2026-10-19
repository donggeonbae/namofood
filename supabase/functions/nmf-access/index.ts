import { readState, sql } from "../_shared/database.ts";
import { decryptText, encryptText } from "../nmf-recipe-fill/lib.ts";
import {
  adminAuthorized,
  equal,
  hmac,
  issueAdmin,
  passwordValid,
} from "../_shared/admin-auth.ts";
import "../../../assets/access-policy.js";
const policy = (globalThis as unknown as {
  NmfAccessPolicy: {
    project: (s: Record<string, unknown>) => Record<string, unknown>;
    mergeGuest: (
      s: Record<string, unknown>,
      v: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
}).NmfAccessPolicy;
const env = (k: string) => Deno.env.get(k) || "";
const rooms = new Set(["namofood", "namocafe", "namostore"]);
const origins = new Set(["https://d-bae.com", "https://donggeonbae.github.io"]);
const revision = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization,apikey,content-type,x-nmf-time,x-nmf-signature,x-nmf-admin-session",
  });
  if (origins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers });
  if (origin && !origins.has(origin)) {
    return json({ error: "origin_not_allowed" }, 403);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  try {
    if (!env("NMF_ADMIN_HASH") || !env("NMF_ADMIN_TOKEN_SECRET")) {
      return json({ error: "access_not_configured" }, 503);
    }
    const raw = await request.text();
    if (raw.length > 18 * 1024 * 1024) {
      return json({ error: "body_limit" }, 413);
    }
    const time = request.headers.get("x-nmf-time") || "", pw = env("NMF_PW");
    if (
      !pw || Math.abs(Date.now() - Number(time)) > 60000 ||
      !equal(
        request.headers.get("x-nmf-signature") || "",
        await hmac(pw, "nmf-access\n" + time + "\n" + raw),
      )
    ) return json({ error: "unauthorized" }, 401);
    const body = JSON.parse(raw), admin = await adminAuthorized(request);
    if (body.action === "login") {
      const address = (request.headers.get("x-forwarded-for") || "unknown")
        .split(",")[0].trim();
      const bucket = await hmac(env("NMF_ADMIN_TOKEN_SECRET"), address);
      const [globalAttempt] =
        await sql`insert into namofood_private.admin_attempts(bucket,window_start,attempts) values ('global',now(),1)
        on conflict(bucket) do update set attempts=case when admin_attempts.window_start<now()-interval '15 minutes' then 1 else admin_attempts.attempts+1 end,
        window_start=case when admin_attempts.window_start<now()-interval '15 minutes' then now() else admin_attempts.window_start end returning attempts`;
      if (Number(globalAttempt.attempts) > 40) {
        return json({ error: "잠시 후 다시 시도해 주세요. (15분 제한)" }, 429);
      }
      await sql`delete from namofood_private.admin_attempts where window_start<now()-interval '1 day'`;
      // One atomic upsert prevents parallel attempts bypassing the limit. No password/IP logging.
      const [attempt] =
        await sql`insert into namofood_private.admin_attempts(bucket,window_start,attempts) values (${bucket},now(),1)
        on conflict(bucket) do update set attempts=case when admin_attempts.window_start<now()-interval '15 minutes' then 1 else admin_attempts.attempts+1 end,
        window_start=case when admin_attempts.window_start<now()-interval '15 minutes' then now() else admin_attempts.window_start end returning attempts`;
      if (Number(attempt.attempts) > 8) {
        return json({ error: "잠시 후 다시 시도해 주세요. (15분 제한)" }, 429);
      }
      if (
        typeof body.password !== "string" || body.password.length > 128 ||
        !await passwordValid(body.password, env("NMF_ADMIN_HASH"))
      ) return json({ error: "관리자 비밀번호가 맞지 않습니다." }, 403);
      return json({
        ...await issueAdmin(env("NMF_ADMIN_TOKEN_SECRET")),
        cacheKey: await hmac(
          env("NMF_ADMIN_TOKEN_SECRET"),
          "nmf-private-cache-v1",
        ),
      });
    }
    if (body.action === "archiveLocal") {
      if (!rooms.has(body.room) || typeof body.data !== "string") {
        return json({ error: "invalid_archive" }, 400);
      }
      const decoded = JSON.parse(await decryptText(pw, body.data));
      if (!decoded.settings || !Array.isArray(decoded.staff)) {
        return json({ error: "invalid_archive" }, 400);
      }
      const id = body.room + "@local-draft-" + crypto.randomUUID();
      await sql`insert into public.namofood_state(id,data,updated_at)values(${id},${body.data},now())`;
      return json({ ok: true });
    }
    if (body.action !== "rest" || typeof body.path !== "string") {
      return json({ error: "invalid_action" }, 400);
    }
    const url = new URL(body.path, "https://local.invalid");
    const method = body.method || "GET";
    if (url.pathname === "/rest/v1/rpc/nmf_state_revision") {
      const room = url.searchParams.get("room");
      if (!rooms.has(room || "")) return json({ error: "forbidden" }, 403);
      const rows = await sql`select * from public.nmf_state_revision(${room!})`;
      return json(rows);
    }
    if (url.pathname !== "/rest/v1/namofood_state") {
      return json({ error: "forbidden" }, 403);
    }
    const idFilter = url.searchParams.get("id") || "";
    const rowBody = Array.isArray(body.body) ? body.body[0] : body.body;
    const id = idFilter.startsWith("eq.") ? idFilter.slice(3) : rowBody?.id;
    const root = typeof id === "string" ? id.split(/[#@]/)[0] : "";
    if (!rooms.has(root)) {
      // Admin backup listing/deletion stays constrained to a known root prefix.
      const prefix = idFilter.startsWith("like.") ? idFilter.slice(5) : "";
      if (
        !admin || !["namofood@%", "namocafe@%", "namostore@%"].includes(prefix)
      ) return json({ error: "forbidden" }, 403);
      if (method === "GET") {
        const rows =
          await sql`select id,updated_at from public.namofood_state where id like ${prefix} order by updated_at desc limit 400`;
        return json(rows);
      }
      if (method === "DELETE") {
        const before = url.searchParams.get("updated_at")?.replace(/^lt\./, "");
        if (!before || !Number.isFinite(Date.parse(before))) {
          return json({ error: "invalid_date" }, 400);
        }
        await sql`delete from public.namofood_state where id like ${prefix} and updated_at<${before}::timestamptz`;
        return json([]);
      }
      return json({ error: "forbidden" }, 403);
    }
    if (!admin && id !== root) return json({ error: "admin_required" }, 403);
    if (method === "GET") {
      const fields = (url.searchParams.get("select") || "data,updated_at")
        .split(",");
      if (fields.some((f) => !["id", "data", "updated_at"].includes(f))) {
        return json({ error: "invalid_select" }, 400);
      }
      if (!fields.includes("data")) {
        const rows =
          await sql`select id,updated_at from public.namofood_state where id=${id}`;
        return json(
          rows.map((row) =>
            Object.fromEntries(fields.map((key) => [key, row[key]]))
          ),
        );
      }
      const rows = await readState("namofood_state", id);
      for (const row of rows) {
        row.source_revision = await revision(String(row.data));
      }
      if (!admin) {
        for (const row of rows) {
          row.data = await encryptText(
            pw,
            JSON.stringify(
              policy.project(
                JSON.parse(await decryptText(pw, String(row.data))),
              ),
            ),
          );
        }
      }
      return json(
        rows.map((row) => ({
          ...Object.fromEntries(
            fields.map((key) => [key, key === "id" ? id : row[key]]),
          ),
          ...(id === root ? { source_revision: row.source_revision } : {}),
        })),
      );
    }
    if (
      !["POST", "PATCH"].includes(method) || !rowBody ||
      typeof rowBody.data !== "string" ||
      !Number.isFinite(Date.parse(rowBody.updated_at))
    ) return json({ error: "invalid_write" }, 400);
    const expected = url.searchParams.get("updated_at")?.replace(/^eq\./, "");
    const result = await sql.begin(async (tx) => {
      const [existing] =
        await tx`select data,updated_at from public.namofood_state where id=${id} for update`;
      if (
        method === "PATCH" &&
        (!existing || !expected ||
          new Date(existing.updated_at).getTime() !== Date.parse(expected))
      ) return [];
      if (
        method === "POST" && existing && !url.searchParams.has("on_conflict")
      ) return [];
      if (
        method === "POST" && existing && typeof body.prefer === "string" &&
        body.prefer.includes("resolution=ignore-duplicates")
      ) return [];
      let cipher = rowBody.data;
      if (!admin) {
        if (!existing) throw Error("guest_cannot_create_room");
        const full = JSON.parse(await decryptText(pw, String(existing.data))),
          incoming = JSON.parse(await decryptText(pw, rowBody.data));
        cipher = await encryptText(
          pw,
          JSON.stringify(policy.mergeGuest(full, incoming)),
        );
      }
      await tx`insert into public.namofood_state(id,data,updated_at)values(${id},${cipher},${rowBody.updated_at}) on conflict(id)do update set data=excluded.data,updated_at=excluded.updated_at`;
      if (!admin) {
        const backup = root + "@" + rowBody.updated_at.slice(0, 10);
        await tx`insert into public.namofood_state(id,data,updated_at)values(${backup},${cipher},${rowBody.updated_at}) on conflict(id)do update set data=excluded.data,updated_at=excluded.updated_at`;
      }
      return [{ id, updated_at: rowBody.updated_at }];
    });
    return json(result);
  } catch {
    return json({
      error: "요청을 처리하지 못했습니다. 자료는 삭제되지 않았습니다.",
    }, 400);
  }
});

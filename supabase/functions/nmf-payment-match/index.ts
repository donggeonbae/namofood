import { sql } from "../_shared/database.ts";
import { decryptText, encryptText } from "../nmf-recipe-fill/lib.ts";
import { equal } from "../nmf-tax-nightly/auth.ts";
import { candidatesFrom, reviewPayments, sha, signature } from "./lib.ts";
import { adminAuthorized } from "../_shared/admin-auth.ts";
const env = (k: string) => (Deno.env.get(k) || "").trim();
const origins = new Set(["https://d-bae.com", "https://donggeonbae.github.io"]);
Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "",
    headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "apikey,content-type,x-nmf-time,x-nmf-signature,x-nmf-admin-session",
    });
  if (origins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { headers, status });
  if (origin && !origins.has(origin)) return json({ ok: false }, 403);
  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "POST") return json({ ok: false }, 405);
  if (env("NMF_ADMIN_HASH") && !await adminAuthorized(request)) {
    return json({ ok: false, error: "관리자 인증이 필요합니다." }, 403);
  }
  const raw = await request.text();
  if (raw.length > 150000) return json({ ok: false }, 413);
  const pw = env("NMF_PW"), time = request.headers.get("x-nmf-time") || "";
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false }, 400);
  }
  if (
    !body || body.action !== "match" ||
    !["namofood", "namocafe", "namostore"].includes(body.room)
  ) return json({ ok: false }, 400);
  if (
    !pw || !/^\d{13}$/.test(time) ||
    Math.abs(Date.now() - Number(time)) > 60000 ||
    !equal(
      request.headers.get("x-nmf-signature") || "",
      await signature(pw, body.room, time, await sha(raw)),
    )
  ) return json({ ok: false }, 401);
  let candidates;
  try {
    candidates = candidatesFrom(body.candidates);
  } catch {
    return json({
      ok: false,
      error: "연결 후보의 날짜·금액·형식을 확인해 주세요",
    }, 400);
  }
  if (!candidates.length) {
    return json({ ok: true, matches: [], model: "claude-haiku-5-5" });
  }
  const hash = await sha(JSON.stringify(["claude-haiku-5-5", candidates])),
    token = crypto.randomUUID(),
    room = body.room;
  let claimed = false;
  try {
    const claim = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${
        "nmf-payment-match:" + room
      },0))`;
      const [cached] =
        await tx`select status,started_at from namofood_private.payment_match_runs where room=${room} and batch_hash=${hash}`;
      if (
        cached?.status === "done" ||
        cached?.status === "running" &&
          Date.now() - Date.parse(String(cached.started_at)) < 300000
      ) return "existing";
      if (cached && body.retry !== true) return "existing";
      const [rate] =
        await tx`select count(*) filter(where status='running' and started_at>now()-interval '5 minutes') as active,count(*) filter(where started_at>now()-interval '1 minute') as recent from namofood_private.payment_match_runs where room=${room}`;
      if (Number(rate.active) >= 2 || Number(rate.recent) >= 4) {
        return "limited";
      }
      if (!cached) {
        const inserted =
          await tx`insert into namofood_private.payment_match_runs(room,batch_hash,status,lease_token) values(${room},${hash},'running',${token}::uuid) on conflict(room,batch_hash) do nothing returning room`;
        return inserted.length ? "claimed" : "existing";
      }
      const retry =
        await tx`update namofood_private.payment_match_runs set status='running',lease_token=${token}::uuid,started_at=now(),error_code=null where room=${room} and batch_hash=${hash} and ((status='error' and started_at<now()-interval '30 seconds') or (status='running' and started_at<now()-interval '5 minutes')) returning room`;
      return retry.length ? "claimed" : "existing";
    });
    if (claim === "limited") {
      return json({
        ok: false,
        error:
          "다른 후보를 검토 중이거나 요청이 많습니다. 잠시 후 다시 확인해 주세요.",
      }, 429);
    }
    claimed = claim === "claimed";
    if (!claimed) {
      const [cached] =
        await sql`select status,result_ciphertext,started_at,error_code from namofood_private.payment_match_runs where room=${room} and batch_hash=${hash}`;
      if (cached?.status === "done" && cached.result_ciphertext) {
        return json({
          ok: true,
          matches: JSON.parse(
            await decryptText(pw, String(cached.result_ciphertext)),
          ),
          model: "claude-haiku-5-5",
          cached: true,
        });
      }
      if (cached?.status === "running") {
        return json({
          ok: false,
          error:
            "다른 기기에서 같은 후보를 검토 중입니다. 잠시 후 다시 확인해 주세요.",
        }, 202);
      }
      if (!claimed) {
        return json({
          ok: false,
          error:
            "지난 후보 검토가 실패했습니다. 새 자료를 저장하거나 잠시 후 AI 연결 확인을 눌러 주세요.",
        }, 503);
      }
    }
    const matches = await reviewPayments(
      candidates,
      env("NMF_PAYMENT_API_KEY") || env("NMF_INVOICE_API_KEY") ||
        env("OPENCODE_GO_API_KEY") || env("OPENCODE_API_KEY"),
    );
    const ciphertext = await encryptText(pw, JSON.stringify(matches));
    await sql`update namofood_private.payment_match_runs set status='done',completed_at=now(),result_ciphertext=${ciphertext} where room=${room} and batch_hash=${hash} and lease_token=${token}::uuid`;
    return json({ ok: true, matches, model: "claude-haiku-5-5", cached: false });
  } catch (error) {
    const message = error instanceof Error
        ? error.message
        : "payment_match_failed",
      code =
        /^(provider_http_\d+|provider_incomplete|invalid_response|not_configured)$/
            .test(message)
          ? message
          : "payment_match_failed";
    if (claimed) {
      await sql`update namofood_private.payment_match_runs set status='error',completed_at=now(),error_code=${code} where room=${room} and batch_hash=${hash} and lease_token=${token}::uuid`;
    }
    return json({ ok: false, error: "AI 연결 검토 실패 · " + code }, 503);
  }
});

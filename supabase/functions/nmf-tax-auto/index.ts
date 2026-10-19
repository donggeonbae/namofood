import { readState, sql } from "../_shared/database.ts";
import { decryptText, encryptText } from "../nmf-recipe-fill/lib.ts";
import {
  buildCostReview,
  buildTaxReport,
  kstDay,
  reviewTax,
  type TaxState,
} from "../nmf-tax-nightly/lib.ts";
import { equal, statusAuthorized } from "../nmf-tax-nightly/auth.ts";
import { financeHash, inspectFinance } from "./debounce.ts";
import { adminAuthorized } from "../_shared/admin-auth.ts";

const env = (key: string, fallback = "") =>
  (Deno.env.get(key) || fallback).trim();
const ROOM = "namofood";
const origins = new Set(["https://d-bae.com", "https://donggeonbae.github.io"]);
Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization,apikey,content-type,x-nmf-time,x-nmf-signature,x-nmf-admin-session",
  });
  if (origins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { headers, status });
  if (origin && !origins.has(origin)) {
    return json({ ok: false, reason: "origin_not_allowed" }, 403);
  }
  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "POST") return json({ ok: false }, 405);
  const raw = await request.text();
  if (raw.length > 1024) return json({ ok: false }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false }, 400);
  }
  const password = env("NMF_PW");
  if (body?.action === "status") {
    if (env("NMF_ADMIN_HASH") && !await adminAuthorized(request)) {
      return json({ ok: false, error: "관리자 인증이 필요합니다." }, 403);
    }
    const year = String(body.year || "");
    if (
      !/^20\d{2}$/.test(year) ||
      !await statusAuthorized(request, password, year, Date.now())
    ) return json({ ok: false }, 401);
    try {
      const [q] =
        await sql`select needs_inspection,due_at,status,started_at,completed_at,error_code from namofood_private.tax_auto_queue where room=${ROOM}`;
      const [r] =
        await sql`select report_ciphertext from namofood_private.tax_auto_reports where room=${ROOM} and year=${
          Number(year)
        }`;
      return json({
        ok: true,
        configured: Boolean(
          password && env("SUPABASE_DB_URL") && env("NMF_CRON_SECRET") &&
            (env("NMF_TAX_API_KEY") || env("NMF_INVOICE_API_KEY") ||
              env("OPENCODE_GO_API_KEY") || env("OPENCODE_API_KEY")),
        ),
        model: env("NMF_TAX_MODEL", "claude-haiku-5-5"),
        pending: Boolean(q?.needs_inspection || q?.due_at),
        dueAt: q?.due_at || null,
        last: q
          ? {
            status: q.status,
            startedAt: q.started_at,
            completedAt: q.completed_at,
            errorCode: q.error_code,
          }
          : null,
        report: r
          ? JSON.parse(await decryptText(password, String(r.report_ciphertext)))
          : null,
      });
    } catch {
      return json({
        ok: false,
        error: "세금 계산 상태를 읽지 못했습니다. 잠시 후 다시 확인해 주세요.",
      }, 503);
    }
  }
  const secret = env("NMF_CRON_SECRET");
  if (
    !secret ||
    !equal(request.headers.get("authorization") || "", "Bearer " + secret)
  ) return json({ ok: false }, 401);
  if (body?.action !== "process" || !/^[0-9a-f-]{36}$/.test(body.token || "")) {
    return json({ ok: false }, 400);
  }
  const token = body.token;
  const [q] =
    await sql`update namofood_private.tax_auto_queue set processing=true where room=${ROOM} and lease_token=${token}::uuid and lease_until>now() and not processing returning revision,source_changed_at,finance_hash,due_at`;
  if (!q) return json({ ok: true, skipped: "lease" });
  let attemptedHash: string | null = null;
  try {
    const [stored] = await readState("namofood_state", ROOM);
    if (!stored?.data) throw Error("state_missing");
    const state = JSON.parse(
      await decryptText(password, String(stored.data)),
    ) as TaxState;
    const inspected = inspectFinance(
      q.finance_hash === null ? null : String(q.finance_hash),
      await financeHash(state),
      String(q.source_changed_at),
      q.due_at ? String(q.due_at) : null,
    );
    const [current] =
      await sql`update namofood_private.tax_auto_queue set finance_hash=${inspected.hash},due_at=${inspected.dueAt}::timestamptz,needs_inspection=false,status=case when ${inspected.dueAt}::timestamptz is null then status else 'waiting' end,error_code=case when ${inspected.changed} then null else error_code end where room=${ROOM} and revision=${q.revision} and lease_token=${token}::uuid returning due_at`;
    if (!current) return json({ ok: true, skipped: "newer_edit" });
    if (!current.due_at || Date.parse(String(current.due_at)) > Date.now()) {
      return json({
        ok: true,
        waiting: Boolean(current.due_at),
        baseline: inspected.baseline,
      });
    }
    const running =
      await sql`update namofood_private.tax_auto_queue set status='running',started_at=now(),error_code=null where room=${ROOM} and revision=${q.revision} and lease_token=${token}::uuid and not needs_inspection returning room`;
    if (!running.length) return json({ ok: true, skipped: "newer_edit" });
    attemptedHash = inspected.hash;
    const report = buildTaxReport(state, kstDay(Date.now()));
    const ai = await reviewTax(report, {
      apiKey: env("NMF_TAX_API_KEY") || env("NMF_INVOICE_API_KEY") ||
        env("OPENCODE_GO_API_KEY") || env("OPENCODE_API_KEY"),
      baseUrl: env("NMF_TAX_BASE_URL", "https://opencode.ai/zen/go/v1"),
      model: env("NMF_TAX_MODEL", "claude-haiku-5-5"),
    });
    const cipher = await encryptText(
      password,
      JSON.stringify({
        ...report,
        costReview: buildCostReview(report),
        ai,
        generatedAt: new Date().toISOString(),
        sourceUpdatedAt: String(stored.updated_at),
      }),
    );
    // Unrelated edits during review can retain this result without a second AI call.
    const [latestQueue] =
      await sql`select revision from namofood_private.tax_auto_queue where room=${ROOM} and lease_token=${token}::uuid`;
    if (latestQueue && String(latestQueue.revision) !== String(q.revision)) {
      const [latestState] = await readState("namofood_state", ROOM);
      if (
        latestState?.data &&
        await financeHash(
            JSON.parse(await decryptText(password, String(latestState.data))),
          ) === inspected.hash
      ) {
        const unchanged =
          await sql`update namofood_private.tax_auto_queue set needs_inspection=false where room=${ROOM} and revision=${latestQueue.revision} and lease_token=${token}::uuid returning revision`;
        if (unchanged.length) q.revision = latestQueue.revision;
      }
    }
    // One atomic statement: stale financial results never replace the previous successful report.
    const saved =
      await sql`with valid as (update namofood_private.tax_auto_queue set status='done',completed_at=now(),due_at=null,error_code=null where room=${ROOM} and revision=${q.revision} and lease_token=${token}::uuid and not needs_inspection returning room) insert into namofood_private.tax_auto_reports(room,year,report_ciphertext) select room,${report.year},${cipher} from valid on conflict(room,year) do update set report_ciphertext=excluded.report_ciphertext,generated_at=now() returning room`;
    return json({ ok: true, status: saved.length ? "done" : "superseded" });
  } catch (error) {
    // An unrelated edit during a failed review must not create an AI retry loop.
    if (attemptedHash) {
      try {
        const [latestQueue] =
          await sql`select revision from namofood_private.tax_auto_queue where room=${ROOM} and lease_token=${token}::uuid`;
        if (
          latestQueue && String(latestQueue.revision) !== String(q.revision)
        ) {
          const [latestState] = await readState("namofood_state", ROOM);
          if (
            latestState?.data &&
            await financeHash(
                JSON.parse(
                  await decryptText(password, String(latestState.data)),
                ),
              ) === attemptedHash
          ) {
            const matched =
              await sql`update namofood_private.tax_auto_queue set needs_inspection=false where room=${ROOM} and revision=${latestQueue.revision} and lease_token=${token}::uuid returning revision`;
            if (matched.length) q.revision = latestQueue.revision;
          }
        }
      } catch {
        /* Keep newer financial work pending if comparison is unavailable. */
      }
    }
    const message = error instanceof Error ? error.message : "tax_job_failed";
    const code = /^(tax_ai_[a-z0-9_]+|state_missing)$/.test(message)
      ? message
      : "tax_job_failed";
    // No automatic retry loop for a failed financial version. New sales/order edits retry.
    await sql`update namofood_private.tax_auto_queue set status='error',completed_at=now(),error_code=${code},due_at=null where room=${ROOM} and revision=${q.revision} and lease_token=${token}::uuid`;
    return json({ ok: false, reason: code }, 503);
  } finally {
    await sql`update namofood_private.tax_auto_queue set lease_token=null,lease_until=null,processing=false where room=${ROOM} and lease_token=${token}::uuid`;
  }
});

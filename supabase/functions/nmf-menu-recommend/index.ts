// 나모푸드 식단 AI 추천 — 날짜별 후보만 서버에 보관한다.
// 실제 상태/식단/인원/레시피/스냅샷은 수정하지 않는다.
import { readState } from "../_shared/database.ts";
import { dishAliases } from "../_shared/institutional-menu.ts";
import { decryptText } from "../nmf-recipe-fill/lib.ts";
import {
  assertDate,
  buildRecommendationInput,
  type MenuRecommendState,
  type RecommendationBank,
  recommendationCatalogRevision,
  recommendationErrorStatus,
  runRecommendationModel,
  validateStoredRecommendationBank,
} from "./lib.ts";
import {
  acquireRecommendationLease,
  type BankKey,
  readRecommendationBank,
  releaseRecommendationLease,
  saveRecommendationBank,
  type StoredBank,
} from "./storage.ts";

type Body = { date?: unknown; nonce?: unknown; action?: unknown };

const CORS_ORIGINS = new Set([
  "https://d-bae.com",
  "https://donggeonbae.github.io",
]);

const env = (key: string, fallback = ""): string =>
  (Deno.env.get(key) ?? fallback).trim();
const TABLE = env("NMF_TABLE", "namofood_state");
const ROOM = env("NMF_ROOM", "namofood");

class BankStorageError extends Error {}

async function storageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new BankStorageError(
      "서버 추천 보관함을 읽거나 저장하지 못했습니다. 잠시 후 다시 확인해 주세요.",
    );
  }
}

function jsonForRequest(request: Request) {
  const origin = request.headers.get("origin") || "";
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-nmf-time, x-nmf-signature",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  });
  if (CORS_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers });
}

function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) different |= (a[i] || 0) ^ (b[i] || 0);
  return different === 0;
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
}

async function signMessage(
  password: string,
  message: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(message)),
  );
}

async function verifyRequest(
  password: string,
  date: string,
  nonce: string,
  timestamp: string,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !password || !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 60_000 ||
    !/^[A-Za-z0-9_-]{0,64}$/.test(nonce)
  ) return false;
  const expected = await signMessage(
    password,
    `nmf-menu-recommend:${date}:${nonce}:${timestamp}`,
  );
  const supplied = hexToBytes(signature);
  return Boolean(supplied && safeEqual(expected, supplied));
}

async function requestBody(request: Request): Promise<Body> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? parsed as Body : {};
  } catch {
    return {};
  }
}

function cloneResponse(
  value: RecommendationBank,
  cached: boolean,
): RecommendationBank {
  return {
    ...value,
    cached,
    slots: JSON.parse(JSON.stringify(value.slots)),
    warnings: value.warnings.slice(),
    aliases: { ...value.aliases },
    attempts: value.attempts.map((item) => ({ ...item })),
    expectedCounts: { ...value.expectedCounts },
  };
}

async function loadState(password: string): Promise<MenuRecommendState> {
  const rows = await readState(TABLE, ROOM);
  const row = rows[0];
  if (!row?.data) throw new Error("저장된 나모푸드 상태가 없습니다");
  return JSON.parse(await decryptText(password, String(row.data)));
}

Deno.serve(async (request: Request) => {
  const json = jsonForRequest(request);
  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "POST") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }

  const body = await requestBody(request);
  const date = String(body.date || "").trim();
  const nonce = String(body.nonce || "").trim();
  const preparing = body.action === "prepare";
  if (body.action !== undefined && !preparing) {
    return json({ ok: false, reason: "invalid_action" }, 400);
  }
  try {
    assertDate(date);
  } catch (error) {
    return json({
      ok: false,
      reason: "invalid_date",
      error: error instanceof Error ? error.message : String(error),
    }, 400);
  }
  if (!/^[A-Za-z0-9_-]{0,64}$/.test(nonce)) {
    return json({
      ok: false,
      reason: "invalid_nonce",
      error: "nonce는 영문·숫자·_·- 64자 이하만 허용합니다",
    }, 400);
  }

  const password = env("NMF_PW");
  const timestamp = request.headers.get("x-nmf-time") || "";
  const signature = request.headers.get("x-nmf-signature") || "";
  const secret = env("NMF_CRON_SECRET");
  const bearer = request.headers.get("authorization") || "";
  const enc = new TextEncoder();
  const authorized = preparing
    ? Boolean(
      secret && safeEqual(enc.encode(bearer), enc.encode(`Bearer ${secret}`)),
    )
    : await verifyRequest(password, date, nonce, timestamp, signature);
  if (!authorized) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  if (preparing) {
    const today = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(
      0,
      10,
    );
    const lastDate = new Date(
      Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000,
    )
      .toISOString().slice(0, 10);
    if (date < today || date > lastDate) {
      return json({ ok: false, reason: "prepare_date_out_of_range" }, 400);
    }
  }

  try {
    const state = await loadState(password);
    const revision = await recommendationCatalogRevision(state);
    const key: BankKey = { stateTable: TABLE, room: ROOM, date };
    const dailyNonce = `daily-${date}`;
    // Generation still avoids actual adjacent menus. Durable validation does
    // not reroll the bank when a user subsequently chooses one of its dishes.
    const input = buildRecommendationInput(state, date, dailyNonce);
    const catalogInput = buildRecommendationInput(
      { ...state, menus: {} },
      date,
      dailyNonce,
    );
    const validStored = (row: StoredBank | null): RecommendationBank | null =>
      row?.catalog_revision === revision
        ? validateStoredRecommendationBank(row.response, catalogInput)
        : null;
    const stored = await storageOperation(() => readRecommendationBank(key));
    const ready = validStored(stored);
    if (ready) return json(cloneResponse(ready, true));
    const expectedTotal = Object.values(input.expectedCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (expectedTotal <= 0) {
      return json({
        ok: false,
        reason: "no_candidates",
        error: "추천 가능한 기존 레시피 후보가 없습니다",
        warnings: input.warnings,
      }, 503);
    }
    const leaseToken = crypto.randomUUID();
    const acquired = await storageOperation(() =>
      acquireRecommendationLease(
        key,
        revision,
        leaseToken,
        stored?.updated_at || null,
      )
    );
    if (!acquired) {
      const current = await storageOperation(() => readRecommendationBank(key));
      const completed = validStored(current);
      if (completed) return json(cloneResponse(completed, true));
      return json(
        { ok: false, reason: "bank_pending", retryAfterSeconds: 5 },
        202,
      );
    }
    try {
      const result = await runRecommendationModel(input, {
        apiKey: env("OPENCODE_API_KEY") || env("OPENCODE_GO_API_KEY"),
        baseUrl: env("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1"),
        primaryModel: env(
          "NMF_MENU_RECOMMEND_MODEL",
          env("NMF_MENU_MODEL", "deepseek-v4.1-flash"),
        ),
        fallbackModel: env(
          "NMF_MENU_RECOMMEND_FALLBACK_MODEL",
          env("NMF_MENU_FALLBACK_MODEL", "minimax-m3"),
        ),
        timeoutMs: Math.min(
          55_000,
          Math.max(
            1_000,
            Number(env("NMF_MENU_RECOMMEND_TIMEOUT_MS", "45000")) || 45_000,
          ),
        ),
        maxTokens: Number(env("NMF_MENU_RECOMMEND_MAX_TOKENS", "8192")) || 8192,
      });
      const response: RecommendationBank = {
        ok: true,
        date,
        source: result.source,
        model: result.model,
        fallbackUsed: result.fallbackUsed,
        generatedAt: new Date().toISOString(),
        slots: result.slots,
        warnings: result.warnings,
        aliases: dishAliases(),
        excludedCount: result.excludedCount,
        validatedCount: result.validatedCount,
        cached: false,
        attempts: result.attempts,
        serverStored: true,
        storage: "server",
        expectedCounts: { ...input.expectedCounts },
      };
      // Never return a successful transient bank if durable save failed.
      const saved = await storageOperation(() =>
        saveRecommendationBank(
          key,
          revision,
          leaseToken,
          response,
        )
      );
      if (!saved) {
        throw new BankStorageError(
          "추천 보관 시간이 만료되어 저장하지 못했습니다. 다시 확인해 주세요.",
        );
      }
      return json(cloneResponse(response, false));
    } catch (error) {
      // Releasing only our token cannot clear a newer generation's lease.
      try {
        await releaseRecommendationLease(key, leaseToken);
      } catch { /* expires after 150s */ }
      throw error;
    }
  } catch (error) {
    if (error instanceof BankStorageError) {
      return json({
        ok: false,
        reason: "bank_storage_unavailable",
        error: error.message,
      }, 503);
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = recommendationErrorStatus(error);
    const attempts = error && typeof error === "object" && "attempts" in error
      ? (error as { attempts?: unknown }).attempts
      : undefined;
    const internal = status === 500;
    const publicModelMessage = message.replace(
      /^모든 메뉴 생성 모델 실패/,
      "AI 추천 모델 응답 실패",
    );
    return json({
      ok: false,
      reason: internal ? "recommendation_unavailable" : "recommendation_failed",
      error: internal
        ? "추천 자료를 읽지 못했습니다. 잠시 후 다시 요청해 주세요."
        : publicModelMessage,
      ...(internal ? {} : { attempts }),
    }, status);
  }
});

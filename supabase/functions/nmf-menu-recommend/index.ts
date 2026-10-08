// 나모푸드 식단 AI 추천 — 기존 레시피명만 읽어 후보를 반환한다.
// 상태/일정/메뉴/실행기록을 쓰지 않는다. 브라우저는 HMAC 서명만 보낸다.
import { readState } from "../_shared/database.ts";
import { dishAliases } from "../_shared/institutional-menu.ts";
import { decryptText } from "../nmf-recipe-fill/lib.ts";
import {
  assertDate,
  buildRecommendationInput,
  type MenuRecommendState,
  recommendationErrorStatus,
  type RecommendationResult,
  runRecommendationModel,
} from "./lib.ts";

type Body = { date?: unknown; nonce?: unknown };
type CachedResponse = {
  value: ResponseBody;
  expiresAt: number;
};
type ResponseBody = {
  ok: true;
  date: string;
  source: "ai";
  model: string;
  fallbackUsed: boolean;
  generatedAt: string;
  slots: RecommendationResult["slots"];
  warnings: string[];
  aliases: Record<string, string>;
  excludedCount: number;
  validatedCount: number;
  cached: boolean;
  attempts: RecommendationResult["attempts"];
};

const CORS_ORIGINS = new Set([
  "https://d-bae.com",
  "https://donggeonbae.github.io",
]);
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 32;
const cache = new Map<string, CachedResponse>();
const inflight = new Map<string, Promise<ResponseBody>>();

const env = (key: string, fallback = ""): string =>
  (Deno.env.get(key) ?? fallback).trim();
const TABLE = env("NMF_TABLE", "namofood_state");
const ROOM = env("NMF_ROOM", "namofood");

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

function cloneResponse(value: ResponseBody, cached: boolean): ResponseBody {
  return {
    ...value,
    cached,
    slots: JSON.parse(JSON.stringify(value.slots)),
    warnings: value.warnings.slice(),
    aliases: { ...value.aliases },
    attempts: value.attempts.map((item) => ({ ...item })),
  };
}

function remember(key: string, value: ResponseBody): void {
  cache.set(key, {
    value: cloneResponse(value, false),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
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
  if (!(await verifyRequest(password, date, nonce, timestamp, signature))) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }

  try {
    const state = await loadState(password);
    const input = buildRecommendationInput(state, date, nonce);
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
    const cacheKey = `${date}|${nonce}|${input.fingerprint}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return json(cloneResponse(cached.value, true));
    }
    const joined = inflight.has(cacheKey);
    if (!joined) {
      const promise = runRecommendationModel(input, {
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
      }).then((result) => {
        const response: ResponseBody = {
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
        };
        remember(cacheKey, response);
        return response;
      }).finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, promise);
    }
    const response = await inflight.get(cacheKey)!;
    return json(cloneResponse(response, joined));
  } catch (error) {
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

// 나모푸드: 7일 단위 식단을 OpenCode Zen으로 만들고 암호화 상태의 빈 셀에만 병합한다.
// 호출 인증: Authorization: Bearer <NMF_CRON_SECRET>
// body: {"weeks":2} 재호출하며 9/24~10/7 중 누락 7일씩 채움 · {"dry":true} 현황만 · {"preview":true} 생성하되 미저장
import {
  blockDates,
  buildPrompt,
  coverageReport,
  decryptText,
  detectMealLabels,
  encryptText,
  existingMenuCells,
  headcountPlanDates,
  menuDates,
  type MenuPlan,
  mergeMenuPlan,
  type ModelAttemptDiagnostic,
  ModelFallbackError,
  type OpenCodeProtocol,
  parseMenuPlanJson,
  parseOpenCodeResponse,
  runModelFallback,
  selectAnchorBlocks,
  selectRunAnchorBlocks,
  splitDateChunks,
  staleRunCutoffIso,
  type State,
} from "./lib.ts";

const env = (key: string, fallback = ""): string =>
  (Deno.env.get(key) ?? fallback).trim();
const TABLE = env("NMF_TABLE", "namofood_state");
const ROOM = env("NMF_ROOM", "namofood");
const RUN_BUDGET_MS = 110_000;
const LLM_ATTEMPT_TIMEOUT_MS = 45_000;
const DB_TIMEOUT_MS = 12_000;
const STALE_RUN_MINUTES = 5;

type StateRow = { data: string; updated_at: string };
type RequestBody = { dry?: boolean; preview?: boolean; weeks?: number };
type ChunkGenerationDiagnostic = {
  dates: string[];
  selectedModel: string | null;
  fallbackUsed: boolean;
  attempts: ModelAttemptDiagnostic[];
  error?: string;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

function rest(path: string): string {
  const url = env("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL 이 없습니다");
  return `${url.replace(/\/$/, "")}/rest/v1/${path}`;
}

function serviceHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY 가 없습니다");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function safeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let different = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) different |= (aa[i] || 0) ^ (bb[i] || 0);
  return different === 0;
}

function boundedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function kstDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function fetchState(
  password: string,
  signal?: AbortSignal,
): Promise<{ state: State; row: StateRow }> {
  const response = await fetch(
    rest(`${TABLE}?id=eq.${encodeURIComponent(ROOM)}&select=data,updated_at`),
    { headers: serviceHeaders(), signal: boundedSignal(signal, DB_TIMEOUT_MS) },
  );
  if (!response.ok) {
    throw new Error(
      `상태 불러오기 ${response.status} ${
        (await response.text()).slice(0, 200)
      }`,
    );
  }
  const rows = await response.json() as StateRow[];
  if (!rows[0]) throw new Error("저장된 나모푸드 상태가 없습니다");
  const state = JSON.parse(await decryptText(password, rows[0].data)) as State;
  return { state, row: rows[0] };
}

async function cleanupStaleRuns(
  nowIso: string,
  signal?: AbortSignal,
): Promise<number> {
  const cutoff = staleRunCutoffIso(nowIso, STALE_RUN_MINUTES);
  const response = await fetch(
    rest(
      `namofood_menu_runs?status=eq.running&started_at=lt.${
        encodeURIComponent(cutoff)
      }&select=run_id`,
    ),
    {
      method: "PATCH",
      headers: serviceHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({
        status: "error",
        finished_at: nowIso,
        note: `stale cleanup: ${STALE_RUN_MINUTES}분 넘게 running 상태`,
        error: "Edge 실행이 완료 로그를 남기기 전에 종료됨",
      }),
      signal: boundedSignal(signal, DB_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `stale 로그 정리 실패 ${response.status} ${
        (await response.text()).slice(0, 200)
      }`,
    );
  }
  return (await response.json() as Array<{ run_id: string }>).length;
}

async function startRun(
  row: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(rest("namofood_menu_runs"), {
    method: "POST",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(row),
    signal: boundedSignal(signal, DB_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `실행 로그 시작 실패 ${response.status} ${
        (await response.text()).slice(0, 200)
      }`,
    );
  }
}

async function finishRun(
  runId: string,
  patch: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    rest(`namofood_menu_runs?run_id=eq.${encodeURIComponent(runId)}`),
    {
      method: "PATCH",
      headers: serviceHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(patch),
      signal: boundedSignal(signal, DB_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `실행 로그 완료 실패 ${response.status} ${
        (await response.text()).slice(0, 200)
      }`,
    );
  }
}

async function callLLM(
  prompt: string,
  model: string,
  protocol: OpenCodeProtocol,
  runSignal: AbortSignal,
  sessionId: string,
): Promise<string> {
  const key = env("OPENCODE_API_KEY") || env("OPENCODE_GO_API_KEY");
  if (!key) throw new Error("OPENCODE_API_KEY 가 없습니다");
  const base = env("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1");
  const path = protocol === "messages" ? "messages" : "chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "User-Agent": "namofood-menu-plan/1.0",
    "x-opencode-session": sessionId,
  };
  if (protocol === "messages") {
    // OpenCode Go의 MiniMax M3는 공식적으로 Anthropic Messages endpoint다.
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  }
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: Math.max(
          512,
          Number(env("NMF_MENU_MAX_TOKENS", "7000")) || 7000,
        ),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.any([
        runSignal,
        AbortSignal.timeout(LLM_ATTEMPT_TIMEOUT_MS),
      ]),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (runSignal.aborted) throw new Error(`전체 실행 예산 중단: ${detail}`);
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error(`LLM ${LLM_ATTEMPT_TIMEOUT_MS}ms timeout`);
    }
    throw new Error(`LLM transport 실패: ${detail}`);
  }
  if (!response.ok) {
    throw new Error(
      `LLM ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `LLM 응답 JSON 실패: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseOpenCodeResponse(protocol, payload);
}

function generationReport(
  primaryModel: string,
  fallbackModel: string,
  chunks: ChunkGenerationDiagnostic[],
) {
  const usedModels = [
    ...new Set(
      chunks.map((chunk) => chunk.selectedModel).filter((
        model,
      ): model is string => Boolean(model)),
    ),
  ];
  return {
    primaryModel,
    fallbackModel,
    attemptTimeoutMs: LLM_ATTEMPT_TIMEOUT_MS,
    usedModels,
    fallbackChunks: chunks.filter((chunk) => chunk.fallbackUsed).length,
    chunks,
  };
}

function generationNote(chunks: ChunkGenerationDiagnostic[]): string {
  if (!chunks.length) return "";
  const selected = [
    ...new Set(chunks.map((chunk) => chunk.selectedModel).filter(Boolean)),
  ].join(",");
  const fallbackChunks = chunks.filter((chunk) => chunk.fallbackUsed);
  const reasons = fallbackChunks.map((chunk) => {
    const failure = chunk.attempts.find((attempt) => !attempt.ok);
    return `${chunk.dates[0]}~${chunk.dates.at(-1)} ${
      failure?.error || "primary 실패"
    }`;
  }).join(" / ").slice(0, 1000);
  return [
    `모델 ${selected || "미선택"}`,
    `fallback ${fallbackChunks.length}/${chunks.length}`,
    reasons,
  ].filter(Boolean).join(" · ");
}

async function casSave(
  password: string,
  expectedUpdatedAt: string,
  state: State,
  today: string,
  signal?: AbortSignal,
): Promise<{ saved: boolean; updatedAt?: string; snapshotError?: string }> {
  const updatedAt = new Date().toISOString();
  state.updatedAt = updatedAt;
  const encrypted = await encryptText(password, JSON.stringify(state));
  const response = await fetch(
    rest(
      `${TABLE}?id=eq.${encodeURIComponent(ROOM)}&updated_at=eq.${
        encodeURIComponent(expectedUpdatedAt)
      }&select=id,updated_at`,
    ),
    {
      method: "PATCH",
      headers: serviceHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({ data: encrypted, updated_at: updatedAt }),
      signal: boundedSignal(signal, DB_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `상태 저장 실패 ${response.status} ${
        (await response.text()).slice(0, 200)
      }`,
    );
  }
  const rows = await response.json() as Array<
    { id: string; updated_at: string }
  >;
  if (!rows.length) return { saved: false };

  // 현재 행 CAS가 성공한 뒤 같은 암호문으로 KST 일별 복구 스냅샷을 남긴다.
  let snapshot: Response;
  try {
    snapshot = await fetch(rest(`${TABLE}?on_conflict=id`), {
      method: "POST",
      headers: serviceHeaders({
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        id: `${ROOM}@${today}`,
        data: encrypted,
        updated_at: updatedAt,
      }),
      signal: boundedSignal(signal, DB_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      saved: true,
      updatedAt,
      snapshotError: `스냅샷 요청 실패: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!snapshot.ok) {
    return {
      saved: true,
      updatedAt,
      snapshotError: `스냅샷 저장 실패 ${snapshot.status} ${
        (await snapshot.text()).slice(0, 200)
      }`,
    };
  }
  return { saved: true, updatedAt };
}

function uniqueDates(anchors: string[]): string[] {
  return [...new Set(anchors.flatMap(blockDates))].sort();
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }
  const configuredSecret = env("NMF_CRON_SECRET");
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  const suppliedSecret = bearer?.[1].trim() || "";
  if (!configuredSecret || !safeEqual(suppliedSecret, configuredSecret)) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  // Supabase Free/idle 제한 150초보다 충분히 먼저 모든 외부 요청을 중단한다.
  const runSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(RUN_BUDGET_MS),
  ]);
  const primaryModel = env("NMF_MENU_MODEL", "deepseek-v4.1-flash");
  const fallbackModel = env("NMF_MENU_FALLBACK_MODEL", "minimax-m3");
  const triggerSource = request.headers.get("x-source") || "http";
  let logged = false;
  let targetStart: string | null = null;
  let targetEnd: string | null = null;
  let staleCleaned = 0;
  let staleCleanupWarning = "";
  let generationDiagnostics: ChunkGenerationDiagnostic[] = [];
  try {
    // 504/강제 종료로 완료 PATCH를 못 남긴 이전 행은 새 실행 전에 닫는다.
    try {
      staleCleaned = await cleanupStaleRuns(startedAt, runSignal);
    } catch (error) {
      staleCleanupWarning = error instanceof Error
        ? error.message
        : String(error);
      console.warn(staleCleanupWarning);
    }
    await startRun({
      run_id: runId,
      target_start: null,
      target_end: null,
      trigger_source: triggerSource,
      status: "running",
      started_at: startedAt,
      model: primaryModel,
      added: [],
      headcounts: {},
      note: "",
      error: "",
    }, runSignal);
    logged = true;

    const parsedBody = await request.json().catch(() => ({}));
    const body =
      parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? parsedBody as RequestBody
        : {};
    if (
      body.weeks !== undefined &&
      (!Number.isInteger(body.weeks) || body.weeks < 1 || body.weeks > 2)
    ) {
      throw new Error("weeks 는 1 또는 2여야 합니다");
    }
    const password = env("NMF_PW");
    if (!password) throw new Error("NMF_PW 가 없습니다");
    const today = kstDate();
    const initial = await fetchState(password, runSignal);
    const report = coverageReport(initial.state, today);

    if (body.dry) {
      const finishedAt = new Date().toISOString();
      await finishRun(runId, {
        status: "done",
        finished_at: finishedAt,
        note: "dry run: 복호화 및 현재 범위/스키마 확인",
        error: "",
      }, runSignal);
      return json({
        ok: true,
        dry: true,
        runId,
        coverage: report,
        staleCleaned,
        warnings: [staleCleanupWarning].filter(Boolean),
        stateKeys: Object.keys(initial.state).sort(),
        menuMonths: Object.keys(initial.state.menus || {}).sort(),
        generation: generationReport(
          primaryModel,
          fallbackModel,
          generationDiagnostics,
        ),
      });
    }

    const meals = detectMealLabels(initial.state);
    const pendingAnchors = selectAnchorBlocks(initial.state, today, body.weeks);
    // 한 호출은 7일 한 블록만 저장한다. weeks=2는 같은 body로 재호출하면
    // 첫 블록 완성 후 두 번째 누락 블록이 선택된다.
    const anchors = selectRunAnchorBlocks(initial.state, today, body.weeks);
    const remainingAnchors = pendingAnchors.slice(anchors.length);
    const targetDates = uniqueDates(anchors);
    if (targetDates.length) {
      targetStart = targetDates[0];
      targetEnd = targetDates.at(-1)!;
    }

    let plan: MenuPlan = { days: [] };
    if (targetDates.length) {
      // 기존 수동 셀까지 되풀이하는 2일 응답은 토큰 제한에 걸릴 수 있어 하루씩
      // 병렬 생성한다. 각 조각은 저장 전에 날짜·4식·필수 6칸을 독립 검증한다.
      const chunks = anchors.flatMap((anchor) =>
        splitDateChunks(blockDates(anchor), 1)
      );
      const chunkResults = await Promise.all(chunks.map(async (dates) => {
        const fixedCells = existingMenuCells(initial.state, dates, meals);
        const prompt = buildPrompt(dates, meals, fixedCells);
        // 같은 청크의 primary/fallback은 동일 conversation/session으로 식별한다.
        const sessionId = crypto.randomUUID();
        try {
          const generated = await runModelFallback(
            [primaryModel, fallbackModel],
            async (candidateModel, protocol) => {
              const answer = await callLLM(
                prompt,
                candidateModel,
                protocol,
                runSignal,
                sessionId,
              );
              // JSON/날짜/식사/슬롯 검증 실패도 primary 실패로 간주해 fallback한다.
              return parseMenuPlanJson(answer, dates, meals, fixedCells);
            },
          );
          return {
            plan: generated.value,
            diagnostic: {
              dates,
              selectedModel: generated.model,
              fallbackUsed: generated.fallbackUsed,
              attempts: generated.attempts,
            } satisfies ChunkGenerationDiagnostic,
          };
        } catch (error) {
          const attempts = error instanceof ModelFallbackError
            ? error.attempts
            : [];
          return {
            plan: null,
            diagnostic: {
              dates,
              selectedModel: null,
              fallbackUsed: attempts.length > 1,
              attempts,
              error: error instanceof Error ? error.message : String(error),
            } satisfies ChunkGenerationDiagnostic,
          };
        }
      }));
      generationDiagnostics = chunkResults.map((result) => result.diagnostic);
      const failed = chunkResults.filter((result) => !result.plan);
      if (failed.length) {
        throw new Error(
          failed.map((result) =>
            `${result.diagnostic.dates[0]}~${
              result.diagnostic.dates.at(-1)
            } 생성 실패: ${result.diagnostic.error}`
          ).join(" | "),
        );
      }
      plan = {
        days: chunkResults.flatMap((result) => result.plan?.days || []),
      };
    }

    const generation = generationReport(
      primaryModel,
      fallbackModel,
      generationDiagnostics,
    );
    const effectiveModel = generation.usedModels.join(",") || primaryModel;

    // 사진 계획 유효기간 전체를 미리 채운다. n-only 날짜는 menuDates/완성 식단
    // horizon에서 제외되고, mergeHeadcounts가 수동 값과 수동 메타를 보존한다.
    const headcountDates = [
      ...new Set([
        ...headcountPlanDates(),
        ...menuDates(initial.state),
      ]),
    ].sort();

    if (body.preview) {
      const previewState = structuredClone(initial.state);
      const changes = mergeMenuPlan(previewState, plan, {
        updated: startedAt,
        model: effectiveModel,
        runId,
        meals,
        headcountDates,
      });
      await finishRun(runId, {
        target_start: targetStart,
        target_end: targetEnd,
        status: "done",
        finished_at: new Date().toISOString(),
        added: [],
        headcounts: changes.headcounts,
        model: effectiveModel,
        note: [
          `preview: 식단 ${changes.added.length}셀, 식수 ${
            Object.keys(changes.headcounts).length
          }셀 (저장 안 함)`,
          generationNote(generationDiagnostics),
        ].filter(Boolean).join(" · "),
        error: "",
      }, runSignal);
      return json({
        ok: true,
        preview: true,
        runId,
        anchors,
        remainingAnchors,
        needsFollowUp: remainingAnchors.length > 0,
        staleCleaned,
        meals,
        plan,
        changes,
        generation,
      });
    }

    let latest = await fetchState(password, runSignal); // LLM 대기 중 사용자 저장분을 반드시 다시 읽는다.
    if (
      plan.days.length &&
      detectMealLabels(latest.state).join("\u0000") !== meals.join("\u0000")
    ) {
      throw new Error(
        "식단 생성 중 식사명 구성이 바뀌었습니다. 다음 실행에서 다시 생성합니다",
      );
    }

    let finalChanges: ReturnType<typeof mergeMenuPlan> | null = null;
    let savedAt: string | undefined;
    let snapshotWarning = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const working = structuredClone(latest.state);
      const changes = mergeMenuPlan(working, plan, {
        updated: startedAt,
        model: effectiveModel,
        runId,
        meals,
        headcountDates,
      });
      finalChanges = changes;
      if (
        !changes.added.length && !Object.keys(changes.headcounts).length &&
        !changes.prices.length && !changes.rice.length
      ) {
        break;
      }
      const saved = await casSave(
        password,
        latest.row.updated_at,
        working,
        today,
        runSignal,
      );
      if (saved.saved) {
        savedAt = saved.updatedAt;
        snapshotWarning = saved.snapshotError || "";
        break;
      }
      if (attempt === 3) {
        throw new Error(
          "동시 저장 충돌이 3회 발생했습니다. 다음 실행에서 다시 시도합니다",
        );
      }
      latest = await fetchState(password, runSignal);
      if (
        plan.days.length &&
        detectMealLabels(latest.state).join("\u0000") !== meals.join("\u0000")
      ) {
        throw new Error(
          "동시 저장 중 식사명 구성이 바뀌었습니다. 다음 실행에서 다시 생성합니다",
        );
      }
    }

    const changes = finalChanges ||
      {
        added: [],
        preserved: [],
        menuMeta: [],
        rice: [],
        headcounts: {},
        prices: [],
      };
    const noteBase = savedAt
      ? `저장 완료: 식단 ${changes.added.length}셀, 식수 ${
        Object.keys(changes.headcounts).length
      }셀, 쌀밥 기본 ${changes.rice.length}셀, 가격 ${changes.prices.length}항목`
      : anchors.length
      ? "대상 블록에 추가할 빈 셀이 없습니다"
      : "향후 식단이 7일 이상 있어 새 블록을 만들지 않았습니다";
    const followUpNote = remainingAnchors.length
      ? `추가 호출 필요: ${remainingAnchors.join(", ")}`
      : "";
    const note = [
      noteBase,
      generationNote(generationDiagnostics),
      followUpNote,
      snapshotWarning,
    ].filter(Boolean).join(" · ");
    let logWarning = "";
    try {
      await finishRun(runId, {
        target_start: targetStart,
        target_end: targetEnd,
        status: "done",
        finished_at: new Date().toISOString(),
        added: changes.added,
        headcounts: changes.headcounts,
        model: effectiveModel,
        note,
        error: "",
      }, runSignal);
    } catch (logError) {
      if (!savedAt) throw logError;
      logWarning = logError instanceof Error
        ? logError.message
        : String(logError);
    }
    return json({
      ok: true,
      runId,
      anchors,
      remainingAnchors,
      needsFollowUp: remainingAnchors.length > 0,
      staleCleaned,
      meals,
      savedAt: savedAt || null,
      changes,
      coverageBefore: report,
      generation,
      note,
      warnings: [staleCleanupWarning, snapshotWarning, logWarning].filter(
        Boolean,
      ),
    });
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (logged) {
      try {
        await finishRun(runId, {
          target_start: targetStart,
          target_end: targetEnd,
          status: "error",
          finished_at: new Date().toISOString(),
          model: generationReport(
            primaryModel,
            fallbackModel,
            generationDiagnostics,
          ).usedModels.join(",") || primaryModel,
          note: generationNote(generationDiagnostics),
          error: message,
        }, AbortSignal.timeout(5_000));
      } catch (logError) {
        message += ` · 로그 갱신 실패: ${
          logError instanceof Error ? logError.message : String(logError)
        }`;
      }
    }
    return json({
      ok: false,
      runId,
      error: message,
      generation: generationReport(
        primaryModel,
        fallbackModel,
        generationDiagnostics,
      ),
    }, 500);
  }
});

// 나모푸드: 7일 단위 식단을 OpenCode Zen으로 만들고 암호화 상태의 빈 셀에만 병합한다.
// 호출 인증: Authorization: Bearer <NMF_CRON_SECRET>
// body: {"weeks":2} 재호출하며 9/24~10/7 중 누락 7일씩 채움 · {"dry":true} 현황만 · {"preview":true} 생성하되 미저장
import {
  logValues,
  readState,
  snapshotState,
  sql,
  writeState,
} from "../_shared/database.ts";
import {
  blockDates,
  buildPrompt,
  coverageReport,
  decryptText,
  detectMealLabels,
  encryptText,
  existingMenuCells,
  headcountPlanDates,
  kstDayStartIso,
  MENU_RETRY_COOLDOWN_MS,
  menuDates,
  type MenuPlan,
  type MenuRunHistory,
  mergeMenuPlan,
  mergeMenuPlanDays,
  type ModelAttemptDiagnostic,
  ModelFallbackError,
  type OpenCodeProtocol,
  parseMenuPlanJson,
  parseOpenCodeResponse,
  recipeCandidateDishes,
  runModelFallback,
  runValidatedMenuAttempt,
  selectAnchorBlocks,
  selectRetryMenuDates,
  selectRollingDates,
  selectRunAnchorBlocks,
  splitDateChunks,
  staleRunCutoffIso,
  type State,
  surroundingMenuCells,
  validateMenuVariety,
} from "./lib.ts";

const env = (key: string, fallback = ""): string =>
  (Deno.env.get(key) ?? fallback).trim();
const TABLE = env("NMF_TABLE", "namofood_state");
const ROOM = env("NMF_ROOM", "namofood");
const RUN_BUDGET_MS = 110_000;
const SAVE_RESERVE_MS = 15_000;
const LLM_PRIMARY_TIMEOUT_MS = 35_000;
const LLM_FALLBACK_TIMEOUT_MS = 60_000;
const STALE_RUN_MINUTES = 5;

type StateRow = { data: string; updated_at: string };
type RequestBody = {
  dry?: boolean;
  preview?: boolean;
  weeks?: number;
  retry?: boolean;
  force?: boolean;
};
type ChunkGenerationDiagnostic = {
  dates: string[];
  selectedModel: string | null;
  fallbackUsed: boolean;
  attempts: ModelAttemptDiagnostic[];
  error?: string;
  saveError?: string;
  correctionCount?: number;
  corrections?: Array<{ model: string; attempt: number; error: string }>;
};
type RecentMenuRun = MenuRunHistory & {
  error?: string;
  generation?: { chunks?: ChunkGenerationDiagnostic[] };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

function safeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let different = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) different |= (aa[i] || 0) ^ (bb[i] || 0);
  return different === 0;
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
  signal?.throwIfAborted();
  const [row] = await readState(TABLE, ROOM);
  if (!row) throw new Error("저장된 나모푸드 상태가 없습니다");
  return {
    state: JSON.parse(await decryptText(password, row.data)),
    row: row as StateRow,
  };
}

async function cleanupStaleRuns(
  nowIso: string,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const cutoff = staleRunCutoffIso(nowIso, STALE_RUN_MINUTES);
  const rows =
    await sql`update public.namofood_menu_runs set status='error', finished_at=${nowIso}, note=case when note like 'preview:%' then 'preview: stale cleanup: 실행시간 초과' else 'stale cleanup: 실행시간 초과' end, error='Edge 실행이 완료 로그를 남기기 전에 종료됨' where status='running' and started_at<${cutoff} returning run_id`;
  return rows.length;
}

async function claimRun(
  row: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  // The short transaction serializes check+insert, not the long LLM call. The
  // running row acts as a 5-minute lease until finishRun releases it.
  return await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`nmf-menu-plan:${TABLE}:${ROOM}`}))`;
    const active =
      await tx`select run_id from public.namofood_menu_runs where status='running' and started_at>=${
        staleRunCutoffIso(String(row.started_at), STALE_RUN_MINUTES)
      } limit 1`;
    if (active.length) return false;
    await tx`insert into public.namofood_menu_runs ${tx(logValues(row))}`;
    return true;
  });
}
async function finishRun(
  runId: string,
  patch: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await sql`update public.namofood_menu_runs set ${
    sql(logValues(patch))
  } where run_id=${runId}`;
}

async function callLLM(
  prompt: string,
  model: string,
  protocol: OpenCodeProtocol,
  runSignal: AbortSignal,
  sessionId: string,
  attemptTimeoutMs: number,
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
          Number(env("NMF_MENU_MAX_TOKENS", "10000")) || 10000,
        ),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.any([
        runSignal,
        AbortSignal.timeout(attemptTimeoutMs),
      ]),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (runSignal.aborted) throw new Error(`전체 실행 예산 중단: ${detail}`);
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error(`LLM ${attemptTimeoutMs}ms timeout`);
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
    attemptTimeoutMs: LLM_PRIMARY_TIMEOUT_MS,
    primaryTimeoutMs: LLM_PRIMARY_TIMEOUT_MS,
    fallbackTimeoutMs: LLM_FALLBACK_TIMEOUT_MS,
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

function failedMenuDates(chunks: ChunkGenerationDiagnostic[]) {
  return chunks.flatMap((chunk) => {
    const error = chunk.saveError || chunk.error;
    return error ? chunk.dates.map((date) => ({ date, error })) : [];
  });
}

async function casSave(
  password: string,
  expectedUpdatedAt: string,
  state: State,
  today: string,
  signal?: AbortSignal,
): Promise<{ saved: boolean; updatedAt?: string; snapshotError?: string }> {
  signal?.throwIfAborted();
  const updatedAt = new Date().toISOString();
  state.updatedAt = updatedAt;
  const encrypted = await encryptText(password, JSON.stringify(state));
  const rows = await writeState(
    TABLE,
    ROOM,
    expectedUpdatedAt,
    encrypted,
    updatedAt,
  );
  if (!rows.length) return { saved: false };
  try {
    await snapshotState(TABLE, ROOM + "@" + today, encrypted, updatedAt);
  } catch {
    return {
      saved: true,
      updatedAt,
      snapshotError: "식단은 저장됐으나 복구 스냅샷 저장에 실패했습니다",
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
  let targetDates: string[] = [];
  let retrySelection: ReturnType<typeof selectRetryMenuDates> = {
    dates: [],
    deferred: [],
  };
  let isPreview = false;
  let forceUsed = false;
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
    const claimed = await claimRun({
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
      targets: [],
      generation: {},
    }, runSignal);
    if (!claimed) {
      return json({
        ok: true,
        skipped: true,
        reason: "already_running",
        runId: null,
      });
    }
    logged = true;

    const parsedBody = await request.json().catch(() => ({}));
    const body =
      parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? parsedBody as RequestBody
        : {};
    isPreview = body.preview === true;
    if (
      body.weeks !== undefined &&
      (!Number.isInteger(body.weeks) || body.weeks < 1 || body.weeks > 2)
    ) {
      throw new Error("weeks 는 1 또는 2여야 합니다");
    }
    for (const flag of ["dry", "preview", "retry", "force"] as const) {
      if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
        throw new Error(`${flag} 는 boolean이어야 합니다`);
      }
    }
    forceUsed = body.force === true;
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
    const requestedDates = body.weeks === undefined
      ? selectRollingDates(initial.state, today)
      : uniqueDates(anchors);
    const historySince = new Date(
      Date.parse(kstDayStartIso(startedAt)) - MENU_RETRY_COOLDOWN_MS,
    ).toISOString();
    const history = await sql<
      RecentMenuRun[]
    >`select started_at,targets,target_start,target_end,error,generation from public.namofood_menu_runs where run_id<>${runId} and started_at>=${historySince} and note not like 'preview:%' and note not like 'dry run:%' and (jsonb_array_length(targets)>0 or target_start is not null) order by started_at desc`;
    retrySelection = isPreview
      ? { dates: requestedDates, deferred: [] }
      : selectRetryMenuDates(requestedDates, history, startedAt, {
        force: forceUsed,
      });
    targetDates = retrySelection.dates;
    if (targetDates.length) {
      targetStart = targetDates[0];
      targetEnd = targetDates.at(-1)!;
      // Only this exact targeted set consumes per-date quota. A no-op cron tick
      // has null ranges/empty targets and can never exhaust retries.
      await finishRun(runId, {
        targets: targetDates,
        target_start: targetStart,
        target_end: targetEnd,
        note: isPreview
          ? "preview: 생성 중 (저장 안 함)"
          : forceUsed
          ? "운영자 cooldown 해제(force): 하루 3회 한도 유지"
          : "",
      }, runSignal);
    }

    let plan: MenuPlan = { days: [] };
    if (targetDates.length) {
      // 기존 수동 셀까지 되풀이하는 2일 응답은 토큰 제한에 걸릴 수 있어 하루씩
      // 병렬 생성한다. 각 조각은 저장 전에 날짜·4식·필수 6칸을 독립 검증한다.
      const chunks = splitDateChunks(targetDates, 1);
      // Synchronously reserve accepted days so parallel chunks/fallbacks also see
      // dishes generated earlier in this same run, not just the saved calendar.
      const generationState = structuredClone(initial.state);
      const generationSignal = AbortSignal.any([
        runSignal,
        AbortSignal.timeout(
          Math.max(
            1,
            RUN_BUDGET_MS - SAVE_RESERVE_MS -
              (Date.now() - Date.parse(startedAt)),
          ),
        ),
      ]);
      const chunkResults = await Promise.all(chunks.map(async (dates) => {
        const fixedCells = existingMenuCells(initial.state, dates, meals);
        const previousRun = history.find((run) =>
          run.targets?.includes(dates[0]) ||
          (!run.targets?.length && run.target_start && run.target_end &&
            run.target_start <= dates[0] && dates[0] <= run.target_end)
        );
        const priorFailure = previousRun?.generation?.chunks?.find((chunk) =>
          chunk.dates.includes(dates[0])
        )?.error || previousRun?.error || "";
        // 같은 청크의 primary/fallback은 동일 conversation/session으로 식별한다.
        const sessionId = crypto.randomUUID();
        const corrections: Array<
          { model: string; attempt: number; error: string }
        > = [];
        try {
          const generated = await runModelFallback(
            [primaryModel, fallbackModel],
            async (candidateModel, protocol, previousFailure) => {
              return await runValidatedMenuAttempt(
                async (correction) => {
                  const prompt = buildPrompt(
                    dates,
                    meals,
                    fixedCells,
                    surroundingMenuCells(generationState, dates, meals),
                    [correction?.error, priorFailure, previousFailure].filter(
                      Boolean,
                    ).join(" / "),
                    correction?.answer,
                    recipeCandidateDishes(generationState),
                  );
                  return await callLLM(
                    prompt,
                    candidateModel,
                    protocol,
                    generationSignal,
                    sessionId,
                    candidateModel === primaryModel
                      ? LLM_PRIMARY_TIMEOUT_MS
                      : LLM_FALLBACK_TIMEOUT_MS,
                  );
                },
                (answer) => {
                  const candidate = parseMenuPlanJson(
                    answer,
                    dates,
                    meals,
                    fixedCells,
                  );
                  validateMenuVariety(generationState, candidate);
                  mergeMenuPlan(generationState, candidate, {
                    updated: startedAt,
                    model: candidateModel,
                    runId,
                    meals,
                    headcountDates: [],
                  });
                  return candidate;
                },
                {
                  signal: generationSignal,
                  maxCorrections: 2,
                  onCorrection: (correction) =>
                    corrections.push({
                      model: candidateModel,
                      attempt: correction.attempt,
                      error: correction.error,
                    }),
                },
              );
            },
          );
          return {
            plan: generated.value,
            diagnostic: {
              dates,
              selectedModel: generated.model,
              fallbackUsed: generated.fallbackUsed,
              attempts: generated.attempts,
              correctionCount: corrections.length,
              corrections,
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
              correctionCount: corrections.length,
              corrections,
              error: error instanceof Error ? error.message : String(error),
            } satisfies ChunkGenerationDiagnostic,
          };
        }
      }));
      generationDiagnostics = chunkResults.map((result) => result.diagnostic);
      // Failed/aborted dates are diagnosed separately, never discard completed
      // dates. The final save has its own reserved budget below.
      plan = {
        days: chunkResults.flatMap((result) => result.plan?.days || []),
      };
    }

    let generation = generationReport(
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
      const preview = mergeMenuPlanDays(initial.state, plan, {
        updated: startedAt,
        model: effectiveModel,
        runId,
        meals,
        headcountDates,
      });
      const changes = preview.changes;
      const failures = [
        ...failedMenuDates(generationDiagnostics),
        ...preview.failedDates,
      ];
      await finishRun(runId, {
        target_start: targetStart,
        target_end: targetEnd,
        status: failures.length
          ? preview.succeededDates.length ? "partial" : "error"
          : "done",
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
        error: failures.map((item) => `${item.date}: ${item.error}`).join(
          " | ",
        ),
        generation,
      }, runSignal);
      return json({
        ok: !failures.length || preview.succeededDates.length > 0,
        partial: failures.length > 0 && preview.succeededDates.length > 0,
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
        failedDates: failures,
        succeededDates: preview.succeededDates,
        retry: retrySelection,
      });
    }

    // Completed chunks remain saveable even when the generation/request signal
    // expired. This independent final phase is bounded to the reserved 15s.
    const saveSignal = AbortSignal.timeout(SAVE_RESERVE_MS);
    let latest = await fetchState(password, saveSignal); // LLM 대기 중 사용자 저장분을 반드시 다시 읽는다.
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
    let succeededDates: string[] = [];
    let saveFailures: Array<{ date: string; error: string }> = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const prepared = mergeMenuPlanDays(latest.state, plan, {
        updated: startedAt,
        model: effectiveModel,
        runId,
        meals,
        headcountDates,
      });
      const working = prepared.state;
      const changes = prepared.changes;
      succeededDates = prepared.succeededDates;
      saveFailures = prepared.failedDates;
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
        saveSignal,
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
      latest = await fetchState(password, saveSignal);
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
    for (const failure of saveFailures) {
      const chunk = generationDiagnostics.find((item) =>
        item.dates.includes(failure.date)
      );
      if (chunk) chunk.saveError = failure.error;
    }
    const failures = failedMenuDates(generationDiagnostics);
    const partial = failures.length > 0 && succeededDates.length > 0;
    const status = !targetDates.length
      ? "skipped"
      : failures.length
      ? partial ? "partial" : "error"
      : "done";
    generation = generationReport(
      primaryModel,
      fallbackModel,
      generationDiagnostics,
    );
    const noteBase = failures.length && !succeededDates.length
      ? "AI 생성 실패로 저장된 식단이 없습니다. 실패 날짜별 원인을 확인하고 제한된 재시도를 기다립니다"
      : savedAt
      ? `저장 완료: 식단 ${changes.added.length}셀, 식수 ${
        Object.keys(changes.headcounts).length
      }셀, 쌀밥 기본 ${changes.rice.length}셀, 가격 ${changes.prices.length}항목`
      : targetDates.length
      ? "대상 블록에 추가할 빈 셀이 없습니다"
      : retrySelection.deferred.length
      ? `누락 식단 재시도 대기: ${
        retrySelection.deferred.map((item) =>
          `${item.date} ${
            item.reason === "daily_limit" ? "오늘 3회 한도" : "30분 대기"
          }`
        ).join(", ")
      }`
      : "오늘부터 14일 뒤까지 식단이 모두 준비되어 있습니다";
    const followUpNote = remainingAnchors.length
      ? `추가 호출 필요: ${remainingAnchors.join(", ")}`
      : "";
    const note = [
      noteBase,
      generationNote(generationDiagnostics),
      followUpNote,
      snapshotWarning,
      forceUsed ? "운영자 cooldown 해제(force): 하루 3회 한도 유지" : "",
      retrySelection.deferred.length
        ? `재시도 대기: ${
          retrySelection.deferred.map((item) => `${item.date} → ${item.nextAt}`)
            .join(", ")
        }`
        : "",
      failures.length
        ? `${partial ? "부분 저장" : "생성 실패"}: ${
          failures.map((item) => item.date).join(", ")
        }`
        : "",
    ].filter(Boolean).join(" · ");
    let logWarning = "";
    try {
      await finishRun(runId, {
        target_start: targetStart,
        target_end: targetEnd,
        status,
        finished_at: new Date().toISOString(),
        added: changes.added,
        headcounts: changes.headcounts,
        model: effectiveModel,
        note,
        error: failures.map((item) => `${item.date}: ${item.error}`).join(
          " | ",
        ),
        generation: {
          ...generation,
          retry: retrySelection,
          succeededDates,
          failedDates: failures,
          force: forceUsed,
        },
      }, saveSignal);
    } catch (logError) {
      if (!savedAt) throw logError;
      logWarning = logError instanceof Error
        ? logError.message
        : String(logError);
    }
    return json({
      ok: status !== "error",
      partial,
      status,
      runId,
      anchors,
      remainingAnchors,
      needsFollowUp: remainingAnchors.length > 0,
      staleCleaned,
      meals,
      savedAt: savedAt || null,
      changes,
      coverageBefore: report,
      generation: {
        ...generation,
        retry: retrySelection,
        succeededDates,
        failedDates: failures,
        force: forceUsed,
      },
      failedDates: failures,
      succeededDates,
      retry: retrySelection,
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
          note: (isPreview
            ? "preview: "
            : forceUsed
            ? "운영자 cooldown 해제(force): "
            : "") +
            generationNote(generationDiagnostics),
          error: message,
          generation: generationReport(
            primaryModel,
            fallbackModel,
            generationDiagnostics,
          ),
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

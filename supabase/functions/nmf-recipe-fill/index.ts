// 나모푸드: 식단표에 있지만 레시피가 없는 음식을 OpenCode Zen(LLM)으로 조사해 상태에 병합
// 호출: pg_cron → net.http_post (Authorization: Bearer NMF_CRON_SECRET) 또는 수동 POST
//   body: {"dry":true} → LLM 호출 없이 빠진 음식 목록만 반환 · {"force":true} → 최근 저장 대기(4분) 무시
// 비밀(supabase secrets set): NMF_PW(앱 비밀번호), NMF_CRON_SECRET, OPENCODE_API_KEY, [NMF_RECIPE_MODEL]
import {
  askSimilar,
  buildPrompt,
  decryptText,
  encryptText,
  fetchReference,
  generateRecipesWithFallback,
  mergeRecipes,
  missingList,
  recipeNames,
  shouldErrorBackoff,
} from "./lib.ts";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const TABLE = env("NMF_TABLE", "namofood_state"),
  ROOM = env("NMF_ROOM", "namofood");
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

function rest(path: string) {
  return `${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${path}`;
}
function svc(extra: Record<string, string> = {}) {
  const k = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: k,
    Authorization: `Bearer ${k}`,
    "Content-Type": "application/json",
    ...extra,
  };
}
type LogResult = { ok: true } | { ok: false; message: string };
async function logRun(row: Record<string, unknown>): Promise<LogResult> {
  try {
    const r = await fetch(rest("namofood_recipe_runs"), {
      method: "POST",
      headers: svc({ Prefer: "return=minimal" }),
      body: JSON.stringify(row),
    });
    if (r.ok) return { ok: true };
    const message = `실행 기록 저장 실패 ${r.status} ${
      (await r.text()).slice(0, 200)
    }`;
    console.error(message);
    return { ok: false, message };
  } catch (e) {
    const message = `실행 기록 저장 실패 ${
      e instanceof Error ? e.message : String(e)
    }`;
    console.error(message);
    return { ok: false, message };
  }
}

async function logSkipped(run: Record<string, unknown>, reason: string) {
  const log = await logRun({
    ...run,
    status: "skipped",
    finished_at: new Date().toISOString(),
    added: [],
    note: reason,
  });
  return json({
    ok: true,
    skipped_reason: reason,
    ...(log.ok ? {} : { log_warning: log.message }),
  });
}

function recipeGenerationOptions(prompt: string, targetMenus: string[]) {
  const key = env("OPENCODE_API_KEY") || env("OPENCODE_GO_API_KEY");
  if (!key) throw new Error("OPENCODE_API_KEY 가 없습니다");
  const timeoutMs = Math.min(
    55000,
    Math.max(1000, +(env("NMF_RECIPE_TIMEOUT_MS", "52000")) || 52000),
  );
  const maxTokens = Math.max(
    512,
    +(env("NMF_RECIPE_MAX_TOKENS", "6000")) || 6000,
  );
  return {
    prompt,
    targetMenus,
    apiKey: key,
    baseUrl: env("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1"),
    primaryModel: env("NMF_RECIPE_MODEL", "deepseek-v4.1-flash"),
    fallbackModel: env("NMF_RECIPE_FALLBACK_MODEL", "minimax-m3"),
    timeoutMs,
    maxTokens,
    fetchImpl: fetch,
    sessionId: () => crypto.randomUUID(),
  };
}

function envMinutes(name: string, d: number) {
  const n = +(env(name, String(d)));
  return Number.isFinite(n) ? Math.max(0, n) : d;
}

function modelNote(
  gen: {
    model: string;
    fallback: boolean;
    attempts: { model: string; error?: string }[];
  } | null,
) {
  if (!gen?.model) return "";
  const failed = gen.attempts.filter((a) => a.error).map((a) =>
    `${a.model}: ${a.error}`
  );
  return [
    `모델: ${gen.model}${gen.fallback ? " (fallback)" : ""}`,
    failed.length ? `fallback 사유: ${failed.join(" / ")}` : "",
  ].filter(Boolean).join(" · ");
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from(
    { length: Math.ceil(items.length / size) },
    (_, index) => items.slice(index * size, index * size + size),
  );
}

async function fetchReferences<T extends { menu: string }>(list: T[]) {
  return Object.fromEntries(
    await Promise.all(
      list.map(async (m) => [m.menu, await fetchReference(m.menu)]),
    ),
  ) as Record<string, Awaited<ReturnType<typeof fetchReference>>>;
}

async function saveCurrentStateWithCas(
  pw: string,
  state: unknown,
  expectedUpdatedAt: string,
) {
  const at = new Date().toISOString();
  const blob = await encryptText(
    pw,
    JSON.stringify({ ...(state as Record<string, unknown>), updatedAt: at }),
  );
  const current = await fetch(
    rest(
      `${TABLE}?id=eq.${encodeURIComponent(ROOM)}&updated_at=eq.${
        encodeURIComponent(expectedUpdatedAt)
      }&select=updated_at`,
    ),
    {
      method: "PATCH",
      headers: svc({ Prefer: "return=representation" }),
      body: JSON.stringify({ data: blob, updated_at: at }),
    },
  );
  if (!current.ok) {
    throw new Error(
      `저장 실패 ${current.status} ${(await current.text()).slice(0, 200)}`,
    );
  }
  const patched = await current.json();
  if (!patched[0]) {
    throw new Error(
      "저장 충돌: 읽은 뒤 다른 저장이 먼저 반영되어 이번 레시피 병합을 중단했습니다",
    );
  }
  const backup = await fetch(rest(`${TABLE}?on_conflict=id`), {
    method: "POST",
    headers: svc({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([{
      id: `${ROOM}@${at.slice(0, 10)}`,
      data: blob,
      updated_at: at,
    }]),
  });
  if (!backup.ok) {
    const warning = `오늘 백업 저장 실패 ${backup.status} ${
      (await backup.text()).slice(0, 200)
    }`;
    console.error(warning);
    return { at, warning };
  }
  return { at, warning: "" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }
  const secret = env("NMF_CRON_SECRET");
  const tok = (req.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
  if (!secret || tok !== secret) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  const body = await req.json().catch(() => ({})) as {
    dry?: boolean;
    force?: boolean;
    max?: number;
    llm?: boolean;
    menus?: string[];
  };
  const started = new Date().toISOString();
  const today = started.slice(0, 10);
  const run: Record<string, unknown> = {
    started_at: started,
    trigger_source: req.headers.get("x-source") || "http",
    status: "running",
  };
  try {
    const pw = env("NMF_PW");
    if (!pw) throw new Error("NMF_PW 가 없습니다");
    const r = await fetch(
      rest(`${TABLE}?id=eq.${encodeURIComponent(ROOM)}&select=data,updated_at`),
      { headers: svc() },
    );
    if (!r.ok) throw new Error(`상태 불러오기 ${r.status}`);
    const rows = await r.json();
    if (!rows[0]) throw new Error("저장된 데이터가 없습니다");
    const S = JSON.parse(await decryptText(pw, rows[0].data));
    const quietMin = +env("NMF_QUIET_MINUTES", "4");
    const ageMs = Date.now() - new Date(rows[0].updated_at).getTime();
    if (!body.dry && !body.force && ageMs < quietMin * 60000) {
      return await logSkipped(
        run,
        `마지막 저장 ${
          Math.round(ageMs / 60000)
        }분 전 — 입력 중일 수 있어 ${quietMin}분 뒤 다시 확인`,
      );
    }
    // 직전 실행이 오류였으면 1시간 동안 재시도하지 않음 (토큰 낭비 방지)
    if (!body.dry && !body.force) {
      const lr = await fetch(
        rest(
          "namofood_recipe_runs?select=status,started_at&order=started_at.desc&limit=1",
        ),
        { headers: svc() },
      ).then((x) => x.json()).catch(() => []);
      const errorBackoffMin = envMinutes(
        "NMF_RECIPE_ERROR_BACKOFF_MINUTES",
        20,
      );
      if (shouldErrorBackoff(lr[0], Date.now(), errorBackoffMin)) {
        return await logSkipped(
          run,
          `직전 실행 오류 — ${errorBackoffMin}분 뒤 재시도`,
        );
      }
    }
    const all = missingList(S);
    const targets = all.filter((m) => !m.similar.length).slice(
      0,
      Math.max(1, Math.min(20, +(body.max || env("NMF_MAX_PER_RUN", "8")))),
    );
    if (body.dry && !body.llm) {
      return json({
        ok: true,
        dry: true,
        recipes: recipeNames(S).size,
        missing: all,
        targets: targets.map((t) => t.menu),
      });
    }
    if (body.dry && body.llm) { // 형식 점검용: 지정 음식으로 LLM 까지 돌리고 저장은 안 함
      const list = (body.menus || targets.map((t) => t.menu)).map((menu) => ({
        menu,
        comp: all.find((m) => m.menu === menu)?.comp || "주찬",
        used: [],
        similar: [],
        cells: [],
      }));
      const refs = await fetchReferences(list);
      const gen = await generateRecipesWithFallback(
        recipeGenerationOptions(
          buildPrompt(list, refs),
          list.map((m) => m.menu),
        ),
      );
      return json({
        ok: true,
        dry: true,
        model: gen.model,
        fallback: gen.fallback,
        attempts: gen.attempts,
        refs: Object.fromEntries(
          Object.entries(refs).map(([k, v]) => [k, v?.url || null]),
        ),
        recipes: gen.recipes,
      });
    }
    const similar = all.filter((m) =>
      m.similar.length && !(S.recipeAsk || {})[m.menu]
    );
    if (!targets.length && !similar.length) {
      const log = await logRun({
        ...run,
        status: "done",
        finished_at: new Date().toISOString(),
        added: [],
        note: "추가할 음식 없음",
      });
      return json({
        ok: true,
        added: [],
        skipped: [],
        ...(log.ok ? {} : { log_warning: log.message }),
      });
    }
    const refs = await fetchReferences(targets); // 만개의레시피 참고자료·출처
    // 레시피 두 개도 상세 재료가 길면 출력 토큰이 잘릴 수 있다. 음식 하나씩
    // 독립 생성하고 일부가 실패해도 성공분은 저장해 특정 메뉴가 전체를 막지 않게 한다.
    const generationSettled = targets.length
      ? await Promise.allSettled(
        chunks(targets, 1).map(async ([target]) => ({
          menu: target.menu,
          result: await generateRecipesWithFallback(
            recipeGenerationOptions(
              buildPrompt([target], { [target.menu]: refs[target.menu] }),
              [target.menu],
            ),
          ),
        })),
      )
      : [];
    const generated = generationSettled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.result] : []
    );
    const generationFailures = generationSettled.flatMap((result, index) =>
      result.status === "rejected"
        ? [{
          menu: targets[index].menu,
          error: result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        }]
        : []
    );
    if (targets.length && !generated.length) {
      throw new Error(
        "모든 레시피 생성 실패: " +
          generationFailures.map((failure) =>
            `${failure.menu}: ${failure.error}`
          ).join(" | "),
      );
    }
    const recipes = generated.flatMap((result) => result.recipes);
    const gen = generated.length
      ? {
        recipes,
        model: [...new Set(generated.map((result) => result.model))].join(","),
        fallback: generated.some((result) => result.fallback),
        attempts: generated.flatMap((result) => result.attempts),
      }
      : null;
    // LLM 응답을 기다리는 동안 다른 기기가 저장했을 수 있으니, 최신 상태를 다시 받아 그 위에 병합 (덮어쓰기 방지)
    const r2 = await fetch(
      rest(`${TABLE}?id=eq.${encodeURIComponent(ROOM)}&select=data,updated_at`),
      { headers: svc() },
    );
    if (!r2.ok) throw new Error(`최신 상태 불러오기 ${r2.status}`);
    const [latest] = await r2.json();
    const S2 = latest.updated_at !== rows[0].updated_at
      ? JSON.parse(await decryptText(pw, latest.data))
      : S;
    const { added, skipped } = mergeRecipes(S2, recipes, today, refs);
    const asked = askSimilar(S2, similar, today);
    let saveWarning = "";
    if (added.length || asked.length) {
      const saved = await saveCurrentStateWithCas(pw, S2, latest.updated_at);
      saveWarning = saved.warning;
    }
    const note = [
      modelNote(gen),
      generationFailures.length
        ? `생성 실패(다음 실행 재시도): ${
          generationFailures.map((failure) => failure.menu).join(", ")
        }`
        : "",
      skipped.length ? `건너뜀: ${skipped.join(", ")}` : "",
      asked.length ? `유사이름 확인 요청: ${asked.join(", ")}` : "",
      saveWarning,
    ].filter(Boolean).join(" · ");
    const log = await logRun({
      ...run,
      status: "done",
      finished_at: new Date().toISOString(),
      added,
      note,
    });
    return json({
      ok: true,
      added,
      skipped,
      asked,
      targets: targets.map((t) => t.menu),
      ...(gen
        ? { model: gen.model, fallback: gen.fallback, attempts: gen.attempts }
        : {}),
      ...(generationFailures.length
        ? { generation_failures: generationFailures }
        : {}),
      ...(saveWarning ? { save_warning: saveWarning } : {}),
      ...(log.ok ? {} : { log_warning: log.message }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logRun({
      ...run,
      status: "error",
      finished_at: new Date().toISOString(),
      error: msg,
    });
    return json({ ok: false, error: msg }, 500);
  }
});

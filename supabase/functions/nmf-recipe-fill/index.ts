// 나모푸드: 식단표에 있지만 레시피가 없는 음식을 OpenCode Zen(LLM)으로 조사해 상태에 병합
// 호출: pg_cron → net.http_post (Authorization: Bearer NMF_CRON_SECRET) 또는 수동 POST
// 저장 직후 앱 서명 요청 + 매분 cron. DB 원자적 claim으로 동시 생성/오류 재시도를 제어한다.
// 비밀(supabase secrets set): NMF_PW(앱 비밀번호), NMF_CRON_SECRET, OPENCODE_API_KEY, [NMF_RECIPE_MODEL]
import {
  logValues,
  readState,
  snapshotState,
  sql,
  writeState,
} from "../_shared/database.ts";
import {
  buildPrompt,
  decryptText,
  encryptText,
  fetchReference,
  generateRecipesWithFallback,
  INSTITUTIONAL_COOKING_PROFILE,
  institutionalUpgradeList,
  mergeInstitutionalMethods,
  mergeRecipes,
  missingList,
  recipeNames,
  selectRecipeTargets,
  verifyAppRequest,
} from "./lib.ts";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const TABLE = env("NMF_TABLE", "namofood_state"),
  ROOM = env("NMF_ROOM", "namofood");
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "https://donggeonbae.github.io",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-nmf-time, x-nmf-signature",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    },
  });

type LogResult = { ok: true } | { ok: false; message: string };
async function logRun(row: Record<string, unknown>): Promise<LogResult> {
  try {
    const { id, ...patch } = row;
    if (id) {
      await sql`update public.namofood_recipe_runs set ${
        sql(logValues(patch))
      } where id=${String(id)}`;
    } else {await sql`insert into public.namofood_recipe_runs ${
        sql(logValues(row))
      }`;}
    return { ok: true };
  } catch (e) {
    const message = `실행 기록 저장 실패 ${
      e instanceof Error ? e.message : String(e)
    }`;
    console.error(message);
    return { ok: false, message };
  }
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
  const patched = await writeState(TABLE, ROOM, expectedUpdatedAt, blob, at);
  if (!patched[0]) {
    throw new Error("state_conflict");
  }
  try {
    await snapshotState(TABLE, `${ROOM}@${at.slice(0, 10)}`, blob, at);
  } catch {
    const warning = "레시피는 저장됐으나 오늘 백업 저장에 실패했습니다";
    console.error(warning);
    return { at, warning };
  }
  return { at, warning: "" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }
  const secret = env("NMF_CRON_SECRET");
  const tok = (req.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
  const body = await req.json().catch(() => ({})) as {
    action?: string;
    dry?: boolean;
    force?: boolean;
    max?: number;
    llm?: boolean;
    menus?: string[];
  };
  const cronAuth = Boolean(secret && tok === secret);
  const appAuth = !cronAuth &&
    await verifyAppRequest(
      env("NMF_PW"),
      body.action || "",
      req.headers.get("x-nmf-time") || "",
      req.headers.get("x-nmf-signature") || "",
    );
  if (!cronAuth && !appAuth) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  if (
    appAuth && (body.dry || body.force || body.llm || body.max || body.menus)
  ) return json({ ok: false, reason: "invalid_app_request" }, 400);
  if (body.action === "status") {
    try {
      const runs =
        await sql`select id,status,started_at,finished_at,added,targets,note,error from public.namofood_recipe_runs order by started_at desc limit 5`;
      const running = runs.find((r) =>
        r.status === "running" && Date.now() - Date.parse(r.started_at) < 240000
      );
      const last = runs[0] || null;
      const retryAt = last?.status === "error"
        ? Date.parse(last.finished_at || last.started_at) + 120000
        : 0;
      const nextCheck =
        Math.ceil(Math.max(Date.now() + 1000, retryAt) / 60000) * 60000;
      const [stateRow] = await readState(TABLE, ROOM);
      if (!stateRow) throw new Error("저장된 데이터가 없습니다");
      const state = JSON.parse(await decryptText(env("NMF_PW"), stateRow.data));
      const names = [...recipeNames(state)];
      const upgradeNames = new Set(
        institutionalUpgradeList(state).map((item) => item.menu),
      );
      return json({
        ok: true,
        serverTime: new Date().toISOString(),
        running: running || null,
        last,
        nextCheckAt: new Date(nextCheck).toISOString(),
        retryAt: retryAt > Date.now() ? new Date(retryAt).toISOString() : null,
        estimatedSeconds: [30, 180],
        upgradePending: upgradeNames.size,
        institutionalReady: names.filter((menu) =>
          state.recipeMeta?.[menu]?.cookingProfile ===
            INSTITUTIONAL_COOKING_PROFILE && !upgradeNames.has(menu)
        ).length,
        totalRecipes: names.length,
        runs,
      });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }
  const started = new Date().toISOString();
  const today = started.slice(0, 10);
  const run: Record<string, unknown> = {
    started_at: started,
    trigger_source: appAuth
      ? "app_save"
      : req.headers.get("x-source") || "http",
    status: "running",
  };
  try {
    if (!body.dry) {
      const id = crypto.randomUUID();
      const [claim] =
        await sql`select public.nmf_claim_recipe_run(${id}::uuid,${
          String(run.trigger_source)
        }) as claimed`;
      if (!claim.claimed) {
        return json({
          ok: true,
          busy: true,
          note: "실행 중이거나 오류 재시도 대기 중",
        });
      }
      run.id = id;
    }
    const pw = env("NMF_PW");
    if (!pw) throw new Error("NMF_PW 가 없습니다");
    const rows = await readState(TABLE, ROOM);
    if (!rows[0]) throw new Error("저장된 데이터가 없습니다");
    const S = JSON.parse(await decryptText(pw, rows[0].data));
    const all = missingList(S);
    const upgrades = institutionalUpgradeList(S);
    // 이름이 비슷하다는 이유만으로 대기 음식이 영구 제외되지 않게 한다.
    const max = Math.max(
      1,
      Math.min(20, Number(body.max || env("NMF_MAX_PER_RUN", "8")) || 8),
    );
    let recentRuns: Parameters<typeof selectRecipeTargets>[3] = [];
    if (all.length || upgrades.length) {
      try {
        const failureRows = await sql<
          {
            status: string;
            targets: unknown;
            note: string;
            started_at: string;
          }[]
        >`select status,targets,note,started_at from public.namofood_recipe_runs
          where status='error' or note like '%생성 실패(다음 실행 재시도)%'
          order by started_at desc limit 30`;
        recentRuns = failureRows.map((row) => ({ ...row }));
      } catch (e) {
        console.warn("실패 음식 순서 조정용 기록 조회 실패", String(e));
      }
    }
    const targets = selectRecipeTargets(all, upgrades, max, recentRuns);
    if (body.dry && !body.llm) {
      return json({
        ok: true,
        dry: true,
        recipes: recipeNames(S).size,
        missing: all,
        upgradePending: upgrades.length,
        upgradeMenus: upgrades.map((t) => t.menu),
        targets: targets.map((t) => t.menu),
      });
    }
    if (body.dry && body.llm) { // 형식 점검용: 지정 음식으로 LLM 까지 돌리고 저장은 안 함
      const list = (body.menus || targets.map((t) => t.menu)).map((menu) =>
        all.find((m) => m.menu === menu) || upgrades.find((m) =>
          m.menu === menu
        ) || {
          menu,
          comp: "주찬",
          used: [],
          similar: [],
          cells: [],
        }
      );
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
    if (!targets.length) {
      const log = await logRun({
        ...run,
        status: "done",
        finished_at: new Date().toISOString(),
        added: [],
        note: "추가할 음식·대량 조리법 전환 대상 없음",
      });
      return json({
        ok: true,
        added: [],
        upgraded: [],
        upgradePending: 0,
        skipped: [],
        ...(log.ok ? {} : { log_warning: log.message }),
      });
    }
    await logRun({
      ...run,
      targets: targets.map((t) => t.menu),
      note: "참고자료 확인 중",
    });
    const refs = await fetchReferences(targets); // 만개의레시피 참고자료·출처
    await logRun({
      ...run,
      note: targets.some((t) => t.methodUpgrade)
        ? `AI 레시피 작성·대량 조리법 전환 중 (대기 ${upgrades.length}개)`
        : "AI 대량 조리 레시피 작성 중",
    });
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
    await logRun({ ...run, note: "완성된 레시피 저장 중" });
    let added: string[] = [], upgraded: string[] = [], skipped: string[] = [];
    let remainingUpgrades = upgrades.length;
    let saveWarning = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const [latest] = await readState(TABLE, ROOM);
      const S2 = JSON.parse(await decryptText(pw, latest.data));
      const upgradeNames = new Set(
        targets.filter((t) => t.methodUpgrade).map((t) => t.menu),
      );
      const addedResult = mergeRecipes(
        S2,
        recipes.filter((R) => !upgradeNames.has(R.menu)),
        today,
        refs,
      );
      const upgradeResult = mergeInstitutionalMethods(
        S2,
        recipes,
        targets,
        today,
      );
      added = addedResult.added;
      upgraded = upgradeResult.upgraded;
      skipped = [...addedResult.skipped, ...upgradeResult.skipped];
      remainingUpgrades = institutionalUpgradeList(S2).length;
      try {
        if (upgraded.length) {
          // Never reuse the daily snapshot: each CAS baseline has its own recoverable backup.
          try {
            await snapshotState(
              TABLE,
              `${ROOM}@before-institutional-${String(run.id)}-${attempt}`,
              latest.data,
              new Date().toISOString(),
            );
          } catch {
            throw new Error(
              "대량 조리법 전환 전 백업 실패: 기존 레시피는 변경하지 않았습니다",
            );
          }
        }
        if (added.length || upgraded.length) {
          saveWarning =
            (await saveCurrentStateWithCas(pw, S2, latest.updated_at)).warning;
        }
        break;
      } catch (e) {
        if (
          !(e instanceof Error) || e.message !== "state_conflict" ||
          attempt === 2
        ) throw e;
      }
    }
    const note = [
      modelNote(gen),
      upgraded.length ? `대량 조리법 전환: ${upgraded.join(", ")}` : "",
      remainingUpgrades ? `전환 대기 ${remainingUpgrades}개` : "",
      generationFailures.length
        ? `생성 실패(다음 실행 재시도): ${
          generationFailures.map((failure) => failure.menu).join(", ")
        }`
        : "",
      skipped.length ? `건너뜀: ${skipped.join(", ")}` : "",
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
      upgraded,
      upgradePending: remainingUpgrades,
      skipped,
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

// Edge Function 순수 로직 점검 (LLM 호출 없음). 실행: deno run -A tools/test_recipe_fill.ts
// 비밀번호: NMF_PW 또는 ~/.namofood_pw  — 실제 Supabase 상태를 읽어 복호화 → 빠진 음식 목록 → 병합/암호화 왕복 확인
import {
  buildPrompt,
  decryptText,
  encryptText,
  generateRecipesWithFallback,
  mergeRecipes,
  missingList,
  parseRecipesJson,
  recipeNames,
  shouldErrorBackoff,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";

const backoffNow = Date.parse("2026-09-25T00:10:00Z");
if (
  !shouldErrorBackoff(
    { status: "error", started_at: "2026-09-25T00:00:00Z" },
    backoffNow,
    20,
  )
) throw new Error("가장 최근 실행이 오류면 backoff 해야 합니다");
if (
  shouldErrorBackoff(
    { status: "done", started_at: "2026-09-25T00:05:00Z" },
    backoffNow,
    20,
  )
) {
  throw new Error(
    "오류 뒤 성공한 최신 실행까지 예전 오류로 backoff 하면 안 됩니다",
  );
}

const localState = {
  menus: { "2026-10": { "1|중식|10": "깻잎무침" } },
  recipes: [],
};
const localMissing = missingList(localState);
if (localMissing[0]?.comp !== "부찬") {
  throw new Error("10번 이상 슬롯은 부찬이어야 합니다");
}

const shortNameState = {
  menus: { "2026-10": { "1|중식|2": "육전", "1|중식|3": "육 수" } },
  recipes: [
    { menu: "육수", item: "소뼈", qty: 100 },
  ],
};
const shortMissing = missingList(shortNameState);
const yuckjeon = shortMissing.find((m) => m.menu === "육전");
if (!yuckjeon || yuckjeon.similar.length) {
  throw new Error("육전은 짧은 이름 fuzzy match 로 육수와 묶이면 안 됩니다");
}
const exactShort = shortMissing.find((m) => m.menu === "육 수");
if (!exactShort?.similar.includes("육수")) {
  throw new Error(
    "공백만 다른 짧은 이름 exact-normalized match 는 허용되어야 합니다",
  );
}

const prompt = buildPrompt([{
  menu: "육전",
  comp: "밥",
  used: ["2026-10-01 중식"],
  similar: [],
  cells: [],
}]);
if (!prompt.includes("육전이 밥으로 들어오면 comp 는 주찬")) {
  throw new Error("프롬프트가 명백히 잘못된 comp 교정을 요구해야 합니다");
}

const staleAskState = {
  recipes: [{ comp: "밥", menu: "육전", item: "", qty: 100 }],
  recipeAsk: { "육전": { ask: "육수로 바꾸시겠습니까?", options: [] } },
};
const staleAdded = mergeRecipes(staleAskState, [{
  menu: "육전",
  comp: "주찬",
  items: [{ item: "소고기", qty: 90, unit: "g" }],
}], "2026-09-25");
if (staleAdded.added[0] !== "육전" || staleAskState.recipeAsk["육전"]) {
  throw new Error(
    "정상 레시피 추가 시 기존 stale recipeAsk 는 삭제되어야 합니다",
  );
}
const missingRefState = {
  recipes: [],
  recipeAsk: { "육전": { ask: "육수로 바꾸시겠습니까?", options: [] } },
};
mergeRecipes(
  missingRefState,
  [{
    menu: "육전",
    comp: "주찬",
    items: [{ item: "소고기", qty: 90, unit: "g" }],
  }],
  "2026-09-25",
  { "육전": null },
);
if (!missingRefState.recipeAsk["육전"]?.ask?.includes("만개의레시피")) {
  throw new Error(
    "참조가 없을 때만 새 recipeAsk 안내가 다시 설정되어야 합니다",
  );
}

const fallbackCalls: { model: string; url: string; headers: Headers }[] = [];
const fallbackResult = await generateRecipesWithFallback({
  prompt: "육전 레시피 JSON",
  targetMenus: ["육전"],
  apiKey: "test-key",
  baseUrl: "https://example.test",
  primaryModel: "deepseek-v4.1-flash",
  fallbackModel: "minimax-m3",
  timeoutMs: 10,
  maxTokens: 1000,
  sessionId: () => "test-session",
  fetchImpl: ((input, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    fallbackCalls.push({
      model: body.model,
      url: String(input),
      headers: new Headers(init?.headers),
    });
    if (body.model === "deepseek-v4.1-flash") {
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{
            type: "text",
            text:
              '{"recipes":[{"menu":"육전","comp":"주찬","method":"소고기에 밀가루와 계란물을 묻혀 전판에 부친다","items":[{"item":"소고기","qty":90,"unit":"g"},{"item":"밀가루","qty":10,"unit":"g"},{"item":"계란","qty":20,"unit":"g"}]}]}',
          }],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch,
});
if (
  fallbackResult.model !== "minimax-m3" || !fallbackResult.fallback ||
  fallbackResult.recipes[0]?.menu !== "육전" ||
  fallbackCalls.map((call) => call.model).join(",") !==
    "deepseek-v4.1-flash,minimax-m3" ||
  !fallbackCalls[0].url.endsWith("/chat/completions") ||
  !fallbackCalls[1].url.endsWith("/messages") ||
  fallbackCalls[1].headers.get("anthropic-version") !== "2023-06-01" ||
  fallbackCalls[1].headers.get("x-api-key") !== "test-key"
) {
  throw new Error("primary timeout 뒤 Messages fallback 경로가 깨졌습니다");
}

const identityCalls: string[] = [];
const identityResult = await generateRecipesWithFallback({
  prompt: "육전 레시피 JSON",
  targetMenus: ["육전"],
  apiKey: "test-key",
  baseUrl: "https://example.test",
  primaryModel: "wrong-yukjeon",
  fallbackModel: "right-yukjeon",
  timeoutMs: 10,
  maxTokens: 1000,
  sessionId: () => "test-session",
  fetchImpl: ((_input, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    identityCalls.push(body.model);
    const recipe = body.model === "wrong-yukjeon"
      ? {
        menu: "육전",
        comp: "주찬",
        items: [{ item: "소뼈", qty: 90, unit: "g" }],
        method: "1. 물에 끓인다.",
      }
      : {
        menu: "육전",
        comp: "주찬",
        items: [
          { item: "소고기 홍두깨살", qty: 100, unit: "g" },
          { item: "계란", qty: 0.5, unit: "ea" },
          { item: "밀가루", qty: 8, unit: "g" },
        ],
        method:
          "1. 소고기에 밀가루와 계란물을 묻힌다.\n2. 전판에 기름을 두르고 굽는다.",
      };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: { content: JSON.stringify({ recipes: [recipe] }) },
          }],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch,
});
if (
  identityResult.model !== "right-yukjeon" || !identityResult.fallback ||
  identityCalls.join(",") !== "wrong-yukjeon,right-yukjeon"
) {
  throw new Error("육전 내용 검증이 잘못된 레시피를 막지 못했습니다");
}

const URL_ = "https://rycibsczsgbkgtwfxyim.supabase.co",
  KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5Y2lic2N6c2dia2d0d2Z4eWltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MjkzMTAsImV4cCI6MjEwNDAwNTMxMH0.gfo03oiZT6FPMGQaa9pF5it2BY6oL1CoxWpd7-fk0OY";
let pw = Deno.env.get("NMF_PW") || "";
if (!pw) {
  try {
    pw = (await Deno.readTextFile(
      `${Deno.env.get("USERPROFILE") || Deno.env.get("HOME")}/.namofood_pw`,
    )).trim();
  } catch { /* 없음 */ }
}
if (!pw) {
  console.log(
    "RECIPE_FILL_LOCAL_OK (비밀번호 없음: live Supabase 복호화 테스트 생략)",
  );
  Deno.exit(0);
}

const r = await fetch(
  `${URL_}/rest/v1/namofood_state?id=eq.namofood&select=data,updated_at`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
);
const [row] = await r.json();
const S = JSON.parse(await decryptText(pw, row.data));
const miss = missingList(S);
console.log(
  `레시피 ${
    recipeNames(S).size
  }개 · 빠진 음식 ${miss.length}개 · 유사이름 제외 대상 ${
    miss.filter((m) => !m.similar.length).length
  }개`,
);
console.log(
  miss.slice(0, 8).map((m) =>
    `${m.menu}(${m.comp}) [${m.used.join(",")}]${
      m.similar.length ? " ~" + m.similar.join("/") : ""
    }`
  ).join(", "),
);
console.log(
  "--- 프롬프트 미리보기 ---\n" + buildPrompt(miss.slice(0, 2)).slice(0, 400) +
    "\n---",
);

// 병합 + 암호화 왕복 (저장은 하지 않음)
const fake = parseRecipesJson(
  '```json\n{"recipes":[{"menu":"__테스트음식__","comp":"주찬","items":[{"item":"두부","qty":80,"unit":"g"},{"item":"물","qty":100,"unit":"ml"}],"method":"1. 굽기"}]}\n```',
);
const before = S.recipes.length;
const { added } = mergeRecipes(S, fake, "2026-09-22");
if (added[0] !== "__테스트음식__" || S.recipes.length !== before + 1) {
  throw new Error("mergeRecipes 실패 (물 제외·1건 추가 기대)");
}
const round = JSON.parse(
  await decryptText(pw, await encryptText(pw, JSON.stringify(S))),
);
if (round.recipeMeta["__테스트음식__"].by !== "ai") {
  throw new Error("암호화 왕복 실패");
}
console.log("RECIPE_FILL_OK");

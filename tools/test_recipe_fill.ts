// Edge Function 순수 로직 점검 (LLM 호출 없음). 실행: deno run -A tools/test_recipe_fill.ts
// 비밀번호: NMF_PW 또는 ~/.namofood_pw  — 실제 Supabase 상태를 읽어 복호화 → 빠진 음식 목록 → 병합/암호화 왕복 확인
import {
  buildPrompt,
  decryptText,
  encryptText,
  generateRecipesWithFallback,
  INSTITUTIONAL_COOKING_PROFILE,
  institutionalUpgradeList,
  mergeInstitutionalMethods,
  mergeRecipes,
  missingList,
  needsInstitutionalUpgrade,
  parseRecipesJson,
  recipeNames,
  selectRecipeTargets,
  shouldErrorBackoff,
  validateInstitutionalMethod,
  verifyAppRequest,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";

const bulkBeefMethod = [
  "1. 100명 기준 재료를 계량하고 전판, 배식용기를 준비해 25명분씩 4배치로 분할한다.",
  "2. 소고기 홍두깨살을 같은 두께로 손질하고 전용 칼과 도마를 구분한다.",
  "3. 밀가루와 계란물을 각각 준비해 배치별로 소고기에 묻힌다.",
  "4. 전판에 기름을 두르고 고기를 겹치지 않게 배치별로 부친다.",
  "5. 가장 두꺼운 조각의 중심온도 75℃를 1분 이상 확인한다.",
  "6. 완성품은 배식용기에 나누고 60℃ 이상 보온하며 배식 직전 회차별로 교체한다.",
].join("\n");
const beefItems = [
  { item: "소고기 홍두깨살", qty: 100, unit: "g" },
  { item: "계란", qty: 0.5, unit: "ea" },
  { item: "밀가루", qty: 8, unit: "g" },
];
const bulkBeef = {
  menu: "육전",
  comp: "주찬",
  items: beefItems,
  method: bulkBeefMethod,
};
const kimchiMethod = [
  "1. 100명 기준 완제품 김치를 계량하고 배식용기를 준비해 회차별로 분할한다.",
  "2. 포장 상태와 소비기한, 냉장 온도를 확인한다.",
  "3. 세척·소독한 작업대에서 포장을 개봉한다.",
  "4. 전용 칼과 도마로 배식 크기에 맞게 절단한다.",
  "5. 배식용기에 나누어 5℃ 이하로 냉장 보관한다.",
  "6. 배식 직전 필요한 회차만 꺼내고 전용 집게를 사용한다.",
].join("\n");
if (
  validateInstitutionalMethod(bulkBeefMethod) ||
  validateInstitutionalMethod(kimchiMethod)
) {
  throw new Error("대량 전판 작업서와 완제품 김치 작업서가 허용되어야 합니다");
}
for (
  const invalid of [
    "",
    "1. 팬에 튀긴다.",
    bulkBeefMethod.replaceAll("전판", "프라이팬"),
    bulkBeefMethod.replaceAll("25명분씩 4배치로 분할", "통째로 투입")
      .replaceAll("배치별로", "모두").replaceAll("나누고", "담고").replaceAll(
        "회차별로",
        "한꺼번에",
      ),
    bulkBeefMethod.replace("전판, 배식용기", "오븐, 배식용기"),
    bulkBeefMethod.replace("60℃ 이상 보온", "실온 보관"),
    kimchiMethod.replace("5℃ 이하", "10℃ 이하"),
    kimchiMethod.replace("5℃ 이하", "85℃ 이하"),
    kimchiMethod.replace("준비해", "5℃ 이하로 냉장 보관하며 준비해")
      .replace("나누어 5℃ 이하", "나누어 85℃ 이하"),
  ]
) {
  if (!validateInstitutionalMethod(invalid)) {
    throw new Error("가정용·무배치·필수 오븐 또는 빈 조리법이 통과했습니다");
  }
}

const authTime = String(Date.now()), enc = new TextEncoder();
const authKey = await crypto.subtle.importKey(
  "raw",
  enc.encode("fixture-password"),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const signature = Array.from(
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      authKey,
      enc.encode("nmf-recipe:status:" + authTime),
    ),
  ),
  (v) => v.toString(16).padStart(2, "0"),
).join("");
if (
  !await verifyAppRequest("fixture-password", "status", authTime, signature)
) throw new Error("valid status signature rejected");
if (await verifyAppRequest("fixture-password", "run", authTime, signature)) {
  throw new Error("status signature allowed run");
}
if (
  await verifyAppRequest(
    "fixture-password",
    "status",
    authTime,
    signature,
    Number(authTime) + 61000,
  )
) throw new Error("expired signature accepted");
if (await verifyAppRequest("wrong-password", "status", authTime, signature)) {
  throw new Error("wrong password accepted");
}

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
const promptExample = JSON.parse(
  prompt.slice(prompt.indexOf('{"recipes":'), prompt.indexOf("\n규칙:")),
);
if (
  validateInstitutionalMethod(promptExample.recipes[0].method) ||
  !promptExample.recipes[0].method.includes("85℃") ||
  promptExample.recipes[0].method.includes("15~20초")
) {
  throw new Error(
    "프롬프트 예시가 유효한 JSON·대량 조리법·어패류 온도 기준을 충족해야 합니다",
  );
}

const staleAskState = {
  recipes: [{ comp: "밥", menu: "육전", item: "", qty: 100 }],
  recipeAsk: { "육전": { ask: "육수로 바꾸시겠습니까?", options: [] } },
};
const staleAdded = mergeRecipes(staleAskState, [{
  ...bulkBeef,
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
    ...bulkBeef,
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
            text: JSON.stringify({ recipes: [bulkBeef] }),
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
        method: bulkBeefMethod,
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

const invalidMerge = JSON.parse('{"recipes":[],"recipeMeta":{}}');
for (
  const recipe of [
    { ...bulkBeef, method: "" },
    { ...bulkBeef, items: [{ item: "소금", qty: 1, unit: "kg" }] },
    { ...bulkBeef, items: [{ item: "소금", qty: -1, unit: "g" }] },
    {
      ...bulkBeef,
      method: bulkBeefMethod.replace(
        "중심온도 75℃를 1분 이상 확인한다",
        "색깔이 변하면 건진다",
      ),
    },
    {
      ...bulkBeef,
      items: beefItems.map((item) => ({
        ...item,
        item: item.item.replace("소고기 홍두깨살", "대구"),
      })),
    },
    {
      menu: "오징어볶음",
      items: [{ item: "오징어", qty: 100, unit: "g" }],
      method: bulkBeefMethod,
    },
  ]
) {
  const result = mergeRecipes(invalidMerge, [recipe], "2026-09-30");
  if (result.added.length || invalidMerge.recipeMeta[recipe.menu]) {
    throw new Error(
      "불완전 조리법/잘못된 단위·분량에 대량 조리 인증이 붙었습니다",
    );
  }
}

const frozenCutlet = JSON.parse('{"recipes":[],"recipeMeta":{}}');
if (
  mergeRecipes(frozenCutlet, [{
    menu: "돈까스",
    items: [{ item: "냉동 돈까스 완제품", qty: 100, unit: "g" }],
    method: bulkBeefMethod.replace(
      "중심온도 75℃를 1분 이상 확인한다",
      "색깔이 변하면 건진다",
    ),
  }], "2026-09-30").added.length
) {
  throw new Error("냉동 돈까스 완제품을 이미 익힌 음식으로 오인했습니다");
}
const oilDoesNotProveCenter = JSON.parse('{"recipes":[],"recipeMeta":{}}');
if (
  mergeRecipes(oilDoesNotProveCenter, [{
    menu: "오징어튀김",
    items: [{ item: "오징어", qty: 100, unit: "g" }],
    method: bulkBeefMethod.replace(
      "가장 두꺼운 조각의 중심온도",
      "튀김기180℃에서 조리한 뒤 중심온도",
    )
      .replace("전판", "튀김기"),
  }], "2026-09-30").added.length
) {
  throw new Error("튀김기 기름180℃를 어패류 중심온도85℃로 오인했습니다");
}
const safeHigher = JSON.parse('{"recipes":[],"recipeMeta":{}}');
if (
  mergeRecipes(safeHigher, [{
    ...bulkBeef,
    method: bulkBeefMethod.replace("75℃를 1분", "80°C를 2분"),
  }], "2026-09-30").added[0] !== "육전"
) {
  throw new Error("더 높은 육류 중심온도·2분 가열을 유효하게 허용해야 합니다");
}
const safeSeafood = JSON.parse('{"recipes":[],"recipeMeta":{}}');
if (
  mergeRecipes(safeSeafood, [{
    menu: "오징어볶음",
    items: [{ item: "오징어", qty: 100, unit: "g" }],
    method: bulkBeefMethod.replace("75℃", "85 °C"),
  }], "2026-09-30").added[0] !== "오징어볶음"
) {
  throw new Error("어패류 중심온도85℃ 1분 작업서를 허용해야 합니다");
}
const readyKimchi = JSON.parse('{"recipes":[],"recipeMeta":{}}');
if (
  mergeRecipes(readyKimchi, [{
    menu: "배추김치",
    method: kimchiMethod,
    items: [{ item: "배추김치 완제품", qty: 50, unit: "g" }, {
      item: "새우젓",
      qty: 1,
      unit: "g",
    }, { item: "멸치액젓", qty: 1, unit: "g" }],
  }], "2026-09-30").added[0] !== "배추김치"
) {
  throw new Error(
    "김치·새우젓·멸치액젓을 생어패류로 오인해 가열을 강제하면 안 됩니다",
  );
}

const bulkFallbackCalls: string[] = [];
const bulkFallback = await generateRecipesWithFallback({
  prompt: "대량 김치 배식 작업서",
  targetMenus: ["배추김치"],
  apiKey: "fixture",
  baseUrl: "https://example.test",
  primaryModel: "household",
  fallbackModel: "institutional",
  timeoutMs: 10,
  maxTokens: 1000,
  fetchImpl: ((_input, init) => {
    const model = JSON.parse(String(init?.body)).model;
    bulkFallbackCalls.push(model);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                recipes: [{
                  menu: "배추김치",
                  items: [{ item: "완제품 배추김치", qty: 50, unit: "g" }],
                  method: model === "household"
                    ? "1. 김치를 프라이팬에 볶는다."
                    : kimchiMethod,
                }],
              }),
            },
          }],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch,
});
if (
  !bulkFallback.fallback ||
  bulkFallbackCalls.join(",") !== "household,institutional"
) {
  throw new Error(
    "가정용 팬 조리법이 그대로 저장되지 않고 대체 모델을 실행해야 합니다",
  );
}

const makeUpgradeState = () =>
  JSON.parse(JSON.stringify({
    recipes: beefItems.map((r) => ({
      ...r,
      menu: "육전",
      comp: "주찬",
      allergy: "계란,밀",
      custom: "보존",
    })),
    methods: { "육전": "1. 프라이팬에 기름을 두르고 소고기를 부친다." },
    sources: { "육전": "기존 출처 보존" },
    recipeMeta: {
      "육전": { by: "ai", updated: "2026-09-20", custom: "meta 보존" },
    },
    recipeAsk: { "육전": { ask: "기존 확인 요청 보존" } },
    menus: { "2026-10": { "1|중식|2": "육전", "1|중식|n": 100 } },
  }));
const upgradeState = makeUpgradeState();
const upgradeTargets = institutionalUpgradeList(upgradeState);
if (upgradeTargets.length !== 1 || upgradeTargets[0].menu !== "육전") {
  throw new Error("AI 가정용 조리법이 전환 대기열에 있어야 합니다");
}
if (
  !buildPrompt(upgradeTargets).includes("기존 출처 보존") ||
  !buildPrompt(upgradeTargets).includes("method만 새로 작성")
) {
  throw new Error(
    "전환 프롬프트에 기존 재료·출처와 조리법 한정 변경 지시가 필요합니다",
  );
}
const preserved = JSON.stringify({
  recipes: upgradeState.recipes,
  sources: upgradeState.sources,
  recipeAsk: upgradeState.recipeAsk,
  menus: upgradeState.menus,
});
const upgraded = mergeInstitutionalMethods(
  upgradeState,
  [{
    ...bulkBeef,
    items: [{ item: "설탕", qty: 999, unit: "g" }],
    allergy: "변경 금지",
    source: "변경 금지",
  }],
  upgradeTargets,
  "2026-09-30",
);
if (
  upgraded.upgraded.join(",") !== "육전" ||
  upgradeState.recipeMeta["육전"].cookingProfile !==
    INSTITUTIONAL_COOKING_PROFILE ||
  upgradeState.recipeMeta["육전"].custom !== "meta 보존" ||
  JSON.stringify({
      recipes: upgradeState.recipes,
      sources: upgradeState.sources,
      recipeAsk: upgradeState.recipeAsk,
      menus: upgradeState.menus,
    }) !== preserved ||
  institutionalUpgradeList(upgradeState).length
) {
  throw new Error(
    "전환은 조리법·메타만 바꾸고 재료·알레르기·출처·식단을 보존해야 합니다",
  );
}
for (
  const mutate of [
    (s: ReturnType<typeof makeUpgradeState>) => {
      s.methods["육전"] += " 사용자 수정";
    },
    (s: ReturnType<typeof makeUpgradeState>) => {
      s.recipes[0].qty = 110;
    },
    (s: ReturnType<typeof makeUpgradeState>) => {
      s.recipes[0].allergy = "수동 알레르기";
    },
    (s: ReturnType<typeof makeUpgradeState>) => {
      s.recipeMeta["육전"].by = "user";
    },
    (s: ReturnType<typeof makeUpgradeState>) => {
      s.sources["육전"] = "새로운 출처";
    },
  ]
) {
  const concurrent = makeUpgradeState();
  const baseline = institutionalUpgradeList(concurrent);
  mutate(concurrent);
  const before = JSON.stringify(concurrent);
  const result = mergeInstitutionalMethods(
    concurrent,
    [bulkBeef],
    baseline,
    "2026-09-30",
  );
  if (result.upgraded.length || JSON.stringify(concurrent) !== before) {
    throw new Error("동시 수동 변경이 있는 레시피를 전환으로 덮어썼습니다");
  }
}
const manual = makeUpgradeState();
manual.recipeMeta["육전"].by = "user";
if (
  needsInstitutionalUpgrade(manual, "육전") ||
  institutionalUpgradeList(manual).length
) {
  throw new Error("수동 레시피를 AI 대량 전환 대상으로 지정했습니다");
}
const properGriddle = makeUpgradeState();
properGriddle.methods["육전"] = bulkBeefMethod.replace(
  "같은 두께로 손질",
  "한 장씩 같은 두께로 손질",
);
if (needsInstitutionalUpgrade(properGriddle, "육전")) {
  throw new Error("전판의 정상적인 한 장씩 전처리를 가정용으로 오인했습니다");
}
const invalidUpgradeState = makeUpgradeState();
const invalidUpgradeBefore = JSON.stringify(invalidUpgradeState);
if (
  mergeInstitutionalMethods(
    invalidUpgradeState,
    [{ ...bulkBeef, method: "1. 프라이팬에 굽는다." }],
    institutionalUpgradeList(invalidUpgradeState),
    "2026-09-30",
  ).upgraded.length ||
  JSON.stringify(invalidUpgradeState) !== invalidUpgradeBefore
) {
  throw new Error("잘못된 전환 조리법에 대량 조리 메타가 붙었습니다");
}
const peers = ["가", "나", "다"].map((menu) => ({
  ...upgradeTargets[0],
  menu,
}));
const missingPeer = { ...peers[0], menu: "신규", methodUpgrade: undefined };
const selected = selectRecipeTargets([missingPeer], peers, 8, [{
  status: "done",
  started_at: "2026-09-30T00:00:00Z",
  targets: ["가", "나"],
  note: "생성 실패(다음 실행 재시도): 가 · 전환 대기 3개",
}]);
if (
  selected.map((t) => t.menu).join(",") !== "신규,나,다" ||
  selectRecipeTargets([missingPeer], peers, 1).length !== 1
) {
  throw new Error(
    "신규 우선·전환 최대2개·실패 메뉴 후순위 선택 규칙이 깨졌습니다",
  );
}

console.log("INSTITUTIONAL_RECIPE_LOCAL_OK");

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
  "```json\n" +
    JSON.stringify({
      recipes: [{
        menu: "__테스트음식__",
        comp: "주찬",
        items: [{ item: "두부", qty: 80, unit: "g" }, {
          item: "물",
          qty: 100,
          unit: "ml",
        }],
        method: bulkBeefMethod.replaceAll("소고기 홍두깨살", "두부").replaceAll(
          "소고기",
          "두부",
        ),
      }],
    }) + "\n```",
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

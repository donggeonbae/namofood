// Actual nmf-menu-recommend HTTP handler, isolated database/runtime.
// Run: deno run -A tools/test_menu_recommend.ts
import { encryptText } from "../supabase/functions/nmf-recipe-fill/lib.ts";
import {
  buildRecommendationInput,
  buildRecommendationPrompt,
  type MenuRecommendState,
  parseRecommendationOpenCodeResponse,
  recipeFoodProfile,
  validateRecommendationAnswer,
} from "../supabase/functions/nmf-menu-recommend/lib.ts";

type Handler = (req: Request) => Promise<Response>;
type RecipeRow = Record<string, unknown>;

const APP_PASSWORD = "offline-menu-recommend-password";
const DOMAIN = "https://d-bae.com";
const ATTACKER = "https://d-bae.com.attacker.invalid";
const endpoint = "https://offline.invalid/functions/v1/nmf-menu-recommend";
const globals = globalThis as unknown as Record<string, unknown>;
const envKeys = [
  "NMF_PW",
  "NMF_TABLE",
  "NMF_ROOM",
  "OPENCODE_API_KEY",
  "OPENCODE_GO_API_KEY",
  "OPENCODE_BASE_URL",
  "NMF_MENU_RECOMMEND_MODEL",
  "NMF_MENU_RECOMMEND_FALLBACK_MODEL",
  "NMF_MENU_RECOMMEND_TIMEOUT_MS",
];
const originalEnv = new Map(envKeys.map((key) => [key, Deno.env.get(key)]));
const nativeFetch = globalThis.fetch;
let handler!: Handler;
let readCalls = 0;
let fetchCalls = 0;
let writes = 0;
let providerSuccessSlots: Record<string, unknown>;

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  assert(
    actual === expected,
    `${message}: expected ${expected}, got ${actual}`,
  );
}
function assertThrows(fn: () => unknown, message: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}
function assertCors(response: Response, origin: string | null, label: string) {
  equal(response.headers.get("access-control-allow-origin"), origin, label);
  equal(response.headers.get("vary"), "Origin", `${label}: vary`);
  equal(
    response.headers.get("cache-control"),
    "no-store",
    `${label}: no-store`,
  );
}
async function sign(date: string, nonce = "nonce-1", time = Date.now()) {
  const ts = String(time), enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(APP_PASSWORD),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(`nmf-menu-recommend:${date}:${nonce}:${ts}`),
      ),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  return { ts, sig, nonce };
}
async function signedRequest(
  date = "2026-10-24",
  nonce = "nonce-1",
  origin = DOMAIN,
) {
  const { ts, sig } = await sign(date, nonce);
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nmf-time": ts,
      "x-nmf-signature": sig,
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ date, nonce }),
  });
}
async function responseBody(response: Response) {
  return await response.json() as Record<string, unknown>;
}
function addRecipe(
  state: MenuRecommendState,
  menu: string,
  comp: string,
  item: string,
  qty = 100,
  method = "1. 대량 조리한다.",
) {
  (state.recipes as RecipeRow[]).push({ menu, comp, item, qty, unit: "g" });
  (state.methods as Record<string, string>)[menu] = method;
}
function fixtureState(): MenuRecommendState {
  const state: MenuRecommendState = {
    recipes: [],
    methods: {},
    recipeMeta: {},
    recipeAsk: {},
    menus: { "2026-10": { "23|중식|2": "제육볶음" } },
  };
  for (
    const name of ["소고기무국", "김치찌개", "된장국"]
  ) addRecipe(state, name, "국", name.replace(/국|찌개/g, "") || "무", 80);
  addRecipe(state, "제육볶음", "주찬", "돼지고기", 120);
  addRecipe(state, "소불고기", "주찬", "소고기", 120);
  addRecipe(state, "닭갈비", "주찬", "닭고기", 120);
  addRecipe(
    state,
    "육전",
    "주찬",
    "소고기",
    100,
    "1. 소고기에 계란물을 입혀 전판에 부친다.",
  );
  addRecipe(state, "고등어구이", "주찬", "고등어", 100);
  addRecipe(state, "오징어볶음", "주찬", "오징어", 100);
  addRecipe(state, "새우튀김", "주찬", "새우", 100);
  addRecipe(state, "계란말이", "주찬", "계란", 90);
  addRecipe(state, "두부조림", "주찬", "두부", 100);
  addRecipe(state, "왕교자튀김", "주찬", "고기만두", 100);
  for (
    const [name, item] of [
      ["콩나물무침", "콩나물"],
      ["시금치나물", "시금치"],
      ["오이무침", "오이"],
      ["애호박볶음", "애호박"],
      ["우엉조림", "우엉"],
      ["배추김치", "배추"],
    ]
  ) addRecipe(state, name, name === "배추김치" ? "김치" : "부찬", item);
  addRecipe(state, "콜라", "주찬", "콜라", 200);
  return state;
}
function profileRows(
  menu: string,
  rows: Array<[string, number, string?]>,
  comp = "주찬",
) {
  return rows.map(([item, qty, method]) => ({
    menu,
    comp,
    item,
    qty,
    unit: "g",
    method: method || "1. 대형 조리기구에서 배치별로 조리한다.",
  }));
}
function validSlots() {
  return {
    "1": ["소고기무국", "김치찌개", "된장국"].map((name) => ({
      name,
      reason: "국 후보",
    })),
    "2": ["소불고기", "닭갈비", "육전"].map((name) => ({
      name,
      reason: "고기 후보",
    })),
    "7": ["고등어구이", "오징어볶음", "새우튀김"].map((name) => ({
      name,
      reason: "생선 후보",
    })),
    "8": ["계란말이", "두부조림", "왕교자튀김"].map((name) => ({
      name,
      reason: "기타 후보",
    })),
    "3": ["콩나물무침", "시금치나물", "오이무침"].map((name) => ({
      name,
      reason: "야채 후보",
    })),
    "4": ["애호박볶음", "우엉조림", "배추김치"].map((name) => ({
      name,
      reason: "야채 후보",
    })),
  };
}
function idSlotsFor(input: ReturnType<typeof buildRecommendationInput>) {
  const names = validSlots();
  return Object.fromEntries(
    Object.entries(names).map(([slot, entries]) => [
      slot,
      entries.map((entry) => {
        const index = input.promptPools[slot as keyof typeof input.promptPools]
          .findIndex((candidate) => candidate.name === entry.name);
        assert(index >= 0, `${entry.name} exists in prompt pool ${slot}`);
        return { id: index + 1, reason: entry.reason };
      }),
    ]),
  );
}
function assertPromptExample(
  input: ReturnType<typeof buildRecommendationInput>,
  expectedTotal: number,
  label: string,
) {
  const prompt = buildRecommendationPrompt(input);
  assert(
    !/구성 목표는 국 1개/.test(prompt),
    `${label}: a recommendation prompt cannot ask for only one soup candidate`,
  );
  assert(
    /형식만 참고/.test(prompt),
    `${label}: the example is explicitly format-only, not the recommendation`,
  );
  const example = prompt.trim().split("\n").at(-1)!;
  const parsed = JSON.parse(example) as {
    slots: Record<string, Array<{ id: number }>>;
  };
  equal(
    Object.keys(parsed.slots).sort().join(","),
    "1,2,3,4,7,8",
    `${label}: the example includes all six slots`,
  );
  for (const slot of Object.keys(input.expectedCounts)) {
    const key = slot as keyof typeof input.expectedCounts;
    equal(
      parsed.slots[key].length,
      input.expectedCounts[key],
      `${label}: example slot ${key} has the exact required count`,
    );
    for (const { id } of parsed.slots[key]) {
      assert(
        Number.isInteger(id) && id > 0 &&
          id <= input.promptPools[key].length,
        `${label}: example slot ${key} uses only in-range numeric IDs`,
      );
    }
  }
  const accepted = validateRecommendationAnswer(example, input);
  const names = Object.values(accepted).flat().map((item) => item.name);
  equal(names.length, expectedTotal, `${label}: example validates exactly`);
  equal(
    new Set(names).size,
    expectedTotal,
    `${label}: the complete example does not repeat a vegetable or other dish`,
  );
}
function chatResponse(slots: Record<string, unknown> = providerSuccessSlots) {
  return new Response(
    JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ slots }) },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
function messagesResponse(
  slots: Record<string, unknown> = providerSuccessSlots,
) {
  return new Response(
    JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ slots }) }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

try {
  for (const key of envKeys) Deno.env.delete(key);
  Deno.env.set("NMF_PW", APP_PASSWORD);
  Deno.env.set("NMF_TABLE", "namofood_state");
  Deno.env.set("NMF_ROOM", "namofood");
  Deno.env.set("OPENCODE_API_KEY", "offline-opencode-key");
  Deno.env.set("OPENCODE_BASE_URL", "https://offline-opencode.invalid/v1");
  Deno.env.set("NMF_MENU_RECOMMEND_MODEL", "primary-bad");
  Deno.env.set("NMF_MENU_RECOMMEND_FALLBACK_MODEL", "minimax-m3");
  Deno.env.set("NMF_MENU_RECOMMEND_TIMEOUT_MS", "5000");

  const state = fixtureState();
  const profileCases: Array<[
    string,
    Array<Record<string, unknown>>,
    string,
    string?,
  ]> = [
    [
      "소고기청경채볶음",
      profileRows("소고기청경채볶음", [["소고기", 80], ["청경채", 100]]),
      "고기",
      "actual animal protein overrides vegetables when substantial",
    ],
    [
      "배추고기찜",
      profileRows("배추고기찜", [["돼지고기", 30], ["배추", 100]]),
      "야채",
      "small meat garnish cannot turn a vegetable dish into a meat slot",
    ],
    [
      "햄야채볶음",
      profileRows("햄야채볶음", [["햄", 50], ["양파", 70]]),
      "고기",
      "ham and sausage stay in the meat UI group",
    ],
    [
      "고등어구이",
      profileRows("고등어구이", [["고등어", 100]]),
      "생선",
    ],
    [
      "계란말이",
      profileRows("계란말이", [["계란", 90]]),
      "기타 주찬",
    ],
    [
      "소고기무국",
      profileRows("소고기무국", [["소고기", 45], ["무", 80]], "국"),
      "국",
    ],
    [
      "불고기덮밥",
      profileRows("불고기덮밥", [["돼지고기", 100], ["쌀", 180]]),
      "선택 제외",
      "whole rice/noodle meals are not a slot recommendation",
    ],
  ];
  for (const [name, rows, expected, label] of profileCases) {
    equal(
      recipeFoodProfile(name, rows).slotGroup,
      expected,
      label || `${name} profile parity`,
    );
  }
  const input = buildRecommendationInput(state, "2026-10-24", "nonce-1");
  providerSuccessSlots = idSlotsFor(input);
  const prompt = buildRecommendationPrompt(input);
  assert(
    /후보 번호 id만|10,000원|공장노동자|100~500인|회전솥|튀김기|전판|포만감|고기 메인|생선\/해산물|기타 주찬|야채 부찬|reason/
      .test(prompt),
    "prompt carries the aggressive factory-meal quality rules",
  );
  assert(/\[1\]/.test(prompt), "prompt uses compact numeric candidate IDs");
  equal(
    input.expectedCounts["1"],
    3,
    "full recommendation bank needs three soups",
  );
  assertPromptExample(input, 18, "full bank");
  for (let vegetableCount = 0; vegetableCount <= 6; vegetableCount++) {
    const shortageState = fixtureState();
    let keptVegetables = 0;
    shortageState.recipes = shortageState.recipes!.filter((row) =>
      !["부찬", "김치"].includes(String(row.comp)) ||
      keptVegetables++ < vegetableCount
    );
    const shortageInput = buildRecommendationInput(
      shortageState,
      "2026-10-24",
      "nonce-1",
    );
    equal(
      shortageInput.expectedCounts["3"] + shortageInput.expectedCounts["4"],
      vegetableCount,
      `vegetable shortage ${vegetableCount} preserves the available count`,
    );
    assertPromptExample(
      shortageInput,
      12 + vegetableCount,
      `vegetable shortage ${vegetableCount}`,
    );
  }
  for (let soupCount = 0; soupCount < 3; soupCount++) {
    const shortageState = fixtureState();
    let keptSoups = 0;
    shortageState.recipes = shortageState.recipes!.filter((row) =>
      row.comp !== "국" || keptSoups++ < soupCount
    );
    const shortageInput = buildRecommendationInput(
      shortageState,
      "2026-10-24",
      "nonce-1",
    );
    equal(
      shortageInput.expectedCounts["1"],
      soupCount,
      `soup shortage ${soupCount} preserves the available count`,
    );
    assertPromptExample(
      shortageInput,
      15 + soupCount,
      `soup shortage ${soupCount}`,
    );
  }
  const numericAnswer = JSON.stringify({ slots: providerSuccessSlots });
  const fencedAnswer = `\`\`\`json\n${numericAnswer}\n\`\`\``;
  equal(
    validateRecommendationAnswer(fencedAnswer, input)["2"][0].name,
    "소불고기",
    "numeric IDs map back to existing recipe names",
  );
  const protocolText = parseRecommendationOpenCodeResponse("messages", {
    stop_reason: "end_turn",
    content: [
      { type: "thinking", text: '{"slots":{"1":[{"id":999}]}}' },
      { type: "text", text: fencedAnswer },
    ],
  });
  equal(
    validateRecommendationAnswer(protocolText, input)["7"][1].name,
    "오징어볶음",
    "messages parser ignores non-text metadata blocks",
  );
  assertThrows(
    () =>
      validateRecommendationAnswer(
        JSON.stringify({
          slots: {
            ...providerSuccessSlots,
            "1": [{ id: 999 }, { id: 1 }, { id: 2 }],
          },
        }),
        input,
      ),
    "outside numeric candidate IDs are rejected",
  );
  assertThrows(
    () =>
      validateRecommendationAnswer(
        JSON.stringify({
          slots: {
            ...providerSuccessSlots,
            "2": [
              (providerSuccessSlots["2"] as Array<Record<string, unknown>>)[0],
              (providerSuccessSlots["2"] as Array<Record<string, unknown>>)[0],
              (providerSuccessSlots["2"] as Array<Record<string, unknown>>)[2],
            ],
          },
        }),
        input,
      ),
    "duplicate canonical IDs are rejected",
  );
  assertThrows(
    () =>
      validateRecommendationAnswer(
        JSON.stringify({
          slots: {
            ...providerSuccessSlots,
            "2": [
              {
                ...(providerSuccessSlots["2"] as Array<
                  Record<string, unknown>
                >)[0],
                name: "닭갈비",
              },
              ...(providerSuccessSlots["2"] as Array<Record<string, unknown>>)
                .slice(1),
            ],
          },
        }),
        input,
      ),
    "id/name ambiguity is rejected",
  );
  assertThrows(
    () =>
      validateRecommendationAnswer(`${numericAnswer}\n${numericAnswer}`, input),
    "multiple JSON roots are rejected",
  );
  const unresolvedState = fixtureState();
  unresolvedState.recipeAsk = { 소불고기: { reason: "검토 중" } };
  const unresolvedInput = buildRecommendationInput(
    unresolvedState,
    "2026-10-24",
    "nonce-1",
  );
  assert(
    input.fingerprint !== unresolvedInput.fingerprint,
    "recipeAsk changes invalidate the recommendation cache fingerprint",
  );
  assert(
    !unresolvedInput.pools["2"].some((item) => item.name === "소불고기"),
    "unresolved recipeAsk menus are removed from candidate pools",
  );
  assert(
    !input.pools["2"].some((item) => item.name === "제육볶음"),
    "nearby canonical duplicate excluded",
  );
  equal(input.expectedCounts["3"], 3, "side slot 3 has full count");
  equal(input.expectedCounts["4"], 3, "side slot 4 has full count");

  const encrypted = await encryptText(APP_PASSWORD, JSON.stringify(state));
  globals.__menuRecommendDb = {
    async readState(table: string, room: string) {
      readCalls++;
      equal(table, "namofood_state", "state table");
      equal(room, "namofood", "state room");
      return [{ data: encrypted, updated_at: "2026-10-08T00:00:00.000Z" }];
    },
    writeState() {
      writes++;
      throw new Error("menu recommendation endpoint attempted a state write");
    },
    snapshotState() {
      writes++;
      throw new Error(
        "menu recommendation endpoint attempted a snapshot write",
      );
    },
  };
  globals.__menuRecommendCapture = (value: Handler) => handler = value;
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    const text = String(url);
    const body = JSON.parse(String(init?.body || "{}"));
    if (fetchCalls === 1) {
      assert(
        text.endsWith("/chat/completions"),
        "primary uses chat completions",
      );
      equal(body.model, "primary-bad", "primary model");
      equal(body.max_tokens, 8192, "recommendation default max tokens");
      return new Response(
        JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                slots: { "1": [{ name: "없는국", reason: "bad" }] },
              }),
            },
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    assert(text.endsWith("/messages"), "fallback uses messages protocol");
    equal(body.model, "minimax-m3", "fallback model");
    return messagesResponse();
  };

  let source = await Deno.readTextFile(
    new URL(
      "../supabase/functions/nmf-menu-recommend/index.ts",
      import.meta.url,
    ),
  );
  assert(
    !/writeState|snapshotState|nmf-menu-plan\/index/.test(source),
    "handler source stays read-only",
  );
  source = source.replace(
    /import\s*\{\s*readState\s*\}\s*from "\.\.\/_shared\/database\.ts";/,
    "const { readState } = (globalThis as any).__menuRecommendDb;",
  ).replace(
    'from "../_shared/institutional-menu.ts";',
    `from ${
      JSON.stringify(
        new URL(
          "../supabase/functions/_shared/institutional-menu.ts",
          import.meta.url,
        ).href,
      )
    };`,
  ).replace(
    'from "../nmf-recipe-fill/lib.ts";',
    `from ${
      JSON.stringify(
        new URL("../supabase/functions/nmf-recipe-fill/lib.ts", import.meta.url)
          .href,
      )
    };`,
  ).replace(
    'from "./lib.ts";',
    `from ${
      JSON.stringify(
        new URL(
          "../supabase/functions/nmf-menu-recommend/lib.ts",
          import.meta.url,
        ).href,
      )
    };`,
  ).replace("Deno.serve(", "(globalThis as any).__menuRecommendCapture(");
  await import(`data:application/typescript,${encodeURIComponent(source)}`);
  assert(handler, "actual handler loaded");

  const invalidDate = await handler(
    new Request(endpoint, {
      method: "POST",
      headers: { origin: DOMAIN, "content-type": "application/json" },
      body: '{"date":"bad","nonce":"nonce-1"}',
    }),
  );
  equal(invalidDate.status, 400, "invalid date rejected before auth/db");
  assertCors(invalidDate, DOMAIN, "invalid date CORS");

  const unauthorized = await handler(
    new Request(endpoint, {
      method: "POST",
      headers: { origin: DOMAIN, "content-type": "application/json" },
      body: '{"date":"2026-10-24","nonce":"nonce-1"}',
    }),
  );
  equal(unauthorized.status, 401, "missing signature rejected");
  assertCors(unauthorized, DOMAIN, "unauthorized CORS");
  equal(readCalls, 0, "auth/date failures do not read DB");
  equal(fetchCalls, 0, "auth/date failures do not call model");

  const preflight = await handler(
    new Request(endpoint, { method: "OPTIONS", headers: { origin: DOMAIN } }),
  );
  equal(preflight.status, 200, "preflight succeeds");
  assertCors(preflight, DOMAIN, "preflight CORS");

  const response = await handler(await signedRequest());
  equal(response.status, 200, "valid signed recommendation succeeds");
  assertCors(response, DOMAIN, "valid CORS");
  const data = await responseBody(response);
  equal(data.ok, true, "response ok");
  equal(data.source, "ai", "source is ai");
  equal(data.model, "minimax-m3", "fallback model chosen");
  equal(data.cached, false, "first response not cache");
  equal(data.validatedCount, 18, "exactly 18 recommendations validated");
  assert(
    data.aliases && typeof data.aliases === "object",
    "read-only canonical alias map is returned for browser-side validation",
  );
  const slots = data.slots as Record<string, Array<{ name: string }>>;
  equal(
    slots["2"].some((item) => item.name === "제육볶음"),
    false,
    "excluded nearby duplicate absent",
  );
  equal(
    new Set(Object.values(slots).flat().map((item) => item.name)).size,
    18,
    "global distinct names",
  );
  equal(fetchCalls, 2, "primary plus fallback only");
  equal(writes, 0, "no state writes");

  const cached = await handler(await signedRequest());
  equal(cached.status, 200, "cached request succeeds");
  equal(
    (await responseBody(cached)).cached,
    true,
    "second response served from in-memory cache",
  );
  equal(fetchCalls, 2, "cache avoids second model call");

  const untrusted = await handler(
    await signedRequest("2026-10-24", "nonce-1", ATTACKER),
  );
  equal(
    untrusted.status,
    200,
    "HMAC remains auth boundary for non-browser caller",
  );
  assertCors(untrusted, null, "untrusted origin not reflected");

  let scenarioCalls = 0;
  globalThis.fetch = async () => {
    scenarioCalls++;
    return scenarioCalls === 1
      ? chatResponse({ "1": [{ name: "없는국", reason: "bad" }] })
      : new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "{}" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
  };
  const failed = await handler(
    await signedRequest("2026-10-24", "failure-retry"),
  );
  equal(failed.status, 502, "dual invalid model responses return 502");
  const failedBody = await responseBody(failed);
  equal(failedBody.ok, false, "failed response is not ok");
  equal("slots" in failedBody, false, "failed response never fabricates slots");
  equal(
    "source" in failedBody,
    false,
    "failed response never claims source ai",
  );
  assert(
    String(failedBody.error || "").includes("AI 추천 모델 응답 실패") &&
      !String(failedBody.error || "").includes("모든 메뉴 생성 모델 실패"),
    "recommendation failure copy cannot look like retired menu auto-generation",
  );
  equal(scenarioCalls, 2, "failed run tried primary and fallback");

  scenarioCalls = 0;
  globalThis.fetch = async (url) => {
    scenarioCalls++;
    return String(url).endsWith("/chat/completions")
      ? chatResponse()
      : messagesResponse();
  };
  const recovered = await handler(
    await signedRequest("2026-10-24", "failure-retry"),
  );
  equal(
    recovered.status,
    200,
    "same nonce can retry after a failed uncached run",
  );
  equal(
    (await responseBody(recovered)).cached,
    false,
    "failed run did not poison cache",
  );
  equal(scenarioCalls, 1, "successful retry uses a fresh provider call");

  let release!: () => void;
  let started = false;
  scenarioCalls = 0;
  globalThis.fetch = async (url) => {
    scenarioCalls++;
    if (!started) {
      started = true;
      await new Promise<void>((resolve) => release = resolve);
    }
    return String(url).endsWith("/chat/completions")
      ? chatResponse({ "1": [{ name: "없는국", reason: "bad" }] })
      : messagesResponse();
  };
  const firstCoalesced = handler(
    await signedRequest("2026-10-24", "coalesce-1"),
  );
  while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
  const secondCoalesced = handler(
    await signedRequest("2026-10-24", "coalesce-1"),
  );
  release();
  const coalescedResponses = await Promise.all([
    firstCoalesced,
    secondCoalesced,
  ]);
  equal(coalescedResponses[0].status, 200, "first coalesced request succeeds");
  equal(coalescedResponses[1].status, 200, "second coalesced request succeeds");
  equal(
    scenarioCalls,
    2,
    "simultaneous same input shares one primary/fallback sequence",
  );
  equal(
    (await responseBody(coalescedResponses[1])).cached,
    true,
    "joined inflight response is marked cached",
  );

  scenarioCalls = 0;
  globalThis.fetch = async (url) => {
    scenarioCalls++;
    return String(url).endsWith("/chat/completions")
      ? chatResponse()
      : messagesResponse();
  };
  for (let i = 0; i < 33; i++) {
    const filled = await handler(
      await signedRequest("2026-10-24", `cache-fill-${i}`),
    );
    equal(filled.status, 200, `cache fill ${i} succeeds`);
  }
  const refetchedOld = await handler(await signedRequest());
  equal(
    refetchedOld.status,
    200,
    "old entry can be refetched after cache pressure",
  );
  equal(
    (await responseBody(refetchedOld)).cached,
    false,
    "bounded cache evicts oldest entry instead of growing unbounded",
  );

  let failingHandler!: Handler;
  globals.__menuRecommendDb = {
    readState() {
      throw new Error("raw database password should stay private");
    },
  };
  globals.__menuRecommendCapture = (value: Handler) => failingHandler = value;
  await import(
    `data:application/typescript,${
      encodeURIComponent(`${source}\n// db failure masking`)
    }`
  );
  const internalError = await failingHandler(
    await signedRequest("2026-10-24", "db-failure"),
  );
  equal(internalError.status, 500, "database/internal failure returns 500");
  const internalBody = await responseBody(internalError);
  equal(
    internalBody.reason,
    "recommendation_unavailable",
    "internal reason is generalized",
  );
  assert(
    /추천 자료를 읽지 못했습니다/.test(String(internalBody.error || "")),
    "internal error is a user-readable Korean message",
  );
  assert(
    !JSON.stringify(internalBody).includes("raw database password"),
    "raw internal exception text is not public",
  );

  console.log(
    "MENU_RECOMMEND_OK / PROMPT_EXAMPLE_COUNTS_11_CASES / ACTUAL_HANDLER / HMAC_DATE_NONCE / FALLBACK_PROTOCOL / EXISTING_RECIPE_ONLY / READ_ONLY / CACHE / FAILURE_RETRY / INFLIGHT_COALESCE / BOUNDED_CACHE",
  );
} finally {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of originalEnv) {
    value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
  delete globals.__menuRecommendDb;
  delete globals.__menuRecommendCapture;
}

// Actual nmf-menu-recommend HTTP handler, isolated database/runtime.
// Run: deno run -A tools/test_menu_recommend.ts
import { encryptText } from "../supabase/functions/nmf-recipe-fill/lib.ts";
import { ModelFallbackError } from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  buildRecommendationInput,
  buildRecommendationPrompt,
  type MenuRecommendState,
  parseRecommendationOpenCodeResponse,
  recipeFoodProfile,
  recommendationCatalogRevision,
  type RecommendationModelOptions,
  runRecommendationModel,
  validateRecommendationAnswer,
  validateStoredRecommendationBank,
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
  "NMF_CRON_SECRET",
];
const originalEnv = new Map(envKeys.map((key) => [key, Deno.env.get(key)]));
const nativeFetch = globalThis.fetch;
let handler!: Handler;
let readCalls = 0;
let fetchCalls = 0;
let writes = 0;
let providerSuccessSlots: Record<string, unknown>;
type FakeBankRow = {
  catalog_revision: string;
  response: unknown;
  updated_at: string;
  lease_expires_at: string | null;
  lease_token: string | null;
  generated_at: string | null;
};
const bankRows = new Map<string, FakeBankRow>();
const bankKey = (table: string, room: string, date: string) =>
  JSON.stringify([table, room, date]);
let storageCalls = 0;
let failBankRead = false;
let failBankSave = false;
let storeClock = Date.now();
const nextVersion = () => new Date(++storeClock).toISOString();
const sqlTexts: string[] = [];
async function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  storageCalls++;
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  sqlTexts.push(text);
  if (text.startsWith("select pg_advisory_xact_lock")) return [];
  if (text.startsWith("select count(*)")) {
    const [table, room] = values as string[];
    return [{
      count: [...bankRows].filter(([key, row]) => {
        const [rowTable, rowRoom] = JSON.parse(key);
        return rowTable === table && rowRoom === room && row.lease_expires_at &&
          Date.parse(row.lease_expires_at) > Date.now();
      }).length,
    }];
  }
  if (text.startsWith("select catalog_revision")) {
    if (failBankRead) throw new Error("private storage database credential");
    const [table, room, date] = values as string[];
    const row = bankRows.get(bankKey(table, room, date));
    return row ? [structuredClone(row)] : [];
  }
  if (text.startsWith("insert into public.nmf_menu_recommend_banks")) {
    const [table, room, date, revision, token, observed] = values as string[];
    const key = bankKey(table, room, date), row = bankRows.get(key);
    if (
      row && (row.updated_at !== observed ||
        (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now()))
    ) return [];
    bankRows.set(key, {
      catalog_revision: revision,
      response: null,
      generated_at: null,
      updated_at: nextVersion(),
      lease_token: token,
      lease_expires_at: new Date(Date.now() + 150_000).toISOString(),
    });
    return [{ lease_token: token }];
  }
  if (text.startsWith("update public.nmf_menu_recommend_banks set response=")) {
    if (failBankSave) throw new Error("private storage save credential");
    const [response, generated, table, room, date, revision, token] =
      values as [unknown, string, string, string, string, string, string];
    const key = bankKey(table, room, date), row = bankRows.get(key);
    if (
      !row || row.catalog_revision !== revision || row.lease_token !== token ||
      !row.lease_expires_at || Date.parse(row.lease_expires_at) <= Date.now()
    ) return [];
    bankRows.set(key, {
      ...row,
      response: structuredClone(response),
      generated_at: generated,
      lease_token: null,
      lease_expires_at: null,
      updated_at: nextVersion(),
    });
    return [{ target_date: date }];
  }
  if (
    text.startsWith(
      "update public.nmf_menu_recommend_banks set lease_token=null",
    )
  ) {
    const [table, room, date, token] = values as string[];
    const key = bankKey(table, room, date), row = bankRows.get(key);
    if (row?.lease_token === token) {
      bankRows.set(key, {
        ...row,
        lease_token: null,
        lease_expires_at: null,
        updated_at: nextVersion(),
      });
    }
    return [];
  }
  throw new Error(`Unexpected actual storage query: ${text}`);
}
let claimQueue = Promise.resolve();
const fakeSqlWithMethods = Object.assign(fakeSql, {
  json: (value: unknown) => value,
  async begin<T>(callback: (transaction: typeof fakeSql) => Promise<T>) {
    let unlock!: () => void;
    const previous = claimQueue;
    claimQueue = new Promise<void>((resolve) => unlock = resolve);
    await previous;
    try {
      return await callback(fakeSql);
    } finally {
      unlock();
    }
  },
});

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
async function expectedModelFailure(
  request: Promise<unknown>,
  label: string,
): Promise<ModelFallbackError> {
  try {
    await request;
  } catch (error) {
    assert(
      error instanceof ModelFallbackError,
      `${label}: failure has attempts`,
    );
    return error;
  }
  throw new Error(
    `${label}: invalid output must not become AI recommendations`,
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
  Deno.env.set("NMF_CRON_SECRET", "offline-cron-secret");

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

  const modelOptions: Omit<RecommendationModelOptions, "fetcher"> = {
    apiKey: "offline-opencode-key",
    baseUrl: "https://offline-opencode.invalid/v1",
    primaryModel: "primary-bad",
    fallbackModel: "minimax-m3",
    timeoutMs: 45_000,
    maxTokens: 8192,
  };
  const missingSide = { ...providerSuccessSlots, "4": [] };
  const correctionCalls: Array<{ model: string; prompt: string }> = [];
  const corrected = await runRecommendationModel(input, {
    ...modelOptions,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      correctionCalls.push({
        model: body.model,
        prompt: body.messages[0].content,
      });
      if (correctionCalls.length === 1) {
        throw new DOMException("primary timeout", "TimeoutError");
      }
      return messagesResponse(
        correctionCalls.length === 2 ? missingSide : providerSuccessSlots,
      );
    },
  });
  equal(
    correctionCalls.length,
    3,
    "semantic fallback failure gets one correction",
  );
  equal(
    correctionCalls.map((call) => call.model).join(","),
    "primary-bad,minimax-m3,minimax-m3",
    "correction repeats only the final fallback after normal model order",
  );
  assert(
    correctionCalls[2].prompt.includes(
      "부찬2(야채) 추천 수가 0개입니다. 정확히 3개여야 합니다",
    ),
    "correction prompt carries the exact validation failure",
  );
  equal(
    corrected.source,
    "ai",
    "corrected data comes from actual model output",
  );
  equal(corrected.model, "minimax-m3", "correction reports the fallback model");
  equal(corrected.fallbackUsed, true, "correction remains fallback provenance");
  equal(
    corrected.validatedCount,
    18,
    "correction still validates exactly eighteen",
  );
  equal(
    corrected.attempts.map((attempt) => attempt.ok).join(","),
    "false,false,true",
    "all three attempt outcomes are retained",
  );
  equal(
    Object.values(corrected.slots).flat().filter((item) =>
      item.name === "제육볶음"
    )
      .length,
    0,
    "correction cannot reintroduce excluded nearby dishes",
  );
  let correctionFailures = 0;
  const invalidAgain = await expectedModelFailure(
    runRecommendationModel(input, {
      ...modelOptions,
      fetcher: async () => {
        correctionFailures++;
        if (correctionFailures === 1) {
          throw new DOMException("primary timeout", "TimeoutError");
        }
        return messagesResponse(missingSide);
      },
    }),
    "invalid correction",
  );
  equal(
    correctionFailures,
    3,
    "an invalid correction cannot start another retry",
  );
  equal(
    invalidAgain.attempts.length,
    3,
    "invalid correction keeps all diagnostics",
  );
  assert(
    invalidAgain.attempts.every((attempt) => !attempt.ok),
    "invalid correction never records success",
  );
  for (const status of [401, 429, 503]) {
    let calls = 0;
    const failure = await expectedModelFailure(
      runRecommendationModel(input, {
        ...modelOptions,
        fetcher: async () => {
          calls++;
          return new Response("provider unavailable", { status });
        },
      }),
      `HTTP ${status}`,
    );
    equal(calls, 2, `HTTP ${status} never gets a corrective third request`);
    equal(failure.attempts.length, 2, `HTTP ${status} retains normal attempts`);
  }
  let networkCalls = 0;
  await expectedModelFailure(
    runRecommendationModel(input, {
      ...modelOptions,
      fetcher: async () => {
        networkCalls++;
        throw new TypeError("failed to fetch");
      },
    }),
    "network failure",
  );
  equal(networkCalls, 2, "pure transport failure does not get a third request");
  let timeoutCalls = 0;
  const timedOut = await expectedModelFailure(
    runRecommendationModel(input, {
      ...modelOptions,
      fetcher: async () => {
        timeoutCalls++;
        throw new DOMException("provider timeout", "TimeoutError");
      },
    }),
    "both model timeouts",
  );
  equal(timeoutCalls, 2, "pure timeout failure does not get a third request");
  equal(
    timedOut.attempts.length,
    2,
    "timeouts retain normal attempt diagnostics",
  );
  for (const truncatedJson of [false, true]) {
    let calls = 0;
    const failure = await expectedModelFailure(
      runRecommendationModel(input, {
        ...modelOptions,
        fetcher: async () => {
          calls++;
          if (calls === 1) return chatResponse(missingSide);
          return new Response(
            JSON.stringify({
              stop_reason: truncatedJson ? "end_turn" : "max_tokens",
              content: [{ type: "text", text: truncatedJson ? "{" : "{}" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
      truncatedJson ? "truncated JSON" : "provider truncation",
    );
    equal(
      calls,
      2,
      "final truncation suppresses even earlier validation failures",
    );
    equal(failure.attempts.length, 2, "truncation keeps only normal attempts");
  }
  const abortController = new AbortController();
  let abortCalls = 0;
  const aborted = await expectedModelFailure(
    runRecommendationModel(input, {
      ...modelOptions,
      signal: abortController.signal,
      fetcher: async () => {
        abortCalls++;
        if (abortCalls === 1) {
          throw new DOMException("primary timeout", "TimeoutError");
        }
        abortController.abort();
        return messagesResponse(missingSide);
      },
    }),
    "aborted correction",
  );
  equal(abortCalls, 2, "an aborted request never starts a correction");
  equal(
    aborted.attempts.length,
    2,
    "abort preserves existing attempt diagnostics",
  );
  const nativeNow = Date.now, nativeTimeout = AbortSignal.timeout;
  try {
    let now = 1000;
    Date.now = () => now;
    const timeouts: number[] = [];
    AbortSignal.timeout = (delay: number) => {
      timeouts.push(delay);
      return nativeTimeout(delay);
    };
    let calls = 0;
    const withinBudget = await runRecommendationModel(input, {
      ...modelOptions,
      fetcher: async () => {
        calls++;
        if (calls === 1) {
          now += 45_000;
          throw new DOMException("primary timeout", "TimeoutError");
        }
        if (calls === 2) {
          now += 45_000;
          return messagesResponse(missingSide);
        }
        now += 19_999;
        return messagesResponse();
      },
    });
    equal(
      withinBudget.validatedCount,
      18,
      "a correction within budget succeeds",
    );
    equal(
      withinBudget.attempts.map((attempt) => attempt.elapsedMs).join(","),
      "45000,45000,19999",
      "correction diagnostics preserve each attempt's actual elapsed time",
    );
    equal(
      timeouts.join(","),
      "45000,45000,20000",
      "per-call timeout is limited to the remaining 110-second total budget",
    );
    now = 1000;
    timeouts.length = 0;
    calls = 0;
    const expired = await expectedModelFailure(
      runRecommendationModel(input, {
        ...modelOptions,
        fetcher: async () => {
          calls++;
          now += 55_000;
          if (calls === 1) {
            throw new DOMException("primary timeout", "TimeoutError");
          }
          return messagesResponse(missingSide);
        },
      }),
      "expired model budget",
    );
    equal(calls, 2, "expired total budget prevents a third provider call");
    equal(
      expired.attempts.length,
      2,
      "expired budget retains normal diagnostics",
    );
  } finally {
    Date.now = nativeNow;
    AbortSignal.timeout = nativeTimeout;
  }

  let encrypted = await encryptText(APP_PASSWORD, JSON.stringify(state));
  globals.__menuRecommendDb = {
    async readState(table: string, room: string) {
      readCalls++;
      equal(table, "namofood_state", "state table");
      assert(["namofood", "other-room"].includes(room), "state room");
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
  globals.__menuRecommendSql = fakeSqlWithMethods;
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

  let storageSource = await Deno.readTextFile(
    new URL(
      "../supabase/functions/nmf-menu-recommend/storage.ts",
      import.meta.url,
    ),
  );
  storageSource = storageSource.replace(
    /import\s*\{\s*sql\s*\}\s*from "\.\.\/_shared\/database\.ts";/,
    "const sql = (globalThis as any).__menuRecommendSql;",
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
  );
  const storageUrl = `data:application/typescript,${
    encodeURIComponent(storageSource)
  }`;
  const storageModule = await import(storageUrl);
  let source = await Deno.readTextFile(
    new URL(
      "../supabase/functions/nmf-menu-recommend/index.ts",
      import.meta.url,
    ),
  );
  if (
    Deno.env.get("NMF_SERVER_BANK_NEGATIVE_CONTROL") === "old-isolate-cache"
  ) {
    const baseline = await new Deno.Command("git", {
      args: ["show", "HEAD:supabase/functions/nmf-menu-recommend/index.ts"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      baseline.success,
      "negative control loads exact old committed handler",
    );
    source = new TextDecoder().decode(baseline.stdout);
  }
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
  ).replace('from "./storage.ts";', `from ${JSON.stringify(storageUrl)};`)
    .replace("Deno.serve(", "(globalThis as any).__menuRecommendCapture(");
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
  equal(storageCalls, 0, "auth/date failures do not access server banks");

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
    "second response served from durable server bank",
  );
  equal(fetchCalls, 2, "cache avoids second model call");

  async function freshHandler(label: string): Promise<Handler> {
    let isolated!: Handler;
    globals.__menuRecommendCapture = (value: Handler) => isolated = value;
    await import(
      `data:application/typescript,${
        encodeURIComponent(`${source}\n// ${label}`)
      }`
    );
    return isolated;
  }
  const isolatedHandler = await freshHandler("fresh isolate durable reuse");
  const reused = await responseBody(
    await isolatedHandler(
      await signedRequest("2026-10-24", "other-device-nonce"),
    ),
  );
  equal(
    reused.cached,
    true,
    "fresh isolate and different nonce reuse server bank",
  );
  equal(
    reused.generatedAt,
    data.generatedAt,
    "shared bank preserves original generation time",
  );
  equal(
    JSON.stringify(reused.slots),
    JSON.stringify(data.slots),
    "shared bank preserves all18 candidate/reason pairs",
  );
  equal(fetchCalls, 2, "fresh isolate makes zero additional provider calls");
  equal(
    data.serverStored,
    true,
    "successful recommendation is durably server-stored",
  );
  const originalNowForReuse = Date.now;
  try {
    Date.now = () => originalNowForReuse() + 6 * 60_000;
    const beyondTtl = await responseBody(
      await isolatedHandler(await signedRequest()),
    );
    equal(
      beyondTtl.generatedAt,
      data.generatedAt,
      "server bank survives former5minute cacheTTL",
    );
    equal(fetchCalls, 2, "durable reuse after5minutes costs no provider call");
  } finally {
    Date.now = originalNowForReuse;
  }

  const beforePrepareReadCalls = readCalls,
    beforePrepareStorageCalls = storageCalls,
    beforePrepareFetchCalls = fetchCalls;
  const hmacPrepare = await signedRequest();
  const prepareHeaders = Object.fromEntries(hmacPrepare.headers);
  const unauthorizedPrepareCases = [
    new Request(endpoint, {
      method: "POST",
      headers: prepareHeaders,
      body: JSON.stringify({
        action: "prepare",
        date: "2026-10-24",
        nonce: "nonce-1",
      }),
    }),
    new Request(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer wrong-cron-secret" },
      body: JSON.stringify({ action: "prepare", date: "2026-10-24" }),
    }),
    new Request(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer offline-cron-secret" },
      body: JSON.stringify({ date: "2026-10-24", nonce: "nonce-1" }),
    }),
  ];
  for (const request of unauthorizedPrepareCases) {
    equal(
      (await handler(request)).status,
      401,
      "HMAC and cron prepare auth boundaries remain distinct",
    );
  }
  equal(
    readCalls,
    beforePrepareReadCalls,
    "unauthorized prepare never reads state",
  );
  equal(
    storageCalls,
    beforePrepareStorageCalls,
    "unauthorized prepare never reads or writes banks",
  );
  equal(
    fetchCalls,
    beforePrepareFetchCalls,
    "unauthorized prepare never calls provider",
  );

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
    await signedRequest("2026-10-25", "failure-retry"),
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
  equal(
    scenarioCalls,
    3,
    "failed run tried primary, fallback, and one correction",
  );
  const failedAttempts = failedBody.attempts as Array<{ ok: boolean }>;
  equal(
    failedAttempts.length,
    3,
    "failed HTTP result retains all three attempts",
  );
  assert(
    failedAttempts.every((attempt) => !attempt.ok),
    "failed corrective reply is not recorded as success",
  );
  const failedRow = bankRows.get(
    bankKey("namofood_state", "namofood", "2026-10-25"),
  );
  equal(
    failedRow?.response,
    null,
    "failed generation never saves a ready server bank",
  );
  equal(
    failedRow?.lease_token,
    null,
    "failed generation releases its own lease",
  );

  scenarioCalls = 0;
  globalThis.fetch = async (url) => {
    scenarioCalls++;
    return String(url).endsWith("/chat/completions")
      ? chatResponse()
      : messagesResponse();
  };
  const recovered = await handler(
    await signedRequest("2026-10-25", "failure-retry"),
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
    await signedRequest("2026-10-26", "coalesce-1"),
  );
  while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
  const secondCoalesced = handler(
    await signedRequest("2026-10-26", "coalesce-2"),
  );
  const pending = await secondCoalesced;
  equal(
    pending.status,
    202,
    "second device sees active server lease without duplicate model call",
  );
  const pendingBody = await responseBody(pending);
  equal(
    pendingBody.reason,
    "bank_pending",
    "active lease has explicit pending state",
  );
  equal(
    pendingBody.retryAfterSeconds,
    5,
    "pending response provides bounded polling delay",
  );
  equal(
    scenarioCalls,
    1,
    "active same-day lease prevents duplicate provider call",
  );
  release();
  const coalescedResponse = await firstCoalesced;
  equal(coalescedResponse.status, 200, "first coalesced request succeeds");
  equal(
    scenarioCalls,
    2,
    "simultaneous same input shares one primary/fallback sequence",
  );
  equal(
    (await responseBody(
      await handler(await signedRequest("2026-10-26", "coalesce-2")),
    )).cached,
    true,
    "pending device later reads the same durably saved bank",
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
    equal(filled.status, 200, `different nonce ${i} reuses stable bank`);
  }
  const refetchedOld = await handler(await signedRequest());
  equal(
    refetchedOld.status,
    200,
    "old entry can be refetched after cache pressure",
  );
  equal(
    (await responseBody(refetchedOld)).cached,
    true,
    "server storage does not evict a daily bank under other nonce pressure",
  );
  equal(scenarioCalls, 0, "33 different nonces never reroll saved server bank");

  const fullCatalogInput = buildRecommendationInput(
    { ...state, menus: {} },
    "2026-10-24",
    "daily-2026-10-24",
  );
  assert(
    validateStoredRecommendationBank(data, fullCatalogInput),
    "actual saved bank passes full-catalog validation",
  );
  const invalidBanks: Array<[string, (bank: Record<string, any>) => void]> = [
    ["nonAI source", (bank) => bank.source = "random"],
    ["model missing", (bank) => bank.model = ""],
    ["bad generation time", (bank) => bank.generatedAt = "not-a-date"],
    ["wrong date", (bank) => bank.date = "2026-10-23"],
    ["not server-stored", (bank) => bank.serverStored = false],
    ["aliases changed", (bank) => bank.aliases = { "제육볶음": "다른요리" }],
    ["missing original counts", (bank) => delete bank.expectedCounts],
    ["invalid original count", (bank) => bank.expectedCounts["1"] = 4],
    ["raw slot count missing", (bank) => bank.slots["1"].pop()],
    [
      "wrong ingredient group",
      (bank) => bank.slots["2"][0].name = bank.slots["1"][0].name,
    ],
    ["unregistered name", (bank) => bank.slots["1"][0].name = "없는국"],
    [
      "duplicate canonical dish",
      (bank) => bank.slots["4"][0] = { ...bank.slots["3"][0] },
    ],
    ["wrong validated count", (bank) => bank.validatedCount = 17],
    ["no successful AI attempt", (bank) => bank.attempts.at(-1).ok = false],
  ];
  for (const [label, mutate] of invalidBanks) {
    const invalid = structuredClone(data);
    mutate(invalid);
    equal(
      validateStoredRecommendationBank(invalid, fullCatalogInput),
      null,
      `reject stored ${label}`,
    );
  }
  const honestShortage = structuredClone(data) as Record<string, any>;
  honestShortage.slots["1"] = honestShortage.slots["1"].slice(0, 1);
  honestShortage.expectedCounts["1"] = 1;
  honestShortage.validatedCount = 16;
  assert(
    validateStoredRecommendationBank(honestShortage, fullCatalogInput),
    "original contextual shortage count remains exact and reusable after manual choices",
  );

  const initialRevision = await recommendationCatalogRevision(state);
  const menuChanged = structuredClone(state);
  menuChanged.menus = { "2026-10": { "24|breakfast|1": "직접 고른 국" } };
  menuChanged.headcounts = { "2026-10": { "24|breakfast": 999 } };
  menuChanged.recipeMeta = { metadataOnly: { reviewed: true } };
  equal(
    await recommendationCatalogRevision(menuChanged),
    initialRevision,
    "manual menus/headcounts/provenance do not reroll shared daily bank",
  );
  menuChanged.recipes = [...state.recipes!].reverse();
  equal(
    await recommendationCatalogRevision(menuChanged),
    initialRevision,
    "equivalent recipe row reordering keeps stable catalog revision",
  );
  const methodChanged = structuredClone(state);
  methodChanged.methods = {
    ...state.methods,
    소불고기: "1. 대량 전판에서 볶는다. 2. 배식한다.",
  };
  assert(
    await recommendationCatalogRevision(methodChanged) !== initialRevision,
    "recipe cooking-method edit invalidates catalog revision",
  );
  const askChanged = {
    ...state,
    recipeAsk: { 소불고기: { reason: "pending" } },
  };
  assert(
    await recommendationCatalogRevision(askChanged) !== initialRevision,
    "incomplete recipe queue invalidates catalog revision",
  );

  scenarioCalls = 0;
  globalThis.fetch = async (url) => {
    scenarioCalls++;
    return String(url).endsWith("/chat/completions")
      ? chatResponse()
      : messagesResponse();
  };
  Deno.env.set("NMF_ROOM", "other-room");
  const otherRoomHandler = await freshHandler("other-room bank isolation");
  Deno.env.set("NMF_ROOM", "namofood");
  const roomBank = await responseBody(
    await otherRoomHandler(await signedRequest()),
  );
  equal(roomBank.cached, false, "different room generates its own bank");
  equal(scenarioCalls, 1, "different room does not reuse another room bank");
  assert(
    bankRows.has(bankKey("namofood_state", "other-room", "2026-10-24")),
    "other room bank is separate row",
  );

  const initialRow = bankRows.get(
    bankKey("namofood_state", "namofood", "2026-10-24"),
  )!;
  initialRow.response = { ...data, source: "random" };
  const regeneratedInvalid = await responseBody(
    await handler(await signedRequest()),
  );
  equal(
    regeneratedInvalid.cached,
    false,
    "malformed stored bank regenerates instead of leaking row",
  );
  equal(
    regeneratedInvalid.source,
    "ai",
    "malformed row never returned as recommendation",
  );
  equal(
    scenarioCalls,
    2,
    "malformed bank costs exactly one validated generation",
  );
  encrypted = await encryptText(APP_PASSWORD, JSON.stringify(methodChanged));
  const regeneratedStale = await responseBody(
    await handler(await signedRequest()),
  );
  equal(
    regeneratedStale.cached,
    false,
    "changed recipe catalog regenerates stale bank",
  );
  equal(scenarioCalls, 3, "catalog revision causes one generation");
  equal(
    bankRows.get(bankKey("namofood_state", "namofood", "2026-10-24"))
      ?.catalog_revision,
    await recommendationCatalogRevision(methodChanged),
    "fresh catalog revision durably saved",
  );
  encrypted = await encryptText(APP_PASSWORD, JSON.stringify(state));

  failBankSave = true;
  const saveFailure = await handler(
    await signedRequest("2026-11-01", "save-failure"),
  );
  failBankSave = false;
  equal(
    saveFailure.status,
    503,
    "durable save failure does not return transient success",
  );
  const saveFailureBody = await responseBody(saveFailure);
  equal(
    saveFailureBody.reason,
    "bank_storage_unavailable",
    "save failure has explicit durable storage error",
  );
  assert(
    !("slots" in saveFailureBody) && !("serverStored" in saveFailureBody),
    "save failure never claims ready AI bank",
  );
  assert(
    !JSON.stringify(saveFailureBody).includes("private storage"),
    "save failure hides database exception",
  );
  equal(
    bankRows.get(bankKey("namofood_state", "namofood", "2026-11-01"))?.response,
    null,
    "failed save leaves no ready row",
  );
  equal(
    bankRows.get(bankKey("namofood_state", "namofood", "2026-11-01"))
      ?.lease_token,
    null,
    "failed save releases own lease",
  );

  const beforeFailedReadCalls = scenarioCalls;
  failBankRead = true;
  const storageReadFailure = await handler(
    await signedRequest("2026-11-02", "read-failure"),
  );
  failBankRead = false;
  equal(
    storageReadFailure.status,
    503,
    "storage read failure is unavailable, never private cache fallback",
  );
  equal(
    scenarioCalls,
    beforeFailedReadCalls,
    "storage read failure never calls provider",
  );

  const waiters: Array<() => void> = [];
  scenarioCalls = 0;
  globalThis.fetch = async () => {
    scenarioCalls++;
    await new Promise<void>((resolve) => waiters.push(resolve));
    return chatResponse();
  };
  const firstGlobal = handler(await signedRequest("2026-11-03", "device-A"));
  while (waiters.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const secondGlobal = isolatedHandler(
    await signedRequest("2026-11-04", "device-B"),
  );
  while (waiters.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const thirdGlobal = await handler(
    await signedRequest("2026-11-05", "device-C"),
  );
  equal(
    thirdGlobal.status,
    202,
    "different dates/isolate cannot exceed server-wide2generation pool",
  );
  equal(scenarioCalls, 2, "global pool blocks third charged provider call");
  const activeLeases = [...bankRows].filter(([key, row]) =>
    JSON.parse(key)[1] === "namofood" && row.lease_token
  );
  equal(
    activeLeases.length,
    2,
    "exactly2 active server leases across dates/isolate",
  );
  waiters.forEach((resolve) => resolve());
  equal(
    (await firstGlobal).status,
    200,
    "first global generation saves successfully",
  );
  equal(
    (await secondGlobal).status,
    200,
    "second global generation saves successfully",
  );
  equal(
    scenarioCalls,
    2,
    "global coalescing retains exactly2 actual provider calls",
  );

  const leaseKey = {
    stateTable: "namofood_state",
    room: "namofood",
    date: "2026-11-06",
  };
  const leaseTokenA = crypto.randomUUID(), leaseTokenB = crypto.randomUUID();
  assert(
    await storageModule.acquireRecommendationLease(
      leaseKey,
      initialRevision,
      leaseTokenA,
      null,
    ),
    "initial isolated lease acquired",
  );
  const staleLeaseRow = bankRows.get(
    bankKey(leaseKey.stateTable, leaseKey.room, leaseKey.date),
  )!;
  const staleVersion = staleLeaseRow.updated_at;
  staleLeaseRow.lease_expires_at = new Date(Date.now() - 1).toISOString();
  assert(
    await storageModule.acquireRecommendationLease(
      leaseKey,
      initialRevision,
      leaseTokenB,
      staleVersion,
    ),
    "expired lease recovered atomically",
  );
  await storageModule.releaseRecommendationLease(leaseKey, leaseTokenA);
  equal(
    bankRows.get(bankKey(leaseKey.stateTable, leaseKey.room, leaseKey.date))
      ?.lease_token,
    leaseTokenB,
    "old owner's release cannot clear replacement lease",
  );
  equal(
    await storageModule.saveRecommendationBank(
      leaseKey,
      initialRevision,
      leaseTokenA,
      { ...data, date: leaseKey.date },
    ),
    false,
    "old owner cannot save after lease replacement",
  );
  assert(
    await storageModule.saveRecommendationBank(
      leaseKey,
      initialRevision,
      leaseTokenB,
      { ...data, date: leaseKey.date },
    ),
    "current owner can save bank",
  );
  equal(
    await storageModule.acquireRecommendationLease(
      leaseKey,
      initialRevision,
      crypto.randomUUID(),
      staleVersion,
    ),
    false,
    "stale observed row version cannot overwrite newly saved bank",
  );
  const expiredSaveKey = { ...leaseKey, date: "2026-11-07" };
  const expiredToken = crypto.randomUUID();
  assert(
    await storageModule.acquireRecommendationLease(
      expiredSaveKey,
      initialRevision,
      expiredToken,
      null,
    ),
    "lease for expiry check acquired",
  );
  bankRows.get(
    bankKey(
      expiredSaveKey.stateTable,
      expiredSaveKey.room,
      expiredSaveKey.date,
    ),
  )!.lease_expires_at = new Date(Date.now() - 1).toISOString();
  equal(
    await storageModule.saveRecommendationBank(
      expiredSaveKey,
      initialRevision,
      expiredToken,
      { ...data, date: expiredSaveKey.date },
    ),
    false,
    "expired lease cannot save even if token unchanged",
  );
  await storageModule.releaseRecommendationLease(expiredSaveKey, expiredToken);
  assert(
    sqlTexts.some((text) =>
      text.includes("pg_advisory_xact_lock(hashtextextended")
    ),
    "actual storage claim contains short cross-isolate roomlock",
  );
  assert(
    sqlTexts.some((text) =>
      text.includes("interval '150 seconds'") &&
      text.includes("nmf_menu_recommend_banks.updated_at=?::timestamptz")
    ),
    "actual UPSERT lease query enforces150seconds and observed-version CAS",
  );
  assert(
    sqlTexts.some((text) =>
      text.includes(
        "catalog_revision=? and lease_token=?::uuid and lease_expires_at > now()",
      )
    ),
    "actual save query enforces catalog/token/unexpired lease",
  );
  const storageMigration = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/20261008171316_nmf_menu_recommend_server_store.sql",
      import.meta.url,
    ),
  );
  assert(
    /primary key \(state_table, room, target_date\)/.test(storageMigration),
    "migration scopes daily bank by state table/room/date",
  );
  assert(
    /enable row level security/i.test(storageMigration),
    "server bank table enables RLS",
  );
  assert(
    /revoke all on table public\.nmf_menu_recommend_banks from public, anon, authenticated/i
      .test(storageMigration),
    "browser/public roles have no direct server bank privileges",
  );
  assert(
    /grant select, insert, update on table public\.nmf_menu_recommend_banks to service_role/i
      .test(storageMigration),
    "only server service role receives required table grants",
  );
  assert(
    !/security definer|create (?:or replace )?function|grant .* to (?:anon|authenticated)/i
      .test(storageMigration),
    "migration creates no public/definer API or browser grant",
  );

  const originalNowForCron = Date.now;
  try {
    Date.now = () => Date.parse("2026-10-08T15:30:00.000Z"); // October9 KST, not host date.
    const cronRequest = (date: string) =>
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: "Bearer offline-cron-secret" },
        body: JSON.stringify({ action: "prepare", date }),
      });
    const beforeRangeReads = readCalls, beforeRangeStorage = storageCalls;
    equal(
      (await handler(cronRequest("2026-10-08"))).status,
      400,
      "cron cannot prepare past KST date",
    );
    equal(
      (await handler(cronRequest("2026-10-24"))).status,
      400,
      "cron cannot prepare beyond today+14",
    );
    equal(readCalls, beforeRangeReads, "cron range failures do not read state");
    equal(
      storageCalls,
      beforeRangeStorage,
      "cron range failures do not access banks",
    );
    globalThis.fetch = async () => chatResponse();
    const cronToday = await responseBody(
      await handler(cronRequest("2026-10-09")),
    );
    equal(
      cronToday.serverStored,
      true,
      "cron prepares today at KST day boundary",
    );
    const cronLast = await responseBody(
      await handler(cronRequest("2026-10-23")),
    );
    equal(
      cronLast.serverStored,
      true,
      "cron prepares inclusive today+14 boundary",
    );
  } finally {
    Date.now = originalNowForCron;
  }
  equal(
    writes,
    0,
    "all durable/cron/concurrency tests preserve main state/snapshots exactly",
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
    "MENU_RECOMMEND_OK / PROMPT_EXAMPLE_COUNTS_11_CASES / BOUNDED_SEMANTIC_CORRECTION / MODEL_DEADLINE_110S / ACTUAL_HANDLER / HMAC_DATE_NONCE / FALLBACK_PROTOCOL / EXISTING_RECIPE_ONLY / MAIN_STATE_READ_ONLY / SERVER_BANK_FRESH_ISOLATE_NONCE_TTL_REUSE / STRICT_STORED_VALIDATION / ORIGINAL_EXPECTED_COUNTS / CATALOG_REVISION / ROOM_ISOLATION / FAILURE_NO_READY_ROW / DURABLE_SAVE_FAILURE / ATOMIC_LEASE_CAS_EXPIRY / GLOBAL2_GENERATIONS / CRON_AUTH_KST14DAYS",
  );
} finally {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of originalEnv) {
    value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
  delete globals.__menuRecommendDb;
  delete globals.__menuRecommendCapture;
  delete globals.__menuRecommendSql;
}

// 나모푸드 식단 추천 — 기존 레시피명만 고르는 읽기 전용 Edge Function 순수 로직
import { assertMealMenuAllowed } from "../_shared/menu-eligibility.ts";
import { canonicalDish } from "../_shared/institutional-menu.ts";
import {
  MANUAL_FAMILIAR_DISHES,
  MENU_MANUAL_VERSION,
} from "../_shared/menu-manual.ts";
import {
  type ModelAttemptDiagnostic,
  ModelFallbackError,
  type ModelFallbackResult,
  type OpenCodeProtocol,
  runModelFallback,
} from "../nmf-menu-plan/lib.ts";

export type MenuRecommendState = {
  recipes?: Array<Record<string, unknown>>;
  methods?: Record<string, unknown>;
  recipeAsk?: Record<string, unknown>;
  recipeMeta?: Record<string, unknown>;
  menus?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

export type SlotId = "1" | "2" | "7" | "8" | "3" | "4";
export type CandidateSlotGroup = "국" | "고기" | "생선" | "기타 주찬" | "야채";
export type RecipeCandidate = {
  name: string;
  slotGroup: CandidateSlotGroup;
  primary: string;
  group: string;
  method: string;
  ingredients: string[];
};
export type RecommendationItem = { name: string; reason: string };
export type RecommendationSlots = Record<SlotId, RecommendationItem[]>;
export type RecommendationInput = {
  date: string;
  nonce: string;
  pools: Record<SlotId, RecipeCandidate[]>;
  promptPools: Record<SlotId, RecipeCandidate[]>;
  expectedCounts: Record<SlotId, number>;
  warnings: string[];
  excludedCount: number;
  fingerprint: string;
};
export type RecommendationResult = {
  source: "ai";
  model: string;
  fallbackUsed: boolean;
  attempts: ModelAttemptDiagnostic[];
  slots: RecommendationSlots;
  warnings: string[];
  excludedCount: number;
  validatedCount: number;
};
export type RecommendationModelOptions = {
  apiKey: string;
  baseUrl: string;
  primaryModel: string;
  fallbackModel: string;
  timeoutMs: number;
  maxTokens: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  sessionId?: string;
};

const SLOT_IDS = ["1", "2", "7", "8", "3", "4"] as const;
const SLOT_LABELS: Record<SlotId, string> = {
  "1": "국",
  "2": "메인1(고기)",
  "7": "메인2(생선·해산물)",
  "8": "메인3(기타 주찬)",
  "3": "부찬1(야채)",
  "4": "부찬2(야채)",
};
const SLOT_GROUPS: Record<SlotId, CandidateSlotGroup> = {
  "1": "국",
  "2": "고기",
  "7": "생선",
  "8": "기타 주찬",
  "3": "야채",
  "4": "야채",
};
const PROMPT_POOL_LIMIT = 36;
const MODEL_TOTAL_TIMEOUT_MS = 110_000;

const RECIPE_METHODS = [
  "튀김",
  "무침",
  "부침",
  "볶음",
  "조림",
  "찜",
  "구이",
  "국·찌개",
  "밥·면",
  "김치",
  "샐러드",
  "후식",
  "기타/미분류",
];
const RECIPE_MEAT_METHODS = [
  "볶음",
  "구이",
  "찜",
  "조림",
  "튀김",
  "부침",
  "삶음",
];
const RECIPE_INGREDIENTS: Array<[string, RegExp]> = [
  [
    "소고기",
    /소고기|쇠고기|우육|소불고기|우불고기|육개장|설렁탕|차돌|우둔|홍두깨|양지|소갈비/,
  ],
  [
    "돼지고기",
    /돼지|돈육|돈까스|돈가스|돈카츠|제육|탕수육|보쌈|수육|오삼|삼겹|목살|차슈|족발|돈민찌|꿔바로우/,
  ],
  ["닭고기", /닭|치킨|너겟|닭가슴|닭다리/],
  ["오리고기", /오리/],
  [
    "생선",
    /생선|고등어|갈치|삼치|조기|가자미|명태|동태|황태|북어|대구|코다리|꽁치|임연수|이면수|연어|참치|멸치|쥐포|도미|열기|메기|아귀|장어/,
  ],
  ["오징어", /오징어|진미채|오삼/],
  ["새우", /새우/],
  ["해산물", /낙지|주꾸미|쭈꾸미|문어|바지락|조개|홍합|해물|굴(?!소스)/],
  ["달걀", /계란|달걀|메추리알/],
  ["두부", /두부|유부|비지/],
  ["어묵", /어묵|오뎅/],
  ["햄·소시지", /햄|소시지|소세지|스팸|베이컨/],
  ["콩나물", /콩나물/],
  ["숙주", /숙주/],
  ["당근", /당근/],
  ["시금치", /시금치/],
  ["미나리", /미나리/],
  ["참나물", /참나물/],
  ["고사리", /고사리/],
  ["취나물", /취나물/],
  ["쑥갓", /쑥갓/],
  ["청경채", /청경채/],
  ["근대", /근대/],
  ["얼갈이", /얼갈이/],
  ["열무", /열무/],
  ["부추", /부추/],
  ["오이", /오이/],
  [
    "무",
    /무생채|무채|무나물|무조림|무국|무우|무절임|깍두기|섞박지|^무$|알타리|총각/,
  ],
  ["감자", /감자/],
  ["고구마", /고구마/],
  ["연근", /연근/],
  ["우엉", /우엉/],
  ["가지", /가지/],
  ["애호박", /애호박/],
  ["호박", /단호박|늙은호박|주키니|쥬키니/],
  ["양배추", /양배추|코울슬로/],
  ["배추", /(?:^|[^양])배추|백김치/],
  ["브로콜리", /브로콜리/],
  ["버섯", /버섯|표고|팽이|느타리|새송이|목이/],
  ["깻잎", /깻잎/],
  ["도라지", /도라지/],
  ["양파", /양파/],
  ["마늘", /마늘|갈릭/],
  ["고추", /고추(?!장|가루)|꽈리|피망|파프리카/],
  ["시래기", /시래기/],
  ["토란대", /토란/],
  ["죽순", /죽순/],
  ["비름", /비름/],
  ["치커리", /치커리/],
  ["상추", /상추/],
  ["미역", /미역/],
  ["김", /구운김|구이김|김구이|김자반|도시락김|포장김|^김$/],
  ["다시마", /다시마/],
  ["콩", /콩자반|검은콩|강낭콩|완두콩|대두|청국장/],
  ["옥수수", /옥수수|콘샐러드|콘치즈|콘버터/],
  ["묵", /도토리묵|청포묵|메밀묵/],
  ["떡", /떡(?!갈비)/],
  [
    "면",
    /국수|우동|라면|쫄면|냉면|당면|파스타|스파게티|짜장면|짬뽕면|소면|칼국수/,
  ],
  ["곡류", /쌀|밥|라이스|보리|흑미|현미|잡곡/],
  ["나물", /나물/],
];
const RECIPE_MEAT_INGREDIENTS = new Set([
  "소고기",
  "돼지고기",
  "닭고기",
  "오리고기",
  "햄·소시지",
]);
const RECIPE_FISH_INGREDIENTS = new Set([
  "생선",
  "오징어",
  "새우",
  "해산물",
  "어묵",
]);
const RECIPE_OTHER_INGREDIENTS = new Set([
  "달걀",
  "두부",
  "묵",
  "떡",
  "면",
  "곡류",
  "만두",
  "유제품",
  "기타/미분류",
]);
const RECIPE_NAMUL = new Set([
  "콩나물",
  "숙주",
  "시금치",
  "미나리",
  "참나물",
  "고사리",
  "취나물",
  "쑥갓",
  "청경채",
  "근대",
  "얼갈이",
  "열무",
  "시래기",
  "토란대",
  "비름",
]);
const KIMCHI = new Set([
  "배추김치",
  "깍두기",
  "총각김치",
  "백김치",
  "열무김치",
]);

export class RecommendationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecommendationValidationError";
  }
}

export function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("date는 YYYY-MM-DD 형식이어야 합니다");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("존재하지 않는 날짜입니다");
  }
}

function compNorm(_name: string, comp: unknown): string {
  const value = String(comp || "").trim();
  if (["밥", "국", "주찬", "부찬", "김치", "후식", "기타"].includes(value)) {
    return value;
  }
  return "기타";
}

function isDefaultRice(name: string): boolean {
  return /^(?:쌀밥|백미밥|밥)$/.test(String(name || "").replace(/\s/g, ""));
}

function recipeIngredientGroup(label: string): string {
  return RECIPE_MEAT_INGREDIENTS.has(label)
    ? "고기"
    : RECIPE_FISH_INGREDIENTS.has(label)
    ? "생선·해산물"
    : RECIPE_OTHER_INGREDIENTS.has(label)
    ? "기타"
    : "야채";
}

function recipeIngredientWeights(
  rows: Array<Record<string, unknown>>,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const row of rows) {
    const item = String(row.item || "").replace(/\s/g, "");
    if (
      /소스|양념|다진마늘|다진생강|소금|간장|고추장|된장|설탕|식초|고춧가루|참기름|후추|육수|다시다|전분|밀가루|튀김가루|부침가루|빵가루|식용유/
        .test(item) ||
      /^(물|정제수)$/.test(item)
    ) continue;
    const labels = RECIPE_INGREDIENTS.filter(([, re]) => re.test(item)).map((
      [label],
    ) => label);
    if (/만두/.test(item)) labels.push("만두");
    if (/치즈|우유|유제품/.test(item)) labels.push("유제품");
    const qty = Number(row.qty) || 0;
    if (qty <= 0) continue;
    const weight = qty *
      (row.unit === "kg" ? 1000 : row.unit === "ea" ? 50 : 1);
    for (const label of labels) {
      if (label !== "나물") {
        weights.set(label, (weights.get(label) || 0) + weight);
      }
    }
  }
  return weights;
}

function recipeMainIngredients(
  name: string,
  rows: Array<Record<string, unknown>>,
): string[] {
  const normalized = String(name || "").replace(/\s/g, "");
  let groups = RECIPE_INGREDIENTS.filter(([, re]) => re.test(normalized)).map((
    [label],
  ) => label);
  if (!groups.length) {
    const weights = new Map<string, number>();
    for (const row of rows) {
      const item = String(row.item || "").replace(/\s/g, "");
      if (
        /소스|양념|마늘|생강|소금|간장|고추장|된장|설탕|식초|고춧가루|참기름|후추|육수|전분|밀가루|튀김가루|빵가루|식용유/
          .test(item) ||
        /^(물|정제수)$/.test(item)
      ) continue;
      const labels = RECIPE_INGREDIENTS.filter(([, re]) => re.test(item)).map((
        [label],
      ) => label);
      const weight = Math.max(1, Number(row.qty) || 1);
      for (const label of labels) {
        weights.set(label, (weights.get(label) || 0) + weight);
      }
    }
    const ranked = [...weights].filter(([label]) => label !== "나물").sort((
      a,
      b,
    ) => b[1] - a[1]);
    groups = ranked.filter(([, weight]) =>
      weight >= (ranked[0]?.[1] || 0) * 0.5
    )
      .slice(0, 2).map(([label]) => label);
  }
  if (
    groups.some((label) => RECIPE_NAMUL.has(label)) || /나물/.test(normalized)
  ) {
    groups.push("나물");
  }
  return [...new Set(groups.length ? groups : ["기타/미분류"])];
}

function methodText(
  name: string,
  rows: Array<Record<string, unknown>>,
): string {
  const rowMethods = rows.map((row) => String(row.method || "").trim()).filter(
    Boolean,
  );
  return rowMethods.join("\n") || "";
}

function recipeMeatProcedureMethod(
  name: string,
  rows: Array<Record<string, unknown>>,
): string {
  const ranked = [...recipeIngredientWeights(rows)].sort((a, b) => b[1] - a[1]);
  const primary =
    ranked.find(([label, weight]) =>
      (RECIPE_MEAT_INGREDIENTS.has(label) ||
        RECIPE_FISH_INGREDIENTS.has(label)) &&
      (weight >= 40 || weight >= (ranked[0]?.[1] || 0) * 0.5)
    )?.[0] || ranked[0]?.[0] || recipeMainIngredients(name, rows)[0];
  if (!RECIPE_MEAT_INGREDIENTS.has(primary)) return "";
  const text = methodText(name, rows);
  if (RECIPE_MEAT_METHODS.includes(text)) return text;
  const objects: Record<string, RegExp> = {
    "소고기": /소고기|쇠고기|차돌|갈비|고기|패티|고기말이/,
    "돼지고기": /돼지|돈육|삼겹|목살|등심|갈비|고기|족발|패티|완자/,
    "닭고기": /닭|치킨|고기|다리살|가슴살|패티|꼬치/,
    "오리고기": /오리|고기|꼬치/,
    "햄·소시지": /햄|소시지|소세지|베이컨|비엔나|스팸|꼬치/,
  };
  const actions: Array<[string, RegExp]> = [
    ["튀김", /튀긴다|튀긴\s*(?:후|뒤)|튀겨|튀기(?:는|고|도록|면)/],
    ["부침", /부친다|부쳐|부치(?:는|고|도록)/],
    ["조림", /졸인다|졸여|졸이(?:는|고|도록)|조린다|조려|조리(?:는|고|도록)/],
    ["찜", /찐다|쪄|찌(?:는|고|도록)|찜기에.{0,60}익힌다/],
    ["삶음", /삶는다|삶아|삶(?:는|고|도록)/],
    [
      "구이",
      /굽는다|굽(?:는|고|도록)|구워|구운\s*(?:후|뒤)|그릴에.{0,60}익힌다/,
    ],
    ["볶음", /볶는다|볶아|볶(?:는|고|다가|도록)/],
  ];
  const found = new Set<string>();
  let mainContext = false;
  for (
    const step of text.split(
      /\r?\n|(?:^|\s)\d+[.)]\s*|(?<=[다요])[.!?]\s*|(?:준비|계량|손질|해동|보관|세척|소독)(?:하고|한\s*(?:후|뒤))|썰고|재우고/,
    )
  ) {
    if (!step.trim()) continue;
    if (
      /(?:소스|양념장|육수|양파|마늘|생강|감자|고구마|채소)만(?:을)?(?!큼|한)/
        .test(step)
    ) {
      mainContext = false;
      continue;
    }
    const object = objects[primary];
    const main = Boolean(object && object.test(step));
    const other = /소스|양념장|육수|양파|마늘|생강|감자|고구마|채소|물만/.test(
      step,
    );
    if (main) mainContext = true;
    else if (other) mainContext = false;
    if (!main && !mainContext) continue;
    const methods = actions.filter(([, re]) => re.test(step)).map(([method]) =>
      method
    );
    if (methods.length === 1) found.add(methods[0]);
    else if (methods.length > 1) return "";
  }
  return found.size === 1 ? [...found][0] : "";
}

function recipeCookingMethod(
  name: string,
  rows: Array<Record<string, unknown>>,
): string {
  const normalized = String(name || "").replace(/\s/g, "");
  const course = compNorm(name, rows[0]?.comp);
  if (/밥|라이스|리조또|죽$/.test(normalized)) return "밥·면";
  if (/닭볶음탕|닭도리탕/.test(normalized)) return "찜";
  if (/볶음|잡채|두루치기/.test(normalized)) return "볶음";
  if (/무침|생채|겉절이/.test(normalized)) return "무침";
  if (/부침|지짐|동그랑땡|(?:전|전병)$/.test(normalized)) return "부침";
  if (/조림|자반|장조림|차슈/.test(normalized)) return "조림";
  if (/찜/.test(normalized)) return "찜";
  if (/수육|보쌈/.test(normalized)) return "삶음";
  if (/구이|스테이크|떡갈비/.test(normalized)) return "구이";
  if (
    /튀김|까스|가스|카츠|탕수|강정|너겟|깐풍기|유린기|꿔바로우|(?:가|카)라아게/
      .test(normalized)
  ) return "튀김";
  if (
    course === "김치" || KIMCHI.has(name) ||
    /김치$|깍두기|섞박지|소박이/.test(normalized)
  ) return "김치";
  if (/샐러드|코울슬로/.test(normalized)) return "샐러드";
  if (/나물$/.test(normalized)) return "무침";
  if (
    /국수|우동|라면|쫄면|냉면|파스타|스파게티|짜장면|짬뽕|소면|수제비/.test(
      normalized,
    )
  ) return "밥·면";
  if (
    /찌개|전골|스프|수프|육개장|청국장|장국|육수$|(?:국|탕)$/.test(normalized)
  ) return "국·찌개";
  if (course === "국") return "국·찌개";
  if (course === "후식") return "후식";
  if (
    /불고기|제육|닭갈비|주물럭|위샹로우스|향라육슬|경장육슬/.test(normalized)
  ) return "볶음";
  const procedure = recipeMeatProcedureMethod(name, rows);
  if (procedure) return procedure;
  if (/훈제/.test(normalized)) return "구이";
  if (/치킨/.test(normalized)) return "튀김";
  return "기타/미분류";
}

export function recipeFoodProfile(
  name: string,
  rows: Array<Record<string, unknown>> = [],
): Omit<RecipeCandidate, "name" | "slotGroup"> & {
  slotGroup: CandidateSlotGroup | "선택 제외";
} {
  const normalized = String(name || "").replace(/\s/g, "");
  const method = recipeCookingMethod(name, rows);
  const course = compNorm(name, rows[0]?.comp);
  const ingredients = recipeMainIngredients(name, rows);
  const weights = recipeIngredientWeights(rows);
  const ranked = [...weights].sort((a, b) => b[1] - a[1]);
  const protein = ranked.filter(([label]) =>
    RECIPE_MEAT_INGREDIENTS.has(label) || RECIPE_FISH_INGREDIENTS.has(label)
  );
  const substantialProtein = protein.find(([, weight]) =>
    weight >= 40 || (ranked[0] && weight >= ranked[0][1] * 0.5)
  );
  const named = ingredients.find((label) =>
    label !== "나물" && label !== "기타/미분류"
  );
  let primary = substantialProtein?.[0] || ranked[0]?.[0] || named ||
    "기타/미분류";
  if (!ranked.length && /만두/.test(normalized)) primary = "만두";
  if (!ranked.length && /치즈/.test(normalized) && primary === "기타/미분류") {
    primary = "유제품";
  }
  if (course === "김치" || method === "김치") {
    primary = ranked.find(([label]) => recipeIngredientGroup(label) === "야채")
      ?.[0] || named || "배추";
  }
  const group = recipeIngredientGroup(primary);
  const soup = method === "국·찌개";
  const prohibited = (() => {
    try {
      assertMealMenuAllowed(name);
      return false;
    } catch {
      return true;
    }
  })();
  const excluded = prohibited || course === "후식" || course === "밥" ||
    method === "후식" || isDefaultRice(name) ||
    /음료|주스|쥬스|콜라|사이다|커피|요구르트|푸딩|젤리|양념장|(?:소스|육수)$/
      .test(normalized);
  const wholeMeal = method === "밥·면" &&
    /밥|라이스|죽$|(?:국수|우동|라면|냉면|짜장면|칼국수|소면)$/.test(
      normalized,
    );
  const sideLike = ["주찬", "부찬", "김치", "기타"].includes(course) ||
    [
      "튀김",
      "부침",
      "볶음",
      "조림",
      "찜",
      "삶음",
      "구이",
      "무침",
      "김치",
      "샐러드",
    ].includes(method);
  const slotGroup: CandidateSlotGroup | "선택 제외" = excluded || wholeMeal
    ? "선택 제외"
    : soup
    ? "국"
    : !sideLike
    ? "선택 제외"
    : group === "고기"
    ? "고기"
    : group === "생선·해산물"
    ? "생선"
    : group === "야채"
    ? "야채"
    : "기타 주찬";
  return {
    method,
    ingredients: [...new Set(ingredients.concat(primary))],
    primary,
    group,
    slotGroup,
  };
}

function recipeMap(
  state: MenuRecommendState,
): Map<string, Array<Record<string, unknown>>> {
  const map = new Map<string, Array<Record<string, unknown>>>();
  for (const row of Array.isArray(state.recipes) ? state.recipes : []) {
    if (!row || typeof row !== "object") continue;
    const name = String(row.menu || "").trim();
    if (!name) continue;
    const list = map.get(name) || [];
    const method = String(state.methods?.[name] || row.method || "").trim();
    list.push({ ...row, method });
    map.set(name, list);
  }
  return map;
}

function dateAdd(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthDay(date: string): { ym: string; day: string } {
  return { ym: date.slice(0, 7), day: String(Number(date.slice(8, 10))) };
}

function surroundingCanonicalDishes(
  state: MenuRecommendState,
  date: string,
): Set<string> {
  const blocked = new Set<string>();
  for (let offset = -7; offset <= 7; offset++) {
    const current = dateAdd(date, offset);
    const { ym, day } = monthDay(current);
    for (const [key, value] of Object.entries(state.menus?.[ym] || {})) {
      const [d, _meal, slot] = key.split("|");
      if (
        String(Number(d)) !== day || !/^\d+$/.test(slot) || Number(slot) <= 0
      ) {
        continue;
      }
      const dish = String(value || "").trim();
      if (dish) blocked.add(canonicalDish(dish));
    }
  }
  return blocked;
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  const out = items.slice();
  let state = parseInt(hashText(seed), 16) || 1;
  const next = () => {
    state = Math.imul(state ^ (state >>> 15), 2246822519);
    state = Math.imul(state ^ (state >>> 13), 3266489917);
    return (state ^= state >>> 16) >>> 0;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function stateFingerprint(state: MenuRecommendState, date: string): string {
  const recipes = [...recipeMap(state)].map(([name, rows]) => [
    name,
    rows.map((row) => [row.comp, row.item, row.qty, row.unit, row.method]),
  ]);
  const unresolved = Object.keys(state.recipeAsk || {}).sort();
  const neighbors: Array<[string, string]> = [];
  for (let offset = -7; offset <= 7; offset++) {
    const current = dateAdd(date, offset);
    const { ym, day } = monthDay(current);
    for (const [key, value] of Object.entries(state.menus?.[ym] || {})) {
      if (key.startsWith(`${day}|`)) {
        neighbors.push([`${ym}|${key}`, String(value || "")]);
      }
    }
  }
  return hashText(JSON.stringify({ recipes, unresolved, neighbors }));
}

export function buildRecommendationInput(
  state: MenuRecommendState,
  date: string,
  nonce = "",
): RecommendationInput {
  assertDate(date);
  const byName = recipeMap(state);
  const unresolved = state.recipeAsk || {};
  const nearby = surroundingCanonicalDishes(state, date);
  const allPools: Record<SlotId, RecipeCandidate[]> = {
    "1": [],
    "2": [],
    "7": [],
    "8": [],
    "3": [],
    "4": [],
  };
  let excludedCount = 0;
  const seenBySlot = new Map<SlotId, Set<string>>();
  for (const slot of SLOT_IDS) seenBySlot.set(slot, new Set());
  for (const [name, rows] of byName) {
    if (Object.hasOwn(unresolved, name)) {
      excludedCount++;
      continue;
    }
    if (
      !rows.some((row) =>
        String(row.item || "").trim() && Number(row.qty) > 0 &&
        String(row.method || "").trim()
      )
    ) {
      excludedCount++;
      continue;
    }
    let profile: ReturnType<typeof recipeFoodProfile>;
    try {
      assertMealMenuAllowed(name);
      profile = recipeFoodProfile(name, rows);
    } catch {
      excludedCount++;
      continue;
    }
    if (
      !["국", "고기", "생선", "기타 주찬", "야채"].includes(profile.slotGroup)
    ) {
      excludedCount++;
      continue;
    }
    const slotGroup = profile.slotGroup as CandidateSlotGroup;
    const canonical = canonicalDish(name);
    if (nearby.has(canonical)) {
      excludedCount++;
      continue;
    }
    const candidate: RecipeCandidate = {
      name,
      ...profile,
      slotGroup,
    };
    const targetSlots = SLOT_IDS.filter((slot) =>
      SLOT_GROUPS[slot] === profile.slotGroup
    );
    for (const slot of targetSlots) {
      const seen = seenBySlot.get(slot)!;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      allPools[slot].push(candidate);
    }
  }
  for (const slot of SLOT_IDS) {
    allPools[slot].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }
  const vegetableTotal = new Map<string, RecipeCandidate>();
  for (const candidate of allPools["3"]) {
    vegetableTotal.set(canonicalDish(candidate.name), candidate);
  }
  const vegetableCount = vegetableTotal.size;
  const side3 = vegetableCount >= 6
    ? 3
    : Math.min(3, Math.ceil(vegetableCount / 2));
  const side4 = vegetableCount >= 6
    ? 3
    : Math.min(3, Math.max(0, vegetableCount - side3));
  const expectedCounts: Record<SlotId, number> = {
    "1": Math.min(3, allPools["1"].length),
    "2": Math.min(3, allPools["2"].length),
    "7": Math.min(3, allPools["7"].length),
    "8": Math.min(3, allPools["8"].length),
    "3": side3,
    "4": side4,
  };
  const warnings: string[] = [];
  for (const slot of SLOT_IDS) {
    const target = slot === "4" ? vegetableCount : allPools[slot].length;
    if (expectedCounts[slot] < 3) {
      warnings.push(
        `${SLOT_LABELS[slot]} 후보가 ${target}개라 ${
          expectedCounts[slot]
        }개만 추천합니다.`,
      );
    }
  }
  const fingerprint = stateFingerprint(state, date);
  const promptPools = Object.fromEntries(
    SLOT_IDS.map((slot) => [
      slot,
      seededShuffle(allPools[slot], `${date}|${nonce}|${fingerprint}|${slot}`)
        .slice(0, PROMPT_POOL_LIMIT)
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    ]),
  ) as Record<SlotId, RecipeCandidate[]>;
  return {
    date,
    nonce,
    pools: allPools,
    promptPools,
    expectedCounts,
    warnings,
    excludedCount,
    fingerprint,
  };
}

function jsonLineCandidate(candidate: RecipeCandidate, index: number): string {
  return `[${
    index + 1
  }] ${candidate.name}(${candidate.primary}/${candidate.method})`;
}

export function buildRecommendationPrompt(
  input: RecommendationInput,
  previousFailure?: string,
): string {
  const sections = SLOT_IDS.map((slot) =>
    `- ${slot} ${SLOT_LABELS[slot]}: 정확히 ${input.expectedCounts[slot]}개` +
    `\n  후보: ${
      input.promptPools[slot].map(jsonLineCandidate).join(", ") || "(없음)"
    }`
  ).join("\n");
  const familiar = MANUAL_FAMILIAR_DISHES.slice(0, 60).join(", ");
  const exampleSlots = {} as Record<
    SlotId,
    Array<{ id: number; reason: string }>
  >;
  const exampleUsed = new Set<string>();
  for (const slot of SLOT_IDS) {
    const entries: Array<{ id: number; reason: string }> = [];
    for (const [index, candidate] of input.promptPools[slot].entries()) {
      if (entries.length === input.expectedCounts[slot]) break;
      const canonical = canonicalDish(candidate.name);
      if (exampleUsed.has(canonical)) continue;
      exampleUsed.add(canonical);
      entries.push({ id: index + 1, reason: "짧은 이유 예시" });
    }
    if (entries.length !== input.expectedCounts[slot]) {
      throw new RecommendationValidationError(
        `${
          SLOT_LABELS[slot]
        } 중복 없는 응답 형식 예시를 구성할 후보가 부족합니다`,
      );
    }
    exampleSlots[slot] = entries;
  }
  const vegetableCount = input.expectedCounts["3"] + input.expectedCounts["4"];
  return [
    "나모푸드 공장 급식 식단 추천기입니다.",
    "반드시 후보 번호 id만 골라 JSON 하나로 답하세요. 음식명은 쓰지 마세요.",
    "새 음식명, 별칭, 띄어쓰기 변경, 후보 밖 번호는 금지입니다.",
    `식단 매뉴얼 버전: ${MENU_MANUAL_VERSION}. 한 끼 10,000원 공장노동자/함바 급식 기준입니다.`,
    "100~500인 대량 배식 공정(회전솥·대형솥·튀김기·전판)에서 현실적으로 나갈 수 있고, 맛·포만감·주찬 체감 품질이 강한 구성을 우선하세요.",
    "영양 균형은 최우선이 아니지만 식품 안전과 대량 조리 현실성은 반드시 지키세요. 가정식·브런치·소량 고명뿐인 메뉴를 주찬처럼 고르지 마세요.",
    "실제 한 끼의 국은 한 칸이지만, 이번 응답은 식단 자체가 아니라 각 자리에서 사람이 고를 대안 후보 목록입니다.",
    `추천 목록 목표는 국 ${input.expectedCounts["1"]}개 후보 + 고기 메인 ${
      input.expectedCounts["2"]
    }개 후보 + 생선/해산물 메인 ${
      input.expectedCounts["7"]
    }개 후보 + 기타 주찬 ${
      input.expectedCounts["8"]
    }개 후보 + 야채 부찬 ${vegetableCount}개 후보입니다.`,
    "같은 조리법·양념만 몰리지 않게 볶음/구이/튀김/부침/조림/찜/무침을 섞고, 튀김만 반복하는 선택은 피하세요.",
    `익숙한 운영 예시/방향: ${familiar}`,
    `슬롯 3과 4의 야채 부찬은 서로 겹치지 않게 총 ${vegetableCount}개를 구성하세요. 각 슬롯 수는 아래 지정된 수를 정확히 지키세요.`,
    "전체 슬롯 사이에서도 같은 실제 음식/동일 canonical 음식은 중복 금지입니다.",
    "이 추천은 저장하지 않고 사람이 고르기 위한 후보입니다.",
    "reason은 20자 안팎으로 짧게 쓰고, 생략해도 됩니다.",
    previousFailure
      ? `이전 응답 검증 실패: ${previousFailure}. 같은 문제를 반복하지 마세요.`
      : "",
    `추천 날짜: ${input.date}`,
    sections,
    "응답 형식 예시(형식만 참고하며, 예시 번호를 그대로 추천하지 말고 후보의 품질과 조리 다양성을 보고 직접 고르세요):",
    JSON.stringify({ slots: exampleSlots }),
  ].filter(Boolean).join("\n\n");
}

function extractJson(text: string): unknown {
  const clean = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const first = clean.indexOf("{");
  if (first < 0) {
    throw new Error("LLM 응답에 JSON 객체가 없습니다");
  }
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = first; i < clean.length; i++) {
    const ch = clean[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
      if (depth < 0) break;
    }
  }
  if (end < 0) throw new Error("LLM JSON 객체가 닫히지 않았습니다");
  const trailing = clean.slice(end).trim();
  if (trailing) {
    throw new Error("LLM 응답 JSON 뒤에 추가 텍스트가 있습니다");
  }
  return JSON.parse(clean.slice(first, end));
}

export function validateRecommendationAnswer(
  text: string,
  input: RecommendationInput,
): RecommendationSlots {
  const parsed = extractJson(text);
  const root = parsed && typeof parsed === "object"
    ? parsed as Record<string, unknown>
    : {};
  const slots = root.slots && typeof root.slots === "object"
    ? root.slots as Record<string, unknown>
    : {};
  const result: RecommendationSlots = {
    "1": [],
    "2": [],
    "7": [],
    "8": [],
    "3": [],
    "4": [],
  };
  const used = new Set<string>();
  for (const slot of SLOT_IDS) {
    const expected = input.expectedCounts[slot];
    const list = Array.isArray(slots[slot]) ? slots[slot] : [];
    if (list.length !== expected) {
      throw new RecommendationValidationError(
        `${
          SLOT_LABELS[slot]
        } 추천 수가 ${list.length}개입니다. 정확히 ${expected}개여야 합니다`,
      );
    }
    const allowedByName = new Map(
      input.promptPools[slot].map((item) => [item.name, item]),
    );
    for (const raw of list) {
      const item = typeof raw === "string"
        ? { name: raw, reason: "" }
        : raw && typeof raw === "object"
        ? raw as Record<string, unknown>
        : {};
      const idValue = item.id;
      const hasId = typeof idValue === "number" || typeof idValue === "string";
      const id = typeof idValue === "number"
        ? idValue
        : typeof idValue === "string" && /^\d+$/.test(idValue)
        ? Number(idValue)
        : NaN;
      const byId = Number.isInteger(id) && id >= 1
        ? input.promptPools[slot][id - 1]
        : undefined;
      const name = String(item.name || "").trim();
      const byName = name ? allowedByName.get(name) : undefined;
      if (hasId && name && byId && byId.name !== name) {
        throw new RecommendationValidationError(
          `${SLOT_LABELS[slot]} id와 name이 서로 다른 후보를 가리킵니다`,
        );
      }
      if (hasId && !byId) {
        throw new RecommendationValidationError(
          `${SLOT_LABELS[slot]} 후보 밖 번호입니다: ${String(idValue)}`,
        );
      }
      const candidate = byId || byName;
      if (!candidate) {
        throw new RecommendationValidationError(
          `${SLOT_LABELS[slot]} 후보 밖 음식입니다: ${name || "(빈 값)"}`,
        );
      }
      const canonical = canonicalDish(candidate.name);
      if (used.has(canonical)) {
        throw new RecommendationValidationError(
          `중복 음식입니다: ${candidate.name}`,
        );
      }
      used.add(canonical);
      result[slot].push({
        name: candidate.name,
        reason: String(
          item.reason ||
            `AI가 고른 ${SLOT_LABELS[slot]} 등록 레시피 후보`,
        ).trim().slice(0, 120),
      });
    }
  }
  return result;
}

function textFromOpenCodeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const value = part as { type?: unknown; text?: unknown };
    if (typeof value.text !== "string") return "";
    if (value.type !== undefined && value.type !== "text") return "";
    return value.text;
  }).join("");
}

export function parseRecommendationOpenCodeResponse(
  protocol: OpenCodeProtocol,
  payload: unknown,
): string {
  const value = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  let finish: unknown;
  let content: unknown;
  if (protocol === "messages") {
    finish = value.stop_reason;
    if (
      finish !== undefined && finish !== null && finish !== "end_turn" &&
      finish !== "stop_sequence"
    ) {
      throw new Error(`LLM finish_reason=${String(finish)}`);
    }
    content = value.content;
  } else {
    const choices = Array.isArray(value.choices) ? value.choices : [];
    const choice = choices[0] && typeof choices[0] === "object"
      ? choices[0] as Record<string, unknown>
      : {};
    finish = choice.finish_reason;
    if (finish !== undefined && finish !== null && finish !== "stop") {
      throw new Error(`LLM finish_reason=${String(finish)}`);
    }
    const message = choice.message && typeof choice.message === "object"
      ? choice.message as Record<string, unknown>
      : {};
    content = message.content;
  }
  const text = textFromOpenCodeContent(content).trim();
  if (!text) throw new Error("LLM 응답이 비어 있습니다");
  return text;
}

async function callOpenCode(
  prompt: string,
  model: string,
  protocol: OpenCodeProtocol,
  options: RecommendationModelOptions,
): Promise<string> {
  const path = protocol === "messages" ? "messages" : "chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.apiKey}`,
    "User-Agent": "namofood-menu-recommend/1.0",
    "x-opencode-session": options.sessionId || crypto.randomUUID(),
  };
  if (protocol === "messages") {
    headers["x-api-key"] = options.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  const response = await (options.fetcher || fetch)(
    `${options.baseUrl.replace(/\/$/, "")}/${path}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: Math.min(12_000, Math.max(1024, options.maxTokens || 8192)),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.any([
        options.signal || new AbortController().signal,
        AbortSignal.timeout(options.timeoutMs),
      ]),
    },
  );
  if (!response.ok) {
    throw new Error(
      `LLM ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  return parseRecommendationOpenCodeResponse(protocol, await response.json());
}

export async function runRecommendationModel(
  input: RecommendationInput,
  options: RecommendationModelOptions,
): Promise<RecommendationResult> {
  if (!options.apiKey) throw new Error("OPENCODE_API_KEY 가 없습니다");
  const deadline = Date.now() + MODEL_TOTAL_TIMEOUT_MS;
  const finalAttempt: {
    validation?: { model: string; protocol: OpenCodeProtocol; error: string };
  } = {};
  const boundedCall = async (
    prompt: string,
    model: string,
    protocol: OpenCodeProtocol,
  ): Promise<string> => {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DOMException(
        "AI 추천 전체 응답 시간이 초과됐습니다",
        "TimeoutError",
      );
    }
    const answer = await callOpenCode(prompt, model, protocol, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs, remaining),
    });
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new DOMException(
        "AI 추천 전체 응답 시간이 초과됐습니다",
        "TimeoutError",
      );
    }
    return answer;
  };
  let result: ModelFallbackResult<RecommendationSlots>;
  try {
    result = await runModelFallback(
      [options.primaryModel, options.fallbackModel],
      async (model, protocol, previousFailure) => {
        delete finalAttempt.validation;
        const answer = await boundedCall(
          buildRecommendationPrompt(input, previousFailure),
          model,
          protocol,
        );
        try {
          return validateRecommendationAnswer(answer, input);
        } catch (error) {
          if (error instanceof RecommendationValidationError) {
            finalAttempt.validation = { model, protocol, error: error.message };
          }
          throw error;
        }
      },
    );
  } catch (error) {
    const invalid = finalAttempt.validation;
    if (
      !(error instanceof ModelFallbackError) || error.attempts.length !== 2 ||
      !invalid || invalid.model !== options.fallbackModel.trim() ||
      options.signal?.aborted || Date.now() >= deadline
    ) throw error;
    const attempts = error.attempts.map((attempt) => ({ ...attempt }));
    const started = Date.now();
    try {
      const answer = await boundedCall(
        buildRecommendationPrompt(input, invalid.error),
        invalid.model,
        invalid.protocol,
      );
      const value = validateRecommendationAnswer(answer, input);
      attempts.push({
        model: invalid.model,
        protocol: invalid.protocol,
        ok: true,
        elapsedMs: Math.max(0, Date.now() - started),
      });
      result = { value, model: invalid.model, fallbackUsed: true, attempts };
    } catch (correctionError) {
      attempts.push({
        model: invalid.model,
        protocol: invalid.protocol,
        ok: false,
        elapsedMs: Math.max(0, Date.now() - started),
        error: (correctionError instanceof Error
          ? correctionError.message
          : String(correctionError)).replace(/\s+/g, " ").trim().slice(0, 400),
      });
      throw new ModelFallbackError(attempts);
    }
  }
  const validatedCount = SLOT_IDS.reduce(
    (sum, slot) => sum + result.value[slot].length,
    0,
  );
  return {
    source: "ai",
    model: result.model,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    slots: result.value,
    warnings: input.warnings,
    excludedCount: input.excludedCount,
    validatedCount,
  };
}

export function recommendationErrorStatus(error: unknown): number {
  if (error instanceof ModelFallbackError) return 502;
  const message = error instanceof Error ? error.message : String(error);
  if (/OPENCODE_API_KEY|후보가|추천 가능한/.test(message)) return 503;
  if (error instanceof RecommendationValidationError) return 502;
  return 500;
}

// 나모푸드 식단 자동 편성 — Edge Function 과 로컬 테스트가 함께 쓰는 순수 로직
// 상태 암호화 형식은 기존 nmf_cloud.mjs / nmf-recipe-fill 과 호환한다.

export type State = {
  menus?: Record<string, Record<string, unknown>>;
  menuPlanMeta?: Record<string, MenuPlanMeta>;
  headcountMeta?: Record<string, HeadcountMeta>;
  [key: string]: unknown;
};

export type MenuPlanMeta = {
  by: "ai";
  updated: string;
  model: string;
  runId: string;
};
export type HeadcountMeta = {
  by: "photo-plan" | "manual";
  updated: string;
  week?: string;
};
export type PlanMeal = {
  meal: string;
  slots: Record<string, string>;
  extras?: string[];
};
export type PlanDay = { date: string; meals: PlanMeal[] };
export type MenuPlan = { days: PlanDay[] };
export type OpenCodeProtocol = "chat-completions" | "messages";
export type ModelAttemptDiagnostic = {
  model: string;
  protocol: OpenCodeProtocol;
  ok: boolean;
  elapsedMs: number;
  error?: string;
};
export type ModelFallbackResult<T> = {
  value: T;
  model: string;
  fallbackUsed: boolean;
  attempts: ModelAttemptDiagnostic[];
};

export class ModelFallbackError extends Error {
  attempts: ModelAttemptDiagnostic[];

  constructor(attempts: ModelAttemptDiagnostic[]) {
    super(
      `모든 메뉴 생성 모델 실패: ${
        attempts.map((item) =>
          `${item.model}: ${item.error || "알 수 없는 오류"}`
        )
          .join(" | ")
      }`,
    );
    this.name = "ModelFallbackError";
    this.attempts = attempts;
  }
}

export const INITIAL_ANCHOR = "2026-09-24";
export const DEFAULT_MEALS = ["아침", "점심", "저녁", "야식"] as const;
// 0=암묵적 쌀밥. 편집 가능한 필수 6칸은 기존 저장 인덱스를 그대로 쓴다.
export const SLOT_INDICES = [
  "1",
  "2",
  "7",
  "3",
  "4",
  "8",
] as const;
export const UI_SLOT_ORDER = [
  "1",
  "2",
  "7",
  "3",
  "4",
  "8",
] as const;
export const SLOT_LABELS: Record<string, string> = {
  "1": "국",
  "2": "메인1",
  "3": "부찬1",
  "4": "부찬2",
  "7": "메인2",
  "8": "부찬3",
};

export const HEADCOUNT_WEEKS = [
  { monday: "2026-09-21", counts: [108, 217, 228, 120] },
  { monday: "2026-09-28", counts: [175, 350, 295, 120] },
  { monday: "2026-10-05", counts: [191, 382, 441, 250] },
  { monday: "2026-10-12", counts: [198, 397, 448, 250] },
  { monday: "2026-10-19", counts: [187, 375, 437, 250] },
  { monday: "2026-10-26", counts: [222, 445, 477, 255] },
  { monday: "2026-11-02", counts: [222, 445, 477, 255] },
  { monday: "2026-11-09", counts: [222, 445, 482, 260] },
  { monday: "2026-11-16", counts: [222, 445, 482, 260] },
  { monday: "2026-11-23", counts: [187, 375, 457, 270] },
  { monday: "2026-11-30", counts: [185, 370, 455, 270] },
  { monday: "2026-12-07", counts: [186, 372, 386, 200] },
  { monday: "2026-12-14", counts: [130, 260, 175, 45] },
] as const;

/** 사진 계획표가 제공된 전체 날짜. 최초 앵커 전 9/21~23은 운영 범위에서 제외한다. */
export function headcountPlanDates(): string[] {
  return [
    ...new Set(HEADCOUNT_WEEKS.flatMap((week) => blockDates(week.monday))),
  ]
    .filter((date) => date >= INITIAL_ANCHOR)
    .sort();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NON_MENU_SLOT = "n";
const LEGACY_SEED_END = "2026-09-30";
const LEGACY_SEED_COUNTS = [120, 300, 180, 100] as const;

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) throw new Error(`잘못된 날짜 형식: ${date}`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
  ) throw new Error(`존재하지 않는 날짜: ${date}`);
}

export function addDays(date: string, days: number): string {
  assertDate(date);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  assertDate(from);
  assertDate(to);
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

export function blockDates(anchor: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
}

export function initialAnchors(weeks: number): string[] {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 2) {
    throw new Error("weeks 는 1 또는 2여야 합니다");
  }
  return Array.from(
    { length: weeks },
    (_, i) => addDays(INITIAL_ANCHOR, i * 7),
  );
}

/** LLM 한 요청이 너무 커지지 않도록 날짜를 최대 chunkSize일씩 자른다. */
export function splitDateChunks(
  dates: string[],
  chunkSize = 2,
): string[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 2) {
    throw new Error("chunkSize 는 1 또는 2여야 합니다");
  }
  return Array.from(
    { length: Math.ceil(dates.length / chunkSize) },
    (_, index) => dates.slice(index * chunkSize, index * chunkSize + chunkSize),
  );
}

/** OpenCode Go 공식 endpoint 표에 맞춰 모델별 wire protocol을 선택한다. */
export function openCodeProtocol(model: string): OpenCodeProtocol {
  const id = model.trim().toLowerCase().replace(/^opencode-go\//, "");
  // 2026-09-25 기준 MiniMax M3/M2.x와 Qwen3.x는 /messages 이다.
  return /^(minimax-m|qwen3\.)/.test(id) ? "messages" : "chat-completions";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const value = part as { type?: unknown; text?: unknown };
    return typeof value.text === "string" ? value.text : "";
  }).join("");
}

/** OpenAI Chat Completions와 Anthropic Messages 응답을 같은 엄격도로 검증한다. */
export function parseOpenCodeResponse(
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
  const text = textFromContent(content).trim();
  if (!text) throw new Error("LLM 응답이 비어 있습니다");
  return text;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * primary 실패 종류와 무관하게 다음 모델을 시도한다. attempt 안에 transport,
 * HTTP, 응답 종료상태, 빈 응답, JSON/식단 검증을 모두 넣어야 한다.
 */
export async function runModelFallback<T>(
  models: string[],
  attempt: (model: string, protocol: OpenCodeProtocol) => Promise<T>,
): Promise<ModelFallbackResult<T>> {
  const uniqueModels = [
    ...new Set(
      models.map((model) => model.trim()).filter(
        Boolean,
      ),
    ),
  ];
  if (!uniqueModels.length) throw new Error("메뉴 생성 모델이 없습니다");

  const attempts: ModelAttemptDiagnostic[] = [];
  for (const model of uniqueModels) {
    const protocol = openCodeProtocol(model);
    const started = Date.now();
    try {
      const value = await attempt(model, protocol);
      attempts.push({
        model,
        protocol,
        ok: true,
        elapsedMs: Math.max(0, Date.now() - started),
      });
      return {
        value,
        model,
        fallbackUsed: attempts.length > 1,
        attempts,
      };
    } catch (error) {
      attempts.push({
        model,
        protocol,
        ok: false,
        elapsedMs: Math.max(0, Date.now() - started),
        error: compactError(error),
      });
    }
  }
  throw new ModelFallbackError(attempts);
}

/** 5분 이상 running 인 실행을 정리할 때 사용할 UTC 기준시각. */
export function staleRunCutoffIso(nowIso: string, staleMinutes = 5): string {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now) || staleMinutes <= 0) {
    throw new Error("stale run 기준시각이 올바르지 않습니다");
  }
  return new Date(now - staleMinutes * 60_000).toISOString();
}

export function blockAnchorFor(date: string): string {
  assertDate(date);
  if (date <= INITIAL_ANCHOR) return INITIAL_ANCHOR;
  return addDays(
    INITIAL_ANCHOR,
    Math.floor(daysBetween(INITIAL_ANCHOR, date) / 7) * 7,
  );
}

export function dateCell(date: string): { ym: string; day: string } {
  assertDate(date);
  return { ym: date.slice(0, 7), day: String(Number(date.slice(8, 10))) };
}

function nonempty(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/** 메뉴 키에서 실제 사용하는 4개 식사명을 찾아 조식→중식→석식→야식 순으로 반환한다. */
export function detectMealLabels(state: State): string[] {
  const foodSeen = new Map<string, { count: number; first: number }>();
  const countSeen = new Map<string, { count: number; first: number }>();
  let order = 0;
  for (const month of Object.values(state.menus || {})) {
    for (const key of Object.keys(month || {})) {
      const parts = key.split("|");
      if (parts.length !== 3 || !parts[1]) {
        continue;
      }
      const meal = parts[1].trim();
      const seen = parts[2] === NON_MENU_SLOT ? countSeen : foodSeen;
      const previous = seen.get(meal);
      if (previous) previous.count++;
      else seen.set(meal, { count: 1, first: order++ });
    }
  }

  // 전체 기간 n셀을 미리 채워도 실제 음식 셀의 식사명이 우선권을 갖는다.
  const seen = foodSeen.size ? foodSeen : countSeen;
  const observed = [...seen.entries()].sort((a, b) =>
    b[1].count - a[1].count || a[1].first - b[1].first
  );
  const patterns = [/(아침|조식)/, /(점심|중식)/, /(저녁|석식)/, /야식/];
  const matched: Array<string | undefined> = patterns.map((pattern) =>
    observed.find(([label]) => pattern.test(label))?.[0]
  );
  const result: string[] = [];
  const used = new Set<string>();
  const reserved = new Set(
    matched.filter((label): label is string => Boolean(label)),
  );
  const remaining = observed.sort((a, b) => a[1].first - b[1].first).map((
    [label],
  ) => label);
  for (let i = 0; i < 4; i++) {
    let label = matched[i];
    if (!label || used.has(label)) {
      label = remaining.find((candidate) =>
        !used.has(candidate) && !reserved.has(candidate)
      );
    }
    if (!label || used.has(label)) label = DEFAULT_MEALS[i];
    result.push(label);
    used.add(label);
  }
  return result;
}

/** 음식 셀이 하나라도 있는 날짜. 식수 인원(ci=n)만 있는 날짜는 식단 보유일로 세지 않는다. */
export function menuDates(state: State): string[] {
  const dates = new Set<string>();
  for (const [ym, month] of Object.entries(state.menus || {})) {
    for (const [key, value] of Object.entries(month || {})) {
      const [day, , ci] = key.split("|");
      if (
        ci === NON_MENU_SLOT ||
        !SLOT_INDICES.includes(ci as typeof SLOT_INDICES[number]) ||
        !nonempty(value)
      ) continue;
      const date = `${ym}-${String(Number(day)).padStart(2, "0")}`;
      try {
        assertDate(date);
        dates.add(date);
      } catch { /* 잘못된 옛 키는 범위 계산에서 제외 */ }
    }
  }
  return [...dates].sort();
}

/** 감지된 4식 모두에 편집 가능한 필수 6칸이 채워진 날짜만 horizon으로 센다. */
export function completeMenuDates(
  state: State,
  meals: string[] = detectMealLabels(state),
): string[] {
  return menuDates(state).filter((date) => {
    const { ym, day } = dateCell(date);
    const month = state.menus?.[ym] || {};
    return meals.every((meal) =>
      SLOT_INDICES.every((ci) => nonempty(month[`${day}|${meal}|${ci}`]))
    );
  });
}

export function existingMenuCells(
  state: State,
  dates: string[],
  meals: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const mealSet = new Set(meals);
  for (const date of dates) {
    const { ym, day } = dateCell(date);
    const month = state.menus?.[ym] || {};
    for (const [key, value] of Object.entries(month)) {
      const [cellDay, meal, ci] = key.split("|");
      if (
        String(Number(cellDay)) !== day || !mealSet.has(meal) ||
        !SLOT_INDICES.includes(ci as typeof SLOT_INDICES[number]) ||
        !nonempty(value)
      ) continue;
      out[`${date}|${meal}|${ci}`] = String(value).trim();
    }
  }
  return out;
}

function blockNeedsMenus(
  state: State,
  anchor: string,
  meals: string[],
): boolean {
  for (const date of blockDates(anchor)) {
    const { ym, day } = dateCell(date);
    const month = state.menus?.[ym] || {};
    for (const meal of meals) {
      for (
        const ci of SLOT_INDICES
      ) if (!nonempty(month[`${day}|${meal}|${ci}`])) return true;
    }
  }
  return false;
}

/**
 * 명시적 weeks 요청은 2026-09-24부터 고정 블록을 채운다.
 * 스케줄 호출은 KST 오늘 뒤 식단일이 7일 미만일 때만 현재/다음 블록을 최대 2개 보충한다.
 */
export function selectAnchorBlocks(
  state: State,
  today: string,
  requestedWeeks?: number,
): string[] {
  assertDate(today);
  const meals = detectMealLabels(state);
  if (requestedWeeks !== undefined) {
    return initialAnchors(requestedWeeks).filter((anchor) =>
      blockNeedsMenus(state, anchor, meals)
    );
  }

  const present = new Set(completeMenuDates(state, meals));
  const futureCount = () => [...present].filter((date) => date > today).length;
  if (futureCount() >= 7) return [];

  const selected: string[] = [];
  let anchor = blockAnchorFor(today < INITIAL_ANCHOR ? INITIAL_ANCHOR : today);
  // 완성된 블록을 건너뛸 수 있도록 여유 있게 탐색하되, 실제 생성은 최대 2블록이다.
  for (
    let checked = 0;
    checked < 54 && selected.length < 2 && futureCount() < 7;
    checked++, anchor = addDays(anchor, 7)
  ) {
    const dates = blockDates(anchor);
    if (blockNeedsMenus(state, anchor, meals)) selected.push(anchor);
    for (const date of dates) present.add(date);
  }
  return selected;
}

/**
 * Edge 150초 제한을 피하기 위해 실제 한 호출에서는 누락 블록 하나만 처리한다.
 * weeks=2 재호출 시 첫 블록이 완성됐으면 두 번째 누락 블록이 선택되므로 멱등이다.
 */
export function selectRunAnchorBlocks(
  state: State,
  today: string,
  requestedWeeks?: number,
): string[] {
  return selectAnchorBlocks(state, today, requestedWeeks).slice(0, 1);
}

export function headcountForDate(
  date: string,
  mealIndex: number,
): { count: number; week: string } | null {
  assertDate(date);
  if (!Number.isInteger(mealIndex) || mealIndex < 0 || mealIndex > 3) {
    return null;
  }
  const week = HEADCOUNT_WEEKS.find((item) =>
    daysBetween(item.monday, date) >= 0 && daysBetween(item.monday, date) <= 6
  );
  return week ? { count: week.counts[mealIndex], week: week.monday } : null;
}

export function buildPrompt(
  dates: string[],
  meals: string[],
  fixedCells: Record<string, string> = {},
): string {
  if (!dates.length) throw new Error("생성할 날짜가 없습니다");
  if (meals.length !== 4 || new Set(meals).size !== 4) {
    throw new Error("식사명은 서로 다른 4개여야 합니다");
  }
  dates.forEach(assertDate);
  const slotShape = UI_SLOT_ORDER.map((ci) => `${ci}=${SLOT_LABELS[ci]}`).join(
    ", ",
  );
  return [
    "당신은 한국 공장 구내식당의 실무 식단 편성자입니다. 반드시 JSON 하나만 출력하고 설명, 마크다운, 코드펜스를 쓰지 마세요.",
    "한 끼 판매가는 10,000원입니다. 공장 근무자 만족을 최우선으로 육류·튀김·볶음·구이·매콤한 메뉴를 푸짐하고 공격적으로 구성하세요. 영양 균형은 최우선 기준이 아니며 맛·포만감·메인메뉴의 양과 체감 품질을 우선하세요.",
    "쌀밥은 매 끼니에 암묵적으로 기본 제공되므로 slots나 extras에 절대 출력하지 마세요. 편집 가능한 필수 6칸은 국, 메인1, 메인2, 부찬1, 부찬2, 부찬3입니다.",
    "필수 6칸 외에 가격과 만족도를 살릴 추가 메뉴를 가능하면 1~3개 extras에 넣으세요. extras는 없어도 되며 그때는 빈 배열로 출력하세요. 후식은 고정 칸이 아니고 필요할 때만 extras에 넣으세요.",
    "하루 4식이 서로 단조롭지 않게 하고 같은 끼니 안에서는 필수 메뉴와 extras를 합쳐 음식명을 절대 중복하지 마세요. 주간 전체는 다양하게 구성하되 육류·채소·양념 같은 식재료는 인접 끼니에 현실적으로 재활용해 발주와 전처리가 가능하게 하세요.",
    `정확한 날짜(추가/누락 금지): ${JSON.stringify(dates)}`,
    `각 날짜의 정확한 식사명과 순서(추가/누락 금지): ${JSON.stringify(meals)}`,
    `slots 객체는 아래 문자열 키 6개만 정확히 한 번씩 사용하세요: ${slotShape}`,
    "슬롯 1은 반드시 국/탕/찌개/전골/스프류여야 합니다. slots에는 0, 5, 6, 9 또는 10 이상의 키를 넣지 마세요.",
    '출력 스키마: {"days":[{"date":"YYYY-MM-DD","meals":[{"meal":"식사명","slots":{"1":"국","2":"메인1","7":"메인2","3":"부찬1","4":"부찬2","8":"부찬3"},"extras":["추가메뉴1","추가메뉴2"]}]}]}',
    Object.keys(fixedCells).length
      ? `다음 기존 셀은 사람이 이미 입력했으므로 해당 슬롯에 글자까지 정확히 그대로 복사하세요: ${
        JSON.stringify(fixedCells)
      }`
      : "기존 고정 셀은 없습니다.",
    "모든 값은 짧고 구체적인 한국어 음식명이어야 합니다. 다시 강조합니다: JSON 이외의 텍스트는 출력하지 마세요.",
  ].join("\n");
}

function normalizeDish(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
}

function extractJson(text: string): unknown {
  const clean = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first < 0 || last < first) {
    throw new Error("LLM 응답에 JSON 객체가 없습니다");
  }
  return JSON.parse(clean.slice(first, last + 1));
}

/** LLM 출력을 정규화하며 날짜·식사·필수 6칸·optional extras·중복을 검증한다. */
export function parseMenuPlanJson(
  text: string,
  expectedDates: string[],
  expectedMeals: string[],
  fixedCells: Record<string, string> = {},
): MenuPlan {
  const value = extractJson(text) as { days?: unknown };
  if (!value || !Array.isArray(value.days)) {
    throw new Error("days 배열이 없습니다");
  }
  if (expectedMeals.length !== 4 || new Set(expectedMeals).size !== 4) {
    throw new Error("예상 식사명은 서로 다른 4개여야 합니다");
  }
  const expectedDateSet = new Set(expectedDates);
  const seenDates = new Set<string>();
  const days: PlanDay[] = [];

  for (
    const rawDay of value.days as Array<{ date?: unknown; meals?: unknown }>
  ) {
    const date = typeof rawDay?.date === "string" ? rawDay.date : "";
    if (!expectedDateSet.has(date)) {
      throw new Error(
        `예상하지 않은 날짜: ${date || "(없음)"}`,
      );
    }
    if (seenDates.has(date)) throw new Error(`중복 날짜: ${date}`);
    seenDates.add(date);
    if (!Array.isArray(rawDay.meals)) {
      throw new Error(
        `${date}: meals 배열이 없습니다`,
      );
    }
    const mealMap = new Map<string, PlanMeal>();
    for (
      const rawMeal of rawDay.meals as Array<
        { meal?: unknown; slots?: unknown; extras?: unknown }
      >
    ) {
      const meal = typeof rawMeal?.meal === "string" ? rawMeal.meal : "";
      if (!expectedMeals.includes(meal)) {
        throw new Error(
          `${date}: 예상하지 않은 식사명 ${meal || "(없음)"}`,
        );
      }
      if (mealMap.has(meal)) throw new Error(`${date}: 중복 식사명 ${meal}`);
      if (
        !rawMeal.slots || typeof rawMeal.slots !== "object" ||
        Array.isArray(rawMeal.slots)
      ) throw new Error(`${date} ${meal}: slots 객체가 없습니다`);
      const rawSlots = rawMeal.slots as Record<string, unknown>;
      const keys = Object.keys(rawSlots).sort((a, b) => Number(a) - Number(b));
      const requiredKeys = new Set<string>(SLOT_INDICES);
      if (
        keys.length !== SLOT_INDICES.length ||
        keys.some((key) => !requiredKeys.has(key))
      ) {
        throw new Error(
          `${date} ${meal}: 필수 슬롯 키 1,2,7,3,4,8이 정확히 한 번씩 있어야 합니다`,
        );
      }
      const slots: Record<string, string> = {};
      for (const ci of SLOT_INDICES) {
        if (
          typeof rawSlots[ci] !== "string" || !rawSlots[ci].trim()
        ) {
          throw new Error(
            `${date} ${meal} 슬롯 ${ci}: 음식명이 비어 있습니다`,
          );
        }
        slots[ci] = rawSlots[ci].trim();
        const fixed = fixedCells[`${date}|${meal}|${ci}`];
        if (fixed !== undefined && slots[ci] !== fixed) {
          throw new Error(
            `${date} ${meal} 슬롯 ${ci}: 기존 수동 입력을 그대로 유지하지 않았습니다`,
          );
        }
      }
      const rawExtras = rawMeal.extras ?? [];
      if (!Array.isArray(rawExtras) || rawExtras.length > 3) {
        throw new Error(`${date} ${meal}: extras는 최대 3개 배열이어야 합니다`);
      }
      const extras = rawExtras.map((dish, index) => {
        if (typeof dish !== "string" || !dish.trim()) {
          throw new Error(
            `${date} ${meal} extra ${index}: 음식명이 비어 있습니다`,
          );
        }
        return dish.trim();
      });
      const normalized = [
        ...SLOT_INDICES.map((ci) => normalizeDish(slots[ci])),
        ...extras.map(normalizeDish),
      ];
      if (new Set(normalized).size !== normalized.length) {
        throw new Error(
          `${date} ${meal}: 같은 끼니 안에 중복 음식이 있습니다`,
        );
      }
      // 기존 운영 식단의 닭개장·우동육수도 국 칸의 정상 메뉴다.
      if (!/(국|탕|찌개|전골|스프|수프|육수|개장)/.test(slots["1"])) {
        throw new Error(
          `${date} ${meal}: 슬롯 1에 국/탕/찌개/전골/스프류가 없습니다`,
        );
      }
      mealMap.set(meal, { meal, slots, extras });
    }
    if (
      mealMap.size !== expectedMeals.length ||
      expectedMeals.some((meal) => !mealMap.has(meal))
    ) throw new Error(`${date}: 식사 4개가 정확하지 않습니다`);
    days.push({ date, meals: expectedMeals.map((meal) => mealMap.get(meal)!) });
  }
  if (
    seenDates.size !== expectedDates.length ||
    expectedDates.some((date) => !seenDates.has(date))
  ) throw new Error("요청한 날짜가 모두 들어 있지 않습니다");
  const byDate = new Map(days.map((day) => [day.date, day]));
  return { days: expectedDates.map((date) => byDate.get(date)!) };
}

export type MergeResult = {
  added: string[];
  preserved: string[];
  menuMeta: string[];
  rice: string[];
  headcounts: Record<string, number>;
  prices: string[];
};

/** 4개 식사의 판매가를 10,000원으로 맞추되 settings 안의 다른 인원/원가 필드는 보존한다. */
export function mergeMealPrices(state: State, meals: string[]): string[] {
  const settings = state.settings && typeof state.settings === "object" &&
      !Array.isArray(state.settings)
    ? state.settings as Record<string, unknown>
    : (state.settings = {}) as Record<string, unknown>;
  const mealSettings = settings.meals && typeof settings.meals === "object" &&
      !Array.isArray(settings.meals)
    ? settings.meals as Record<string, unknown>
    : (settings.meals = {}) as Record<string, unknown>;
  const tickets = settings.tickets && typeof settings.tickets === "object" &&
      !Array.isArray(settings.tickets)
    ? settings.tickets as Record<string, unknown>
    : (settings.tickets = {}) as Record<string, unknown>;
  const changed: string[] = [];
  for (const meal of meals) {
    const mealConfig =
      mealSettings[meal] && typeof mealSettings[meal] === "object" &&
        !Array.isArray(mealSettings[meal])
        ? mealSettings[meal] as Record<string, unknown>
        : (mealSettings[meal] = {}) as Record<string, unknown>;
    if (mealConfig.price !== 10_000) {
      mealConfig.price = 10_000;
      changed.push(`settings.meals.${meal}.price`);
    }
    if (tickets[meal] !== 10_000) {
      tickets[meal] = 10_000;
      changed.push(`settings.tickets.${meal}`);
    }
  }
  return changed;
}

/** 사진 계획표 식수를 빈 칸·기본 설정값·기존 사진값에 넣고, 수동값은 보존한다. */
export function mergeHeadcounts(
  state: State,
  dates: string[],
  meals: string[],
  updated: string,
): Record<string, number> {
  state.menus ||= {};
  state.headcountMeta ||= {};
  const added: Record<string, number> = {};
  for (const date of dates) {
    const { ym, day } = dateCell(date);
    const month = state.menus[ym] ||= {};
    for (let mealIndex = 0; mealIndex < meals.length; mealIndex++) {
      const planned = headcountForDate(date, mealIndex);
      if (!planned) continue;
      const meal = meals[mealIndex];
      const cellKey = `${day}|${meal}|n`;
      const metaKey = `${date}|${meal}`;
      const existing = month[cellKey];
      const meta = state.headcountMeta[metaKey];
      const settings = state.settings && typeof state.settings === "object" &&
          !Array.isArray(state.settings)
        ? state.settings as Record<string, unknown>
        : {};
      const mealSettings = settings.meals &&
          typeof settings.meals === "object" && !Array.isArray(settings.meals)
        ? settings.meals as Record<string, unknown>
        : {};
      const mealConfig = mealSettings[meal] &&
          typeof mealSettings[meal] === "object" &&
          !Array.isArray(mealSettings[meal])
        ? mealSettings[meal] as Record<string, unknown>
        : {};
      const defaultCount = Number(mealConfig.count);
      const isDefaultPlaceholder = !meta && Number.isFinite(defaultCount) &&
        Number(existing) === defaultCount;
      // 최초 9/24~9/30 식단과 함께 주입된 4식 seed 값. 메타가 없는 이
      // 정확한 기간/값만 자동값으로 보며, manual 메타와 이후 날짜는 보존한다.
      const isLegacySeedPlaceholder = !meta && date >= INITIAL_ANCHOR &&
        date <= LEGACY_SEED_END &&
        Number(existing) === LEGACY_SEED_COUNTS[mealIndex];
      const replaceable = !nonempty(existing) || meta?.by === "photo-plan" ||
        isDefaultPlaceholder || isLegacySeedPlaceholder;
      if (!replaceable || meta?.by === "manual") continue;
      if (
        Number(existing) === planned.count && meta?.by === "photo-plan" &&
        meta.week === planned.week
      ) continue;
      month[cellKey] = String(planned.count);
      state.headcountMeta[metaKey] = {
        by: "photo-plan",
        updated,
        week: planned.week,
      };
      added[metaKey] = planned.count;
    }
  }
  return added;
}

/** 필수 6칸이 있는 모든 끼니의 비편집 기본값 0을 쌀밥으로 통일한다. */
export function ensureImplicitRice(
  state: State,
  dates: string[],
  meals: string[],
): string[] {
  state.menus ||= {};
  const changed: string[] = [];
  for (const date of [...new Set(dates)]) {
    const { ym, day } = dateCell(date);
    const month = state.menus[ym] ||= {};
    for (const meal of meals) {
      const key = `${day}|${meal}|0`;
      if (month[key] === "쌀밥") continue;
      month[key] = "쌀밥";
      changed.push(`${date}|${meal}|0`);
    }
  }
  return changed;
}

/** 검증된 AI 식단을 빈 셀에만 병합하고, 생성된 끼니만 AI 메타로 표시한다. */
export function mergeMenuPlan(
  state: State,
  plan: MenuPlan,
  options: {
    updated: string;
    model: string;
    runId: string;
    meals: string[];
    headcountDates?: string[];
  },
): MergeResult {
  state.menus ||= {};
  state.menuPlanMeta ||= {};
  const added: string[] = [];
  const preserved: string[] = [];
  const menuMeta: string[] = [];
  for (const dayPlan of plan.days) {
    const { ym, day } = dateCell(dayPlan.date);
    const month = state.menus[ym] ||= {};
    for (const mealPlan of dayPlan.meals) {
      const finalDishes = SLOT_INDICES.map((ci) => {
        const existing = month[`${day}|${mealPlan.meal}|${ci}`];
        return nonempty(existing)
          ? String(existing).trim()
          : mealPlan.slots[ci];
      }).map(normalizeDish);
      if (new Set(finalDishes).size !== finalDishes.length) {
        throw new Error(
          `${dayPlan.date} ${mealPlan.meal}: 수동 셀 병합 후 중복 음식이 생깁니다`,
        );
      }
      let mealAdded = false;
      for (const ci of SLOT_INDICES) {
        const key = `${day}|${mealPlan.meal}|${ci}`;
        const fullKey = `${dayPlan.date}|${mealPlan.meal}|${ci}`;
        if (nonempty(month[key])) {
          preserved.push(fullKey);
          continue;
        }
        month[key] = mealPlan.slots[ci];
        added.push(fullKey);
        mealAdded = true;
      }
      // 5/6/9와 기존 >=10 메뉴는 그대로 둔다. AI optional extras만 첫 빈
      // >=10 인덱스에 추가하고, 기존/필수 메뉴와 중복이면 조용히 건너뛴다.
      const usedDishes = new Set<string>();
      for (const [key, value] of Object.entries(month)) {
        const [cellDay, cellMeal, ci] = key.split("|");
        if (
          String(Number(cellDay)) === day && cellMeal === mealPlan.meal &&
          ci !== NON_MENU_SLOT && ci !== "0" && nonempty(value)
        ) usedDishes.add(normalizeDish(String(value)));
      }
      for (const extra of mealPlan.extras || []) {
        const normalized = normalizeDish(extra);
        if (usedDishes.has(normalized)) continue;
        let ci = 10;
        while (nonempty(month[`${day}|${mealPlan.meal}|${ci}`])) ci++;
        const key = `${day}|${mealPlan.meal}|${ci}`;
        month[key] = extra;
        added.push(`${dayPlan.date}|${mealPlan.meal}|${ci}`);
        usedDishes.add(normalized);
        mealAdded = true;
      }
      if (mealAdded) {
        const metaKey = `${dayPlan.date}|${mealPlan.meal}`;
        state.menuPlanMeta[metaKey] = {
          by: "ai",
          updated: options.updated,
          model: options.model,
          runId: options.runId,
        };
        menuMeta.push(metaKey);
      }
    }
  }
  // 기존 10월 데이터도 다른 메뉴는 그대로 둔 채 key0만 쌀밥으로 기본화한다.
  const rice = ensureImplicitRice(
    state,
    [...new Set([...menuDates(state), ...plan.days.map((day) => day.date)])],
    options.meals,
  );
  const dates = options.headcountDates || plan.days.map((day) => day.date);
  const headcounts = mergeHeadcounts(
    state,
    dates,
    options.meals,
    options.updated,
  );
  const prices = mergeMealPrices(state, options.meals);
  return { added, preserved, menuMeta, rice, headcounts, prices };
}

export function coverageReport(
  state: State,
  today: string,
): Record<string, unknown> {
  const meals = detectMealLabels(state);
  const dates = menuDates(state);
  const future = dates.filter((date) => date > today);
  const completeDates = completeMenuDates(state, meals);
  const completeFuture = completeDates.filter((date) => date > today);
  const slotSet = new Set<string>();
  for (const month of Object.values(state.menus || {})) {
    for (const key of Object.keys(month || {})) {
      const ci = key.split("|")[2];
      if (ci && ci !== NON_MENU_SLOT) {
        slotSet.add(ci);
      }
    }
  }
  return {
    todayKst: today,
    meals,
    menuDateCount: dates.length,
    firstMenuDate: dates[0] || null,
    lastMenuDate: dates.at(-1) || null,
    futureMenuDays: future.length,
    futureMenuStart: future[0] || null,
    futureMenuEnd: future.at(-1) || null,
    completeMenuDateCount: completeDates.length,
    futureCompleteMenuDays: completeFuture.length,
    futureCompleteMenuStart: completeFuture[0] || null,
    futureCompleteMenuEnd: completeFuture.at(-1) || null,
    storedSlotIndices: [...slotSet].sort((a, b) => Number(a) - Number(b)),
    expectedSlotIndices: [...SLOT_INDICES],
    uiSlotOrder: [...UI_SLOT_ORDER],
    nextAnchors: selectAnchorBlocks(state, today),
  };
}

const b64e = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + 8192)),
    );
  }
  return btoa(binary);
};
const b64d = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
type U8 = Uint8Array<ArrayBuffer>;
const u8 = (value: Uint8Array): U8 => new Uint8Array(value) as U8;

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    u8(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: u8(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function gzip(
  bytes: Uint8Array,
  mode: "gzip" | "gunzip",
): Promise<U8> {
  const stream = mode === "gzip"
    ? new CompressionStream("gzip")
    : new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  // 입출력을 동시에 진행해야 큰 상태에서도 스트림 backpressure 교착이 생기지 않는다.
  const writing = writer.write(u8(bytes)).then(() => writer.close());
  const reading = new Response(stream.readable).arrayBuffer();
  const [buffer] = await Promise.all([reading, writing]);
  return u8(new Uint8Array(buffer));
}

export async function decryptText(
  password: string,
  blob: string | Record<string, unknown>,
): Promise<string> {
  const payload = typeof blob === "string" ? JSON.parse(blob) : blob;
  const iterations = Number(payload.iter || 150_000);
  const key = await deriveKey(password, b64d(String(payload.salt)), iterations);
  let plain = u8(
    new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: u8(b64d(String(payload.iv))) },
        key,
        u8(b64d(String(payload.ct))),
      ),
    ),
  );
  if (payload.z) plain = await gzip(plain, "gunzip");
  return new TextDecoder().decode(plain);
}

export async function encryptText(
  password: string,
  text: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 150_000;
  const key = await deriveKey(password, salt, iterations);
  const compressed = await gzip(new TextEncoder().encode(text), "gzip");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: u8(iv) },
      key,
      u8(compressed),
    ),
  );
  return JSON.stringify({
    v: 2,
    z: 1,
    iter: iterations,
    salt: b64e(salt),
    iv: b64e(iv),
    ct: b64e(ciphertext),
  });
}

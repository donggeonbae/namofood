// nmf-menu-plan 순수 로직 회귀 테스트. 네트워크/LLM/실제 상태를 사용하지 않는다.
// 실행: deno run -A tools/test_menu_plan.ts
import {
  blockDates,
  buildPrompt,
  completeMenuDates,
  decryptText,
  detectMealLabels,
  encryptText,
  HEADCOUNT_WEEKS,
  headcountForDate,
  headcountPlanDates,
  initialAnchors,
  kstDayStartIso,
  menuDates,
  type MenuPlan,
  mergeHeadcounts,
  mergeMenuPlan,
  mergeMenuPlanDays,
  ModelFallbackError,
  openCodeProtocol,
  parseMenuPlanJson,
  parseOpenCodeResponse,
  runModelFallback,
  runValidatedMenuAttempt,
  selectAnchorBlocks,
  selectRetryMenuDates,
  selectRunAnchorBlocks,
  SLOT_INDICES,
  splitDateChunks,
  staleRunCutoffIso,
  type State,
  UI_SLOT_ORDER,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nexpected: ${e}\nactual:   ${a}`);
}

function throws(fn: () => unknown, pattern: RegExp, message: string): void {
  try {
    fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (pattern.test(text)) return;
    throw new Error(`${message}: 다른 오류가 발생했습니다: ${text}`);
  }
  throw new Error(`${message}: 오류가 발생하지 않았습니다`);
}

async function rejects(
  fn: () => Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (pattern.test(text)) return error;
    throw new Error(`${message}: 다른 오류가 발생했습니다: ${text}`);
  }
  throw new Error(`${message}: 오류가 발생하지 않았습니다`);
}

const MEALS = ["조식", "중식", "석식", "야식"];
const DISHES: Record<string, string> = {
  "1": "소고기무국",
  "2": "제육볶음",
  "3": "감자조림",
  "4": "콩나물무침",
  "7": "고등어구이",
  "8": "어묵볶음",
};

function fixturePlan(dates: string[], meals = MEALS): MenuPlan {
  return {
    days: dates.map((date, dateIndex) => ({
      date,
      meals: meals.map((meal, mealIndex) => ({
        meal,
        slots: Object.fromEntries(
          SLOT_INDICES.map((
            ci,
          ) => [ci, `${DISHES[ci]} ${dateIndex + 1}-${mealIndex + 1}`]),
        ),
      })),
    })),
  };
}

// OpenCode Go 공식 protocol과 primary→fallback 오케스트레이션.
assert(
  openCodeProtocol("deepseek-v4.1-flash") === "chat-completions",
  "DeepSeek V4.1 Flash는 chat/completions",
);
assert(
  openCodeProtocol("minimax-m3") === "messages",
  "MiniMax M3는 Anthropic messages",
);
assert(
  parseOpenCodeResponse("chat-completions", {
    choices: [{ finish_reason: "stop", message: { content: " chat ok " } }],
  }) === "chat ok",
  "chat/completions 응답 추출",
);
assert(
  parseOpenCodeResponse("messages", {
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "숨김" }, {
      type: "text",
      text: " messages ok ",
    }],
  }) === "messages ok",
  "messages text block 응답 추출",
);
throws(
  () =>
    parseOpenCodeResponse("chat-completions", {
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
    }),
  /finish_reason=length/,
  "chat 토큰 잘림 거절",
);
throws(
  () =>
    parseOpenCodeResponse("messages", {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "partial" }],
    }),
  /finish_reason=max_tokens/,
  "messages 토큰 잘림 거절",
);

let attempts = 0;
const primarySuccess = await runModelFallback(
  ["deepseek-v4.1-flash", "minimax-m3"],
  (model) => {
    attempts++;
    return Promise.resolve(model);
  },
);
assert(
  attempts === 1 && primarySuccess.model === "deepseek-v4.1-flash" &&
    !primarySuccess.fallbackUsed,
  "primary 성공 시 fallback 미호출",
);

const expectedFallbackPlan = fixturePlan(["2026-09-24"]);
const validationFallback = await runModelFallback(
  ["deepseek-v4.1-flash", "minimax-m3"],
  (model) => {
    if (model === "deepseek-v4.1-flash") {
      // transport/HTTP/empty/finish와 마찬가지로 JSON 식단 검증 throw도 fallback한다.
      return Promise.resolve(
        parseMenuPlanJson("{}", ["2026-09-24"], MEALS),
      );
    }
    return Promise.resolve(
      parseMenuPlanJson(
        JSON.stringify(expectedFallbackPlan),
        ["2026-09-24"],
        MEALS,
      ),
    );
  },
);
assert(
  validationFallback.model === "minimax-m3" &&
    validationFallback.fallbackUsed &&
    validationFallback.attempts.length === 2 &&
    validationFallback.attempts[0].error?.includes("days 배열"),
  "primary 검증 실패 후 MiniMax fallback 및 원인 진단",
);

const bothFailed = await rejects(
  () =>
    runModelFallback(
      ["deepseek-v4.1-flash", "minimax-m3"],
      (model) =>
        Promise.reject(
          new Error(`${model} simulated transport failure`),
        ),
    ),
  /deepseek-v4\.1-flash.*minimax-m3/,
  "두 모델 실패 진단",
);
assert(
  bothFailed instanceof ModelFallbackError && bothFailed.attempts.length === 2,
  "모든 실패에 모델별 attempt 진단 포함",
);
attempts = 0;
await rejects(
  () =>
    runModelFallback(["same-model", "same-model"], () => {
      attempts++;
      return Promise.reject(new Error("once"));
    }),
  /same-model/,
  "동일 override 모델 실패",
);
assert(attempts === 1, "primary/fallback 모델명이 같으면 중복 호출하지 않음");

let correction = "";
await runModelFallback(
  ["primary", "fallback"],
  (model, _protocol, previousFailure) => {
    if (model === "primary") {
      return Promise.reject(
        new Error("슬롯 1 입력: 제육볶음"),
      );
    }
    correction = previousFailure || "";
    return Promise.resolve("corrected");
  },
);
assert(correction.includes("제육볶음"), "fallback에 실제 이전 오류 전달");
assert(
  buildPrompt(["2026-10-16"], MEALS, {}, {}, correction).includes(
    JSON.stringify(correction),
  ),
  "오류를 인용 데이터로 프롬프트에 전달",
);

// 완성된 잘못된 답만 같은 모델에 수정 요청하며 검증을 완화하지 않는다.
const noodlePlan = fixturePlan(["2026-10-16"]);
noodlePlan.days[0].meals[0].slots["1"] = "라면";
const noodleAnswer = JSON.stringify(noodlePlan);
const properAnswer = JSON.stringify(fixturePlan(["2026-10-16"]));
let correctionCalls = 0;
const correctionsSeen: Array<
  { attempt: number; error: string; answer: string }
> = [];
const correctedPlan = await runValidatedMenuAttempt(
  (item) => {
    correctionCalls++;
    if (item) {
      assert(
        item.error.includes("라면") && item.answer === noodleAnswer,
        "정확한 오류와 이전 JSON을 수정 요청에 전달",
      );
    }
    return Promise.resolve(item ? properAnswer : noodleAnswer);
  },
  (answer) => parseMenuPlanJson(answer, ["2026-10-16"], MEALS),
  { onCorrection: (item) => correctionsSeen.push(item) },
);
assert(
  correctionCalls === 2 && correctionsSeen.length === 1 &&
    correctionsSeen[0].attempt === 1,
  "검증 실패 한 번 뒤 같은 모델 수정 성공",
);
assert(
  correctedPlan.days[0].meals[0].slots["1"] !== "라면",
  "국 칸을 검증 없이 면으로 승인하지 않음",
);
const boundedCorrections: number[] = [];
correctionCalls = 0;
await rejects(
  () =>
    runValidatedMenuAttempt(
      () => {
        correctionCalls++;
        return Promise.resolve(noodleAnswer);
      },
      (answer) => parseMenuPlanJson(answer, ["2026-10-16"], MEALS),
      { onCorrection: (item) => boundedCorrections.push(item.attempt) },
    ),
  /입력: 라면/,
  "수정한 답도 국 오류이면 끝까지 거절",
);
equal(boundedCorrections, [1, 2], "모델별 수정 요청은 최대 2회");
assert(correctionCalls === 3, "최초 한 번과 수정 두 번만 호출");
correctionCalls = 0;
await rejects(
  () =>
    runValidatedMenuAttempt(() => {
      correctionCalls++;
      return Promise.reject(new Error("LLM timeout"));
    }, (answer) => answer),
  /timeout/,
  "transport timeout은 같은 모델 수정 대상이 아님",
);
assert(correctionCalls === 1, "transport 오류에 추가 비용 유발하지 않음");
const abortedCorrection = new AbortController();
let abortedCalls = 0;
await rejects(
  () =>
    runValidatedMenuAttempt(() => {
      abortedCalls++;
      return Promise.resolve(noodleAnswer);
    }, () => {
      abortedCorrection.abort(new Error("generation deadline"));
      throw new Error("bad reply");
    }, {
      signal: abortedCorrection.signal,
      onCorrection: () => {
        throw new Error("종료 뒤 수정 요청이 발생함");
      },
    }),
  /bad reply/,
  "공유 deadline 뒤 수정 요청 없음",
);
assert(abortedCalls === 1, "취소 후 두 번째 LLM 호출하지 않음");
const promptWithCorrection = buildPrompt(
  ["2026-10-16"],
  MEALS,
  {},
  {
    "2026-10-13|야식|2": "양념치킨",
    "2026-10-14|조식|10": "간장수육",
    "2026-10-14|조식|4": "두부조림",
  },
  correctionsSeen[0].error,
  noodleAnswer,
);
assert(
  promptWithCorrection.includes(JSON.stringify(noodleAnswer)),
  "이전 후보 전체는 인용 데이터로 전달",
);
const bannedLine =
  promptWithCorrection.split("\n").find((line) =>
    line.startsWith("신규 메인 슬롯")
  ) || "";
assert(
  ["양념치킨", "간장수육", "두부조림"].every((name) =>
    bannedLine.includes(name)
  ),
  "금지 신규 메인은 검증과 같은 모든 주변 음식/추가메뉴를 포함",
);
assert(
  promptWithCorrection.includes("라면·국수·우동·냉면"),
  "국 칸에 면 요리 금지 명시",
);

// KST 자정 기준 quota, legacy 범위, no-op, 정확한 cooldown 경계를 확인한다.
equal(
  kstDayStartIso("2026-10-01T14:59:59.000Z"),
  "2026-09-30T15:00:00.000Z",
  "KST 자정 직전",
);
equal(
  kstDayStartIso("2026-10-01T15:00:00.000Z"),
  "2026-10-01T15:00:00.000Z",
  "KST 자정 직후",
);
const retryDate = "2026-10-16";
const retryNow = "2026-10-02T03:00:00.000Z";
equal(selectRetryMenuDates([retryDate], [], retryNow), {
  dates: [retryDate],
  deferred: [],
}, "이력 없는 누락 날짜 생성 가능");
const cooling = selectRetryMenuDates([retryDate], [{
  started_at: "2026-10-02T02:45:00.000Z",
  targets: [retryDate],
}], retryNow);
equal(cooling.dates, [], "15분 뒤 cron tick은 LLM 재호출하지 않음");
equal(
  selectRetryMenuDates(
    [retryDate],
    [{ started_at: "2026-10-02T02:45:00.000Z", targets: [retryDate] }],
    retryNow,
    { force: true },
  ).dates,
  [retryDate],
  "인증된 운영 force는 cooldown만 해제",
);
equal(cooling.deferred[0], {
  date: retryDate,
  attempts: 1,
  reason: "cooldown",
  nextAt: "2026-10-02T03:15:00.000Z",
}, "정확한 다음 재시도 시각");
equal(
  selectRetryMenuDates([retryDate], [{
    started_at: "2026-10-02T02:30:00.000Z",
    targets: [retryDate],
  }], retryNow).dates,
  [retryDate],
  "30분 경과 경계에서 재시도 가능",
);
const capped = selectRetryMenuDates(
  [retryDate],
  ["00", "01", "02"].map((hour) => ({
    started_at: `2026-10-02T${hour}:00:00.000Z`,
    targets: [retryDate],
  })),
  retryNow,
);
equal(
  selectRetryMenuDates(
    [retryDate],
    ["00", "01", "02"].map((hour) => ({
      started_at: `2026-10-02T${hour}:00:00.000Z`,
      targets: [retryDate],
    })),
    retryNow,
    { force: true },
  ).dates,
  [],
  "force도 하루 3회 한도는 우회하지 않음",
);
equal(capped.deferred[0], {
  date: retryDate,
  attempts: 3,
  reason: "daily_limit",
  nextAt: "2026-10-02T15:00:00.000Z",
}, "KST 하루 3회 제한 및 다음날 초기화 시각");
const midnight = selectRetryMenuDates([retryDate], [
  { started_at: "2026-10-01T14:40:00.000Z", targets: [retryDate] },
  { started_at: "2026-10-01T14:30:00.000Z", targets: [retryDate] },
  { started_at: "2026-10-01T14:20:00.000Z", targets: [retryDate] },
], "2026-10-01T15:00:00.000Z");
assert(
  midnight.deferred[0].reason === "cooldown" &&
    midnight.deferred[0].attempts === 0,
  "자정에 한도는 초기화하지만 직전 실행 cooldown 유지",
);
equal(
  selectRetryMenuDates([retryDate], [{
    started_at: retryNow,
    targets: [],
    target_start: null,
    target_end: null,
  }], retryNow).dates,
  [retryDate],
  "no-op tick은 횟수 및 cooldown을 소모하지 않음",
);
equal(
  selectRetryMenuDates([retryDate], [{
    started_at: "2026-10-02T02:45:00.000Z",
    targets: [],
    target_start: "2026-10-15",
    target_end: retryDate,
  }], retryNow).dates,
  [],
  "이전 target range 기록도 실제 시도로 계산",
);
equal(
  selectRetryMenuDates([retryDate], [{
    started_at: retryNow,
    targets: ["2026-10-15"],
    target_start: "2026-10-15",
    target_end: retryDate,
  }], retryNow).dates,
  [retryDate],
  "명시적 targets가 있으면 넓은 range의 다른 날짜는 횟수에서 제외",
);

// 한 날짜 검증/충돌 실패가 다른 날짜 또는 원본 상태를 손상시키지 않는다.
const independentlyMergedPlan = fixturePlan(["2026-10-15", "2026-10-16"]);
independentlyMergedPlan.days[0].meals[3].extras = ["맥주"];
const independentInput: State = {
  menus: { "2026-10": { "16|조식|n": "999" } },
  headcountMeta: { "2026-10-16|조식": { by: "manual", updated: "keep" } },
};
const independentBefore = structuredClone(independentInput);
const independent = mergeMenuPlanDays(
  independentInput,
  independentlyMergedPlan,
  {
    updated: retryNow,
    model: "fixture",
    runId: "partial",
    meals: MEALS,
    headcountDates: [],
  },
);
equal(independent.succeededDates, ["2026-10-16"], "유효한 두 번째 날짜만 성공");
assert(
  independent.failedDates.length === 1 &&
    independent.failedDates[0].date === "2026-10-15" &&
    independent.failedDates[0].error.includes("주류"),
  "실패 날짜/실제 오류 반환",
);
assert(
  !Object.keys(independent.state.menus!["2026-10"]).some((key) =>
    key.startsWith("15|")
  ),
  "실패 날짜 앞선 끼니도 부분 변경 없이 폐기",
);
assert(
  completeMenuDates(independent.state, MEALS).includes("2026-10-16"),
  "다른 성공 날짜 필수24칸 보존",
);
equal(
  independentInput,
  independentBefore,
  "입력 원본을 변경하지 않아 CAS 재시도 안전",
);
equal(
  independent.state.menus!["2026-10"]["16|조식|n"],
  "999",
  "성공 날짜도 수동 식수 보존",
);

const concurrentPlan = fixturePlan(["2026-10-15", "2026-10-16"]);
const concurrentManual: State = {
  menus: {
    "2026-10": {
      "15|조식|3": concurrentPlan.days[0].meals[0].slots["4"],
      "16|조식|2": "동시수동메인",
    },
  },
};
const concurrent = mergeMenuPlanDays(concurrentManual, concurrentPlan, {
  updated: retryNow,
  model: "fixture",
  runId: "concurrent",
  meals: MEALS,
  headcountDates: [],
});
equal(
  concurrent.succeededDates,
  ["2026-10-16"],
  "수동 셀 중복 충돌 날짜만 거절",
);
assert(
  concurrent.failedDates[0].error.includes("수동 셀 병합 후 중복"),
  "동시 변경 오류 명확히 반환",
);
equal(
  concurrent.state.menus!["2026-10"]["16|조식|2"],
  "동시수동메인",
  "성공 날짜의 동시 수동 메뉴 보존",
);

const varietyPlan = fixturePlan(["2026-10-15", "2026-10-16"]);
const varietyState: State = {
  menus: {
    "2026-10": { "14|중식|2": varietyPlan.days[0].meals[0].slots["2"] },
  },
};
const varietyPartial = mergeMenuPlanDays(varietyState, varietyPlan, {
  updated: retryNow,
  model: "fixture",
  runId: "variety",
  meals: MEALS,
  headcountDates: [],
});
equal(
  varietyPartial.succeededDates,
  ["2026-10-16"],
  "앞뒤7일 중복 날짜만 거절하고 다른 날짜 성공",
);
assert(
  varietyPartial.failedDates.length === 1,
  "partial 처리로 variety 검증을 우회하지 않음",
);

// 9월 24일 기준 2개 블록은 월 경계를 넘어 정확히 10월 7일까지다.
equal(initialAnchors(2), ["2026-09-24", "2026-10-01"], "2주 앵커");
const twoWeeks = initialAnchors(2).flatMap(blockDates);
assert(twoWeeks.length === 14, "2주는 14일이어야 함");
assert(
  twoWeeks[0] === "2026-09-24" && twoWeeks.at(-1) === "2026-10-07",
  "9/24~10/7 월 경계",
);
equal(
  UI_SLOT_ORDER,
  ["1", "2", "7", "3", "4", "8"],
  "UI 슬롯 순서",
);
equal(SLOT_INDICES, ["1", "2", "7", "3", "4", "8"], "필수 저장 슬롯");
equal(
  splitDateChunks(blockDates("2026-10-01"), 1).map((chunk) => chunk.length),
  [1, 1, 1, 1, 1, 1, 1],
  "7일을 하루 단위 LLM 청크로 분할",
);
assert(
  staleRunCutoffIso("2026-09-25T10:05:00.000Z") ===
    "2026-09-25T10:00:00.000Z",
  "5분 stale cutoff",
);

// 실제 상태에서 식사명을 감지하고, 없는 상태에서는 기본명을 쓴다.
equal(detectMealLabels({}), ["아침", "점심", "저녁", "야식"], "기본 식사명");
equal(
  detectMealLabels({
    menus: {
      "2026-09": {
        "24|석식|0": "밥",
        "24|야식|0": "밥",
        "24|조식|0": "밥",
        "24|중식|0": "밥",
      },
    },
  }),
  MEALS,
  "상태의 실제 식사명 순서 감지",
);
equal(detectMealLabels({ menus: { "2026-09": { "24|야식|0": "밥" } } }), [
  "아침",
  "점심",
  "저녁",
  "야식",
], "일부 식사명만 있어도 중복 없이 보완");
equal(
  detectMealLabels({
    menus: {
      "2026-10": {
        "1|조식|n": "10",
        "1|중식|n": "20",
        "1|석식|n": "30",
        "1|야식|n": "40",
      },
    },
  }),
  MEALS,
  "식수 키만 있어도 실제 식사명 감지",
);
equal(
  detectMealLabels({
    menus: {
      "2026-10": {
        "1|아침|n": "10",
        "1|점심|n": "20",
        "1|저녁|n": "30",
        "1|야식|n": "40",
        "1|조식|0": "밥",
        "1|중식|0": "밥",
        "1|석식|0": "밥",
        "1|야식|0": "밥",
      },
    },
  }),
  MEALS,
  "대량 n셀보다 실제 음식 셀 식사명을 우선",
);

// 프롬프트에 가격·공장 근무자·공격적 구성·암묵적 쌀밥·JSON 제한이 들어간다.
const prompt = buildPrompt(["2026-09-24"], MEALS, {
  "2026-09-24|조식|2": "수동제육",
});
for (
  const keyword of [
    "10,000원",
    "공장",
    "육류·튀김·볶음·구이",
    "필수 6칸",
    "쌀밥",
    "extras",
    "주류",
    "논알콜/무알콜",
    "맛·포만감",
    "JSON",
    "수동제육",
  ]
) {
  assert(prompt.includes(keyword), `프롬프트 필수 문구 누락: ${keyword}`);
}
assert(
  prompt.indexOf('"7":"메인2"') < prompt.indexOf('"3":"부찬1"'),
  "프롬프트도 canonical UI 순서로 슬롯 제시",
);

// JSON 검증: 정확한 날짜/식사/필수 6칸, 국, extras, 중복, 수동 셀 일치를 확인한다.
const oneDay = fixturePlan(["2026-09-24"]);
const parsed = parseMenuPlanJson(JSON.stringify(oneDay), ["2026-09-24"], MEALS);
assert(
  parsed.days[0].meals[0].slots["7"].includes("고등어구이"),
  "메인찬2 슬롯 파싱",
);

const missingSlot = structuredClone(oneDay);
delete missingSlot.days[0].meals[0].slots["8"];
throws(
  () => parseMenuPlanJson(JSON.stringify(missingSlot), ["2026-09-24"], MEALS),
  /슬롯 키/,
  "누락 슬롯 거절",
);
const duplicate = structuredClone(oneDay);
duplicate.days[0].meals[0].slots["8"] = duplicate.days[0].meals[0].slots["4"];
throws(
  () => parseMenuPlanJson(JSON.stringify(duplicate), ["2026-09-24"], MEALS),
  /중복 음식/,
  "중복 음식 거절",
);
const badSoup = structuredClone(oneDay);
badSoup.days[0].meals[0].slots["1"] = "양배추샐러드";
throws(
  () => parseMenuPlanJson(JSON.stringify(badSoup), ["2026-09-24"], MEALS),
  /슬롯 1에 국/,
  "국이 아닌 필수 슬롯 1 거절",
);
const withExtras = structuredClone(oneDay);
withExtras.days[0].meals[0].extras = ["왕새우튀김", "간장수육"];
const parsedExtras = parseMenuPlanJson(
  JSON.stringify(withExtras),
  ["2026-09-24"],
  MEALS,
);
assert(
  parsedExtras.days[0].meals[0].extras?.join(",") ===
    "왕새우튀김,간장수육",
  "optional extras 1~3개 파싱",
);

// 공장 급식에서는 주류·무알콜 주류형 음료도 필수/추가 칸에 들어갈 수 없다.
for (
  const drink of [
    "맥주",
    "소주",
    "막걸리",
    "와인",
    "위스키",
    "하이볼",
    "Beer",
    "Wine",
    "Heineken",
    "테라",
    "논알콜맥주",
    "무알콜맥주",
    "Heineken 0.0",
  ]
) {
  const alcoholExtra = structuredClone(oneDay);
  alcoholExtra.days[0].meals[0].extras = [drink];
  throws(
    () =>
      parseMenuPlanJson(JSON.stringify(alcoholExtra), ["2026-09-24"], MEALS),
    /주류|급식|술|음료/,
    `주류 extra 거절: ${drink}`,
  );
}
for (const ci of SLOT_INDICES) {
  const alcoholSlot = structuredClone(oneDay);
  alcoholSlot.days[0].meals[0].slots[ci] = "맥주";
  throws(
    () => parseMenuPlanJson(JSON.stringify(alcoholSlot), ["2026-09-24"], MEALS),
    /주류|급식|술|음료/,
    `모든 필수 슬롯에서 주류 거절: ${ci}`,
  );
}
for (const drink of ["보리차", "콜라", "요구르트"]) {
  const softDrink = structuredClone(oneDay);
  softDrink.days[0].meals[0].extras = [drink];
  equal(
    parseMenuPlanJson(JSON.stringify(softDrink), ["2026-09-24"], MEALS)
      .days[0].meals[0].extras,
    [drink],
    `일반 음료는 보존: ${drink}`,
  );
}
for (const dish of ["맥주반죽생선튀김", "와인소스스테이크", "맛술닭조림"]) {
  const cookedDish = structuredClone(oneDay);
  cookedDish.days[0].meals[0].slots["2"] = dish;
  equal(
    parseMenuPlanJson(JSON.stringify(cookedDish), ["2026-09-24"], MEALS)
      .days[0].meals[0].slots["2"],
    dish,
    `주류가 조리 재료인 실제 음식은 보존: ${dish}`,
  );
}
const fixedAlcohol = structuredClone(oneDay);
fixedAlcohol.days[0].meals[0].slots["2"] = "맥주";
throws(
  () =>
    parseMenuPlanJson(JSON.stringify(fixedAlcohol), ["2026-09-24"], MEALS, {
      "2026-09-24|조식|2": "맥주",
    }),
  /주류|급식|술|음료/,
  "금지된 고정 셀은 몰래 바꾸지 않고 생성 전체를 거절",
);
equal(fixedAlcohol.days[0].meals[0].slots["2"], "맥주", "고정 입력 원본 보존");

// 파서를 우회해도 마지막 끼니의 금지 메뉴가 병합 전부를 막아야 한다.
for (const placement of ["required", "extra"]) {
  const bypassPlan = structuredClone(oneDay);
  const lastMeal = bypassPlan.days[0].meals[3];
  if (placement === "required") lastMeal.slots["8"] = "맥주";
  else lastMeal.extras = ["맥주"];
  const untouched: State = {
    menus: { "2026-09": { "24|조식|2": "수동제육", "24|조식|n": "999" } },
    settings: { custom: "보존" },
  };
  const snapshot = structuredClone(untouched);
  throws(
    () =>
      mergeMenuPlan(untouched, bypassPlan, {
        updated: "2026-09-25T01:02:03.000Z",
        model: "fixture",
        runId: "blocked",
        meals: MEALS,
      }),
    /주류|급식|술|음료/,
    `병합 전 금지 메뉴 거절: ${placement}`,
  );
  equal(
    untouched,
    snapshot,
    `거절 시 수동 메뉴·식수·메타 등 전체 상태 보존: ${placement}`,
  );
}
const emptyState: State = { custom: "보존" };
const emptySnapshot = structuredClone(emptyState);
throws(
  () =>
    mergeMenuPlan(emptyState, fixedAlcohol, {
      updated: "2026-09-25T01:02:03.000Z",
      model: "fixture",
      runId: "blocked",
      meals: MEALS,
    }),
  /주류|급식|술|음료/,
  "빈 상태도 금지 메뉴 병합 거절",
);
equal(emptyState, emptySnapshot, "거절 시 빈 menus/menuPlanMeta도 만들지 않음");

const duplicateExtra = structuredClone(oneDay);
duplicateExtra.days[0].meals[0].extras = [
  duplicateExtra.days[0].meals[0].slots["2"],
];
throws(
  () =>
    parseMenuPlanJson(
      JSON.stringify(duplicateExtra),
      ["2026-09-24"],
      MEALS,
    ),
  /중복 음식/,
  "필수 메뉴와 중복 extra 거절",
);
const tooManyExtras = structuredClone(oneDay);
tooManyExtras.days[0].meals[0].extras = ["a", "b", "c", "d"];
throws(
  () =>
    parseMenuPlanJson(
      JSON.stringify(tooManyExtras),
      ["2026-09-24"],
      MEALS,
    ),
  /최대 3개/,
  "extra 4개 거절",
);
throws(
  () => parseMenuPlanJson(JSON.stringify(oneDay), ["2026-09-25"], MEALS),
  /예상하지 않은 날짜/,
  "다른 날짜 거절",
);
throws(
  () =>
    parseMenuPlanJson(JSON.stringify(oneDay), ["2026-09-24"], MEALS, {
      "2026-09-24|조식|2": "수동제육",
    }),
  /수동 입력/,
  "수동 셀 변경 거절",
);

// 병합은 수동 메뉴/식수/원가 정보를 보존하고 AI·사진 계획 메타 및 10,000원 가격을 기록한다.
const state: State = {
  menus: {
    "2026-09": {
      "24|조식|0": "잡곡밥",
      "24|조식|2": "수동제육",
      "24|조식|5": "배추김치",
      "24|조식|6": "사과",
      "24|조식|9": "오이무침",
      "24|조식|10": "수동수육",
      "24|조식|n": "999",
      "24|석식|n": "180",
    },
  },
  settings: {
    meals: {
      조식: { price: 8500, count: 77, cost: 3210 },
      석식: { price: 8500, count: 180, cost: 3210 },
    },
    tickets: { 조식: 8500, legacy: 1234 },
    costs: { keep: true },
  },
};
const updated = "2026-09-25T01:02:03.000Z";
const runId = "00000000-0000-4000-8000-000000000001";
const mergePlan = structuredClone(oneDay);
mergePlan.days[0].meals[0].extras = ["왕새우튀김"];
const changes = mergeMenuPlan(state, mergePlan, {
  updated,
  model: "deepseek-v4-pro",
  runId,
  meals: MEALS,
});
assert(state.menus!["2026-09"]["24|조식|2"] === "수동제육", "수동 메뉴 보존");
assert(
  state.menus!["2026-09"]["24|조식|0"] === "쌀밥" &&
    MEALS.every((meal) => state.menus!["2026-09"][`24|${meal}|0`] === "쌀밥") &&
    changes.rice.length === 4,
  "편집 슬롯 밖 key0을 모든 끼니 쌀밥으로 기본화",
);
equal(
  ["5", "6", "9", "10"].map((ci) => state.menus!["2026-09"][`24|조식|${ci}`]),
  ["배추김치", "사과", "오이무침", "수동수육"],
  "기존 5/6/9 및 >=10 자유 추가메뉴 무손실 보존",
);
assert(
  state.menus!["2026-09"]["24|조식|11"] === "왕새우튀김",
  "AI optional extra는 첫 빈 >=10 인덱스에 추가",
);
assert(state.menus!["2026-09"]["24|조식|n"] === "999", "수동 식수 보존");
assert(state.menus!["2026-09"]["24|중식|n"] === "217", "9/21주 중식 식수");
assert(
  state.menus!["2026-09"]["24|석식|n"] === "228",
  "기본 설정과 같은 기존 식수는 사진 계획으로 교체",
);
equal(state.menuPlanMeta!["2026-09-24|조식"], {
  by: "ai",
  updated,
  model: "deepseek-v4-pro",
  runId,
}, "AI 식단 메타");
assert(
  state.headcountMeta!["2026-09-24|중식"].by === "photo-plan",
  "사진 계획 식수 메타",
);
assert(
  state.headcountMeta!["2026-09-24|중식"].week === "2026-09-21",
  "사진 계획 기준 주",
);
const manualCountState: State = {
  menus: { "2026-09": { "24|조식|n": "120" } },
  settings: { meals: { 조식: { count: 120 } } },
  headcountMeta: {
    "2026-09-24|조식": {
      by: "manual",
      updated,
    },
  },
};
mergeHeadcounts(manualCountState, ["2026-09-24"], MEALS, "later");
assert(
  manualCountState.menus!["2026-09"]["24|조식|n"] === "120",
  "수동 메타가 있는 기본값과 같은 식수도 보존",
);
const legacySeedState: State = {
  menus: { "2026-09": {}, "2026-10": {} },
  settings: {
    meals: Object.fromEntries(MEALS.map((meal) => [meal, { count: 100 }])),
  },
  headcountMeta: {
    "2026-09-25|조식": { by: "manual", updated: "manual" },
  },
};
const legacySeeds = [120, 300, 180, 100];
for (const date of ["2026-09-24", "2026-09-25", "2026-09-30", "2026-10-01"]) {
  const ym = date.slice(0, 7);
  const day = String(Number(date.slice(8)));
  for (let i = 0; i < MEALS.length; i++) {
    legacySeedState.menus![ym][`${day}|${MEALS[i]}|n`] = String(
      legacySeeds[i],
    );
  }
}
mergeHeadcounts(
  legacySeedState,
  ["2026-09-24", "2026-09-25", "2026-09-30", "2026-10-01"],
  MEALS,
  updated,
);
equal(
  MEALS.map((meal) => legacySeedState.menus!["2026-09"][`24|${meal}|n`]),
  ["108", "217", "228", "120"],
  "9/24 메타 없는 legacy seed 4식을 사진 계획으로 교체",
);
equal(
  MEALS.map((meal) => legacySeedState.menus!["2026-09"][`30|${meal}|n`]),
  ["175", "350", "295", "120"],
  "9/30까지 legacy seed를 해당 주차 사진 계획으로 교체",
);
assert(
  legacySeedState.menus!["2026-09"]["25|조식|n"] === "120" &&
    legacySeedState.headcountMeta!["2026-09-25|조식"].by === "manual",
  "legacy seed와 같은 값이어도 manual 메타는 최우선 보존",
);
equal(
  MEALS.slice(0, 3).map((meal) =>
    legacySeedState.menus!["2026-10"][`1|${meal}|n`]
  ),
  ["120", "300", "180"],
  "10/1 이후의 같은 숫자는 legacy seed 규칙으로 교체하지 않음",
);
const settings = state.settings as {
  meals: Record<string, Record<string, unknown>>;
  tickets: Record<string, unknown>;
  costs: Record<string, unknown>;
};
assert(
  settings.meals.조식.price === 10_000 && settings.tickets.조식 === 10_000,
  "조식 가격 10,000원",
);
assert(
  settings.meals.조식.count === 77 && settings.meals.조식.cost === 3210,
  "기존 인원/원가 보존",
);
assert(
  settings.tickets.legacy === 1234 && settings.costs.keep === true,
  "기타 설정 보존",
);
for (const meal of MEALS) {
  assert(
    settings.meals[meal].price === 10_000 && settings.tickets[meal] === 10_000,
    `${meal} 가격 10,000원`,
  );
}
assert(
  changes.added.length === MEALS.length * SLOT_INDICES.length,
  "필수 24칸 중 수동 1칸 제외 + optional extra 1개 추가",
);
assert(changes.prices.length === 8, "4식의 meals/tickets 가격 8개 갱신");

// 같은 결과를 다시 합치면 메뉴·식수·가격 모두 추가되지 않는다.
const second = mergeMenuPlan(state, mergePlan, {
  updated: "later",
  model: "other",
  runId: "other",
  meals: MEALS,
});
assert(
  second.added.length === 0 && Object.keys(second.headcounts).length === 0 &&
    second.prices.length === 0 && second.rice.length === 0,
  "병합 멱등성",
);
assert(
  state.menuPlanMeta!["2026-09-24|조식"].runId === runId,
  "멱등 재실행이 기존 AI 메타를 바꾸지 않음",
);

// 주차별 사진 식수: 9/28주와 10/5주 경계 값도 확인한다.
equal(
  headcountForDate("2026-10-04", 0),
  { count: 175, week: "2026-09-28" },
  "10/4 조식 식수",
);
equal(
  headcountForDate("2026-10-05", 3),
  { count: 250, week: "2026-10-05" },
  "10/5 야식 식수",
);
equal(
  headcountForDate("2026-12-20", 3),
  { count: 45, week: "2026-12-14" },
  "마지막 사진 주차",
);
assert(headcountForDate("2026-12-21", 0) === null, "사진 범위 밖은 식수 없음");
const photoDates = headcountPlanDates();
assert(
  photoDates.length === 88 && photoDates[0] === "2026-09-24" &&
    photoDates.at(-1) === "2026-12-20",
  "사진 계획 전체 유효기간 9/24~12/20",
);
const fullHeadcountState: State = {
  menus: { "2026-09": { "24|조식|n": "999" } },
  headcountMeta: {
    "2026-09-24|조식": { by: "manual", updated: "manual", week: "keep" },
    "2026-09-25|중식": { by: "manual", updated: "manual-meta-only" },
  },
};
const fullHeadcounts = mergeHeadcounts(
  fullHeadcountState,
  photoDates,
  MEALS,
  updated,
);
assert(
  Object.keys(fullHeadcounts).length === photoDates.length * 4 - 2,
  "사진 유효기간 전체 4식 식수 선입력",
);
assert(
  fullHeadcountState.menus!["2026-09"]["24|조식|n"] === "999" &&
    fullHeadcountState.headcountMeta!["2026-09-24|조식"].by === "manual" &&
    fullHeadcountState.headcountMeta!["2026-09-24|조식"].week === "keep",
  "수동 식수와 수동 메타 보존",
);
assert(
  fullHeadcountState.menus!["2026-09"]["25|중식|n"] === undefined &&
    fullHeadcountState.headcountMeta!["2026-09-25|중식"].by === "manual",
  "값이 비어 있어도 수동 식수 메타는 보존",
);
assert(
  menuDates(fullHeadcountState).length === 0 &&
    completeMenuDates(fullHeadcountState, MEALS).length === 0,
  "n-only 날짜는 식단 날짜와 horizon에서 제외",
);
for (const date of photoDates) {
  const ym = date.slice(0, 7);
  const day = String(Number(date.slice(8)));
  for (const meal of MEALS) {
    if (date === "2026-09-25" && meal === "중식") continue;
    assert(
      String(fullHeadcountState.menus![ym][`${day}|${meal}|n`] || "").trim() !==
        "",
      `${date} ${meal} 식수 선입력`,
    );
  }
}
equal(HEADCOUNT_WEEKS, [
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
], "사진 식수 주차표 전체");

// 빈 상태에서 9/25 스케줄은 현재 블록+다음 블록 두 개, 7일 이상 있으면 생성하지 않는다.
equal(
  selectAnchorBlocks({}, "2026-09-25"),
  ["2026-09-24", "2026-10-01"],
  "빈 상태의 7일 horizon",
);
equal(
  selectRunAnchorBlocks({}, "2026-09-25", 2),
  ["2026-09-24"],
  "weeks=2여도 실제 한 호출은 첫 7일 블록만 선택",
);
const bootstrapState: State = {};
const firstBootstrapPlan = fixturePlan(blockDates("2026-09-24"));
mergeMenuPlan(bootstrapState, firstBootstrapPlan, {
  updated,
  model: "model",
  runId: "bootstrap-1",
  meals: MEALS,
});
equal(
  selectRunAnchorBlocks(bootstrapState, "2026-09-25", 2),
  ["2026-10-01"],
  "같은 weeks=2 재호출은 다음 누락 초기 블록 선택",
);
mergeMenuPlan(bootstrapState, fixturePlan(blockDates("2026-10-01")), {
  updated,
  model: "model",
  runId: "bootstrap-2",
  meals: MEALS,
});
equal(
  selectRunAnchorBlocks(bootstrapState, "2026-09-25", 2),
  [],
  "초기 두 블록 저장 뒤 재호출은 멱등 no-op",
);
const octoberOnlyState: State = {};
mergeMenuPlan(octoberOnlyState, fixturePlan(blockDates("2026-10-01")), {
  updated,
  model: "model",
  runId: "october-only",
  meals: MEALS,
});
equal(
  selectRunAnchorBlocks(octoberOnlyState, "2026-09-25", 2),
  ["2026-09-24"],
  "10/1~7이 있어도 weeks=2는 10/8이 아닌 초기 범위 누락만 선택",
);
const legacyIncomplete: State = { menus: {} };
for (const date of twoWeeks) {
  const ym = date.slice(0, 7);
  const day = String(Number(date.slice(8)));
  const month = legacyIncomplete.menus![ym] ||= {};
  for (const meal of MEALS) {
    for (let ci = 0; ci <= 6; ci++) {
      month[`${day}|${meal}|${ci}`] = `${date}-${meal}-${ci}`;
    }
  }
}
assert(
  completeMenuDates(legacyIncomplete, MEALS).length === 0,
  "기존 7슬롯 날짜는 완성 식단일이 아님",
);
equal(selectAnchorBlocks(legacyIncomplete, "2026-09-25"), [
  "2026-09-24",
  "2026-10-01",
], "기존 0~6 식단에서 빠진 메인2·부찬3을 두 블록 모두 보충");
equal(
  selectAnchorBlocks(legacyIncomplete, "2026-09-25", 2),
  ["2026-09-24", "2026-10-01"],
  "최초 2주 요청은 비어 있는 필수 7·8 슬롯만 대상으로 선택",
);
const legacyOctober: State = { menus: { "2026-10": {} } };
for (const date of blockDates("2026-10-01")) {
  const day = String(Number(date.slice(8)));
  for (const meal of MEALS) {
    for (let ci = 0; ci <= 9; ci++) {
      legacyOctober.menus!["2026-10"][`${day}|${meal}|${ci}`] = ci === 0
        ? "잡곡밥"
        : `${date}-${meal}-legacy-${ci}`;
    }
  }
}
const legacyFreeBefore = ["5", "6", "9"].map((ci) =>
  legacyOctober.menus!["2026-10"][`1|조식|${ci}`]
);
const legacyConverted = mergeMenuPlan(legacyOctober, { days: [] }, {
  updated,
  model: "model",
  runId: "legacy-convert",
  meals: MEALS,
});
assert(
  completeMenuDates(legacyOctober, MEALS).length === 7,
  "기존 10월 0~9 데이터는 새 필수 6칸 기준으로 완성 유지",
);
assert(
  legacyConverted.rice.length === 28 &&
    legacyOctober.menus!["2026-10"]["1|조식|0"] === "쌀밥",
  "기존 10월 key0만 쌀밥으로 기본화",
);
equal(
  ["5", "6", "9"].map((ci) => legacyOctober.menus!["2026-10"][`1|조식|${ci}`]),
  legacyFreeBefore,
  "기존 10월 5/6/9는 자유 추가메뉴로 무손실 보존",
);
const complete: State = {};
const fullPlan = fixturePlan(twoWeeks);
mergeMenuPlan(complete, fullPlan, {
  updated,
  model: "model",
  runId,
  meals: MEALS,
});
equal(
  selectAnchorBlocks(complete, "2026-09-25"),
  [],
  "향후 7일 이상이면 미생성",
);
equal(
  selectAnchorBlocks(complete, "2026-10-01"),
  ["2026-10-08"],
  "향후 7일 미만이면 다음 고정 블록",
);
equal(
  selectAnchorBlocks(complete, "2026-09-25", 2),
  [],
  "명시 블록도 완성된 경우 멱등 미생성",
);

// 암호화 형식 왕복.
const secretState = JSON.stringify({
  menus: state.menus,
  message: "한글 왕복",
  nested: [1, 2, 3],
});
const encrypted = await encryptText("test-password", secretState);
const envelope = JSON.parse(encrypted);
assert(
  envelope.v === 2 && envelope.z === 1 && envelope.iter === 150000,
  "암호화 envelope 호환",
);
assert(
  await decryptText("test-password", encrypted) === secretState,
  "암호화 왕복",
);

console.log("MENU_PLAN_OK");

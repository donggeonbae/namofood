// Institutional meal generation: behavior checks without network or live state.
import {
  buildPrompt,
  type MenuPlan,
  mergeMenuPlanDays,
  parseMenuPlanJson,
  type State,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";

const MEALS = ["조식", "중식", "석식", "야식"];
const DATE = "2026-10-15";
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function rejects(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (error) {
    assert(pattern.test(String(error)), `unexpected error: ${error}`);
    return;
  }
  throw new Error("invalid institutional menu was accepted");
}
function partial(main: string, extras: string[] = []): MenuPlan {
  return {
    days: [{
      date: DATE,
      meals: [{ meal: "중식", slots: { "2": main }, extras }],
    }],
  };
}
function full(date = DATE): MenuPlan {
  return {
    days: [{
      date,
      meals: MEALS.map((meal, i) => ({
        meal,
        slots: {
          "1": `시험국-${date}-${i}`,
          "2": ["제육볶음", "소불고기", "닭갈비", "돼지갈비찜"][i] +
            `-${date}-${i}`,
          "7": ["고등어구이", "생선까스", "삼치조림", "오징어튀김"][i] +
            `-${date}-${i}`,
          "3": ["계란말이", "두부조림", "군만두", "두부고추장조림"][i] +
            `-${date}-${i}`,
          "4": `시험부찬-${date}-${i}-B`,
          "8": "배추김치",
        },
        extras: [],
      })),
    }],
  };
}

const cases: Array<[string, () => void]> = [
  ["past main alias at inclusive seven-day boundary", () => {
    rejects(
      () =>
        validateMenuVariety({
          menus: { "2026-10": { "8|조식|2": "제육볶음" } },
        }, partial("돼지고기고추장볶음")),
      /7일.*중복/,
    );
  }],
  ["future extra alias at inclusive seven-day boundary", () => {
    rejects(
      () =>
        validateMenuVariety({
          menus: { "2026-10": { "22|야식|10": "돈육고추장볶음" } },
        }, partial("제육볶음")),
      /7일.*중복/,
    );
  }],
  ["past extra alias at inclusive seven-day boundary", () => {
    rejects(
      () =>
        validateMenuVariety({
          menus: { "2026-10": { "8|조식|11": "돼지고기고추장볶음" } },
        }, partial("제육볶음")),
      /7일.*중복/,
    );
  }],
  ["same dish beyond seven days can return", () => {
    validateMenuVariety({
      menus: {
        "2026-10": { "7|조식|10": "돈육고추장볶음", "23|야식|2": "제육볶음" },
      },
    }, partial("돼지고기고추장볶음"));
  }],
  ["proposed extras participate in cross-date main checks", () => {
    const plan = partial("검증메인", ["돈육고추장볶음"]);
    plan.days.push({
      date: "2026-10-16",
      meals: [{ meal: "야식", slots: { "2": "제육볶음" } }],
    });
    rejects(() => validateMenuVariety({}, plan), /7일.*중복/);
  }],
  ["proposed main extra is checked against stored meals", () => {
    rejects(
      () =>
        validateMenuVariety({
          menus: { "2026-10": { "14|조식|2": "제육볶음" } },
        }, partial("검증메인", ["돼지고기고추장볶음"])),
      /7일.*중복/,
    );
  }],
  ["aliases cannot duplicate a dish within a meal", () => {
    rejects(
      () =>
        validateMenuVariety({}, partial("제육볶음", ["돼지고기고추장볶음"])),
      /중복/,
    );
  }],
  ["same soup across four meals is rejected", () => {
    const plan = full();
    plan.days[0].meals.forEach((meal) => meal.slots["1"] = "소고기무국");
    rejects(() => validateMenuVariety({}, plan), /국.*중복|국.*반복/);
  }],
  ["non-kimchi side repeats across meals are rejected", () => {
    const plan = full();
    plan.days[0].meals[0].slots["3"] = "콩나물무침";
    plan.days[0].meals[1].slots["4"] = "콩나물무침";
    rejects(() => validateMenuVariety({}, plan), /부찬.*중복|부찬.*반복/);
  }],
  ["frequently repeated soup across nearby days is rejected", () => {
    const plan = partial("검증메인");
    plan.days[0].meals[0].slots["1"] = "소고기무국";
    rejects(
      () =>
        validateMenuVariety({
          menus: {
            "2026-10": { "13|중식|1": "소고기무국", "14|석식|1": "소고기무국" },
          },
        }, plan),
      /국.*반복/,
    );
  }],
  ["frequently repeated side across nearby days is rejected", () => {
    const plan = partial("검증메인");
    plan.days[0].meals[0].slots["3"] = "콩나물무침";
    rejects(
      () =>
        validateMenuVariety({
          menus: {
            "2026-10": { "12|중식|3": "콩나물무침", "18|석식|4": "콩나물무침" },
          },
        }, plan),
      /부찬.*반복/,
    );
  }],
  [
    "side occurrences outside the seven-day local window do not overblock",
    () => {
      const plan = partial("검증메인");
      plan.days[0].meals[0].slots["3"] = "콩나물무침";
      validateMenuVariety({
        menus: {
          "2026-10": { "11|중식|3": "콩나물무침", "19|석식|4": "콩나물무침" },
        },
      }, plan);
    },
  ],
  ["candidate side extras contribute to daily variety", () => {
    const plan = partial("검증메인", ["시금치나물"]);
    plan.days[0].meals.push({ meal: "야식", slots: { "4": "시금치나물" } });
    rejects(() => validateMenuVariety({}, plan), /부찬.*중복/);
  }],
  ["kimchi and implicit rice remain repetition exemptions", () => {
    const state: State = {
      menus: {
        "2026-10": {
          "14|조식|0": "쌀밥",
          "14|조식|8": "배추김치",
          "13|야식|8": "배추김치",
        },
      },
    };
    validateMenuVariety(state, full());
  }],
  ["pork soy and spicy dishes are materially different", () => {
    const state: State = {
      menus: { "2026-10": { "14|조식|2": "돼지간장불고기" } },
    };
    validateMenuVariety(state, partial("제육볶음"));
  }],
  ["manual original dishes remain exempt", () => {
    const state: State = {
      menus: {
        "2026-10": {
          "8|조식|2": "제육볶음",
          "15|중식|2": "돼지고기고추장볶음",
        },
      },
    };
    validateMenuVariety(state, partial("돼지고기고추장볶음"));
  }],
  ["fixed manual soup and side repetitions remain exempt", () => {
    const plan = full();
    const state: State = { menus: { "2026-10": {} } };
    plan.days[0].meals.forEach((meal) => {
      meal.slots["1"] = "소고기무국";
      meal.slots["3"] = "콩나물무침";
      state.menus!["2026-10"][`15|${meal.meal}|1`] = "소고기무국";
      state.menus!["2026-10"][`15|${meal.meal}|3`] = "콩나물무침";
    });
    validateMenuVariety(state, plan);
  }],
  ["one meal cannot use two mains with the same full cooking profile", () => {
    const plan = partial("고등어구이");
    plan.days[0].meals[0].slots["7"] = "삼치구이";
    rejects(() => validateMenuVariety({}, plan), /두 메인.*조합/);
  }],
  ["full cooking-profile recurrence is capped within one day", () => {
    const plan = partial("고등어구이");
    plan.days[0].meals.push({ meal: "석식", slots: { "2": "삼치구이" } });
    validateMenuVariety({}, plan);
    plan.days[0].meals.push({ meal: "야식", slots: { "2": "가자미구이" } });
    rejects(() => validateMenuVariety({}, plan), /하루.*조리법.*최대 2/);
  }],
  ["a known side cannot substitute for a substantial main", () => {
    for (const side of ["배추김치", "시금치나물", "콩나물무침"]) {
      const plan = full();
      plan.days[0].meals[0].slots["2"] = side;
      if (side === "배추김치") plan.days[0].meals[0].slots["8"] = "깍두기";
      rejects(
        () => parseMenuPlanJson(JSON.stringify(plan), [DATE], MEALS),
        /메인.*부찬|메인.*실속|메인.*주찬/,
      );
    }
  }],
  ["recognizable generated side set includes kimchi", () => {
    const plan = full();
    Object.assign(plan.days[0].meals[0].slots, {
      "3": "감자조림",
      "4": "콩나물무침",
      "8": "어묵볶음",
    });
    plan.days[0].meals[0].extras = ["닭강정"];
    rejects(
      () => parseMenuPlanJson(JSON.stringify(plan), [DATE], MEALS),
      /부찬.*김치/,
    );
    rejects(() => validateMenuVariety({}, plan), /부찬.*김치/);
  }],
  ["fixed manual three-side set without kimchi remains preserved", () => {
    const plan = full();
    Object.assign(plan.days[0].meals[0].slots, {
      "3": "감자조림",
      "4": "콩나물무침",
      "8": "어묵볶음",
    });
    plan.days[0].meals[0].extras = ["닭강정"];
    const fixed = {
      [`${DATE}|조식|3`]: "감자조림",
      [`${DATE}|조식|4`]: "콩나물무침",
      [`${DATE}|조식|8`]: "어묵볶음",
    };
    parseMenuPlanJson(JSON.stringify(plan), [DATE], MEALS, fixed);
    validateMenuVariety({
      menus: {
        "2026-10": {
          "15|조식|3": "감자조림",
          "15|조식|4": "콩나물무침",
          "15|조식|8": "어묵볶음",
        },
      },
    }, plan);
  }],
  ["fixed manual side in a main slot is preserved", () => {
    const plan = full();
    plan.days[0].meals[0].slots["2"] = "시금치나물";
    plan.days[0].meals[0].extras = ["닭강정"];
    parseMenuPlanJson(JSON.stringify(plan), [DATE], MEALS, {
      [`${DATE}|조식|2`]: "시금치나물",
    });
  }],
  [
    "two preexisting manual aliases are preserved while new cells are filled",
    () => {
      const plan = full();
      const meal = plan.days[0].meals[0];
      meal.slots["2"] = "제육볶음";
      meal.slots["7"] = "돈육고추장볶음";
      meal.extras = ["닭강정"];
      parseMenuPlanJson(JSON.stringify(plan), [DATE], MEALS, {
        [`${DATE}|조식|2`]: "제육볶음",
        [`${DATE}|조식|7`]: "돈육고추장볶음",
      });
      const state: State = {
        menus: {
          "2026-10": { "15|조식|2": "제육볶음", "15|조식|7": "돈육고추장볶음" },
        },
      };
      const merged = mergeMenuPlanDays(state, plan, {
        updated: "2026-10-08T00:00:00.000Z",
        model: "offline",
        runId: "offline",
        meals: MEALS,
        headcountDates: [],
      });
      assert(
        merged.succeededDates.join() === DATE,
        "preexisting manual repetition must not prevent filling unrelated missing cells",
      );
      assert(
        merged.state.menus!["2026-10"]["15|조식|7"] === "돈육고추장볶음",
        "manual alias remains exact",
      );
    },
  ],
  ["parser rejects aliases repeated in two main slots", () => {
    const plan = full();
    plan.days[0].meals[0].slots["2"] = "제육볶음";
    plan.days[0].meals[0].slots["7"] = "돈육고추장볶음";
    rejects(
      () => parseMenuPlanJson(JSON.stringify(plan), [DATE], MEALS),
      /중복 음식/,
    );
  }],
  [
    "validator also guards a known side in a main when the parser is bypassed",
    () => {
      rejects(
        () => validateMenuVariety({}, partial("콩나물무침")),
        /메인.*주찬/,
      );
    },
  ],
  ["recognizable varied premium fixture dishes remain accepted", () => {
    const plan = full();
    parseMenuPlanJson(JSON.stringify(plan), [DATE], MEALS);
    validateMenuVariety({}, plan);
  }],
  ["bad day is isolated and manual headcount remains intact", () => {
    const bad = full();
    bad.days[0].meals[0].slots["2"] = "제육볶음";
    const good = full("2026-10-16");
    good.days[0].meals[0].extras = ["닭강정"];
    const input: State = {
      menus: {
        "2026-10": {
          "14|조식|10": "돈육고추장볶음",
          "16|조식|2": "수동고정메인",
          "16|조식|n": "777",
        },
      },
      headcountMeta: { "2026-10-16|조식": { by: "manual", updated: "keep" } },
    };
    const before = JSON.stringify(input);
    const merged = mergeMenuPlanDays(input, {
      days: [...bad.days, ...good.days],
    }, {
      updated: "2026-10-08T00:00:00.000Z",
      model: "offline",
      runId: "offline",
      meals: MEALS,
      headcountDates: [],
    });
    assert(
      merged.succeededDates.join() === "2026-10-16",
      "valid day must survive alias conflict in other day",
    );
    assert(merged.failedDates[0]?.date === DATE, "failed date is identified");
    assert(
      merged.state.menus!["2026-10"]["16|조식|2"] === "수동고정메인",
      "manual dish preserved",
    );
    assert(
      merged.state.menus!["2026-10"]["16|조식|n"] === "777",
      "manual headcount preserved",
    );
    assert(JSON.stringify(input) === before, "input state must not mutate");
    assert(
      !Object.keys(merged.state.menus!["2026-10"]).some((key) =>
        key.startsWith("15|")
      ),
      "failed day has no partial menu writes",
    );
  }],
  ["prompt makes industrial meal composition and correction concrete", () => {
    const prompt = buildPrompt(
      [DATE],
      MEALS,
      {},
      {},
      "국 하루 중복 소고기무국",
      '{"days":[]}',
    );
    for (
      const term of [
        "함바",
        "회전솥",
        "스팀",
        "주찬",
        "배추김치",
        "가정식",
        "국 하루 중복 소고기무국",
      ]
    ) {
      assert(prompt.includes(term), `missing prompt term ${term}`);
    }
  }],
];

const failures: string[] = [];
for (const [label, check] of cases) {
  try {
    check();
  } catch (error) {
    failures.push(`${label}: ${String(error)}`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(`INSTITUTIONAL_MENU_OK (${cases.length} behavior checks)`);

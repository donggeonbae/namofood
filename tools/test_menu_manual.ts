// The edited operating menus, not generic AI meal ideas, define the premium bar.
// Offline behavior checks: no production state, network, or credentials.
import {
  buildPrompt,
  type MenuPlan,
  mergeMenuPlan,
  parseMenuPlanJson,
  type State,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  createPremiumDishProfiler,
  MENU_MANUAL_VERSION,
  menuManualViolations,
  premiumDishProfile,
} from "../supabase/functions/_shared/menu-manual.ts";

const DATE = "2026-10-23";
const MEALS = ["조식", "중식", "석식", "야식"];
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string) {
  try {
    fn();
  } catch (error) {
    assert(pattern.test(String(error)), `${message}: unexpected ${error}`);
    return;
  }
  throw new Error(`${message}: invalid menu accepted`);
}
function plan(extras: string[] = []): MenuPlan {
  return {
    days: [{
      date: DATE,
      meals: MEALS.map((meal) => ({
        meal,
        slots: {
          "1": "소고기무국",
          "2": "제육볶음",
          "7": "고등어구이",
          "3": "감자조림",
          "4": "콩나물무침",
          "8": "배추김치",
        },
        extras,
      })),
    }],
  };
}

// Discriminating RED: the previous parser accepted a two-main meal even with
// only inexpensive vegetables, starch and dessert as its additional offerings.
rejects(
  () => parseMenuPlanJson(JSON.stringify(plan()), [DATE], MEALS),
  /메인.*3|추가.*주찬|메인급/,
  "a fully generated premium meal needs a third substantial dish",
);
for (const extras of [["감자튀김"], ["시금치나물"], ["사과", "요구르트"]]) {
  rejects(
    () => parseMenuPlanJson(JSON.stringify(plan(extras)), [DATE], MEALS),
    /메인.*3|추가.*주찬|메인급/,
    "vegetables, fries and dessert cannot be the third main",
  );
}

parseMenuPlanJson(JSON.stringify(plan(["닭강정"])), [DATE], MEALS);
const upgradedSide = plan();
upgradedSide.days[0].meals.forEach((meal) => meal.slots["3"] = "닭강정");
parseMenuPlanJson(JSON.stringify(upgradedSide), [DATE], MEALS);
const editedExample = plan();
Object.assign(editedExample.days[0].meals[0].slots, {
  "2": "고등어구이",
  "7": "위샹로우스",
  "3": "닭강정",
});
editedExample.days[0].meals.slice(1).forEach((meal) =>
  meal.extras = ["왕교자튀김"]
);
parseMenuPlanJson(JSON.stringify(editedExample), [DATE], MEALS);

const plantMains = plan(["닭강정"]);
plantMains.days[0].meals[0].slots["2"] = "계란말이";
plantMains.days[0].meals[0].slots["7"] = "두부조림";
rejects(
  () => parseMenuPlanJson(JSON.stringify(plantMains), [DATE], MEALS),
  /최소|적어도|확실한 주찬/,
  "a protein extra cannot disguise two non-anchor mains",
);
const unknownMain = plan(["닭강정"]);
unknownMain.days[0].meals[0].slots["2"] = "시험메인알수없음";
rejects(
  () => parseMenuPlanJson(JSON.stringify(unknownMain), [DATE], MEALS),
  /메인.*주찬/,
  "unknown main title fails closed",
);

function recipeState(
  menu: string,
  ingredients: Array<[string, number]>,
  comp = "주찬",
): State {
  return {
    recipes: ingredients.map(([item, qty]) => ({
      menu,
      item,
      qty,
      unit: "g",
      comp,
    })),
    methods: { [menu]: "회전솥으로 대량 조리 후 밧드 배식" },
  };
}
const garnish = recipeState("제육볶음", [["돼지고기", 3], ["양배추", 120]]);
assert(
  !premiumDishProfile("제육볶음", garnish).substantial,
  "tiny meat garnish cannot qualify even under a familiar main name",
);
const carrotTofu = recipeState(
  "당근두부무침",
  [["당근", 45], ["두부", 40]],
  "부찬",
);
assert(
  !premiumDishProfile("당근두부무침", carrotTofu).substantial,
  "actual carrot45+tofu40 side is not an additional main",
);
for (
  const bad of [
    "콜라",
    "사이다",
    "오징어젓",
    "불닭볶음면",
    "불고기덮밥",
    "임의음식",
  ]
) {
  const invalidRecipe = recipeState(bad, [["돼지고기", 120]]);
  assert(
    !premiumDishProfile(bad, invalidRecipe).substantial,
    `corrupt recipe labeling must never promote ${bad}`,
  );
}
for (
  const [menu, item] of [
    ["도미무조림", "도미"],
    ["열기무조림", "열기"],
    ["메기매운찜", "메기"],
    ["차돌박이구이", "차돌박이"],
    ["가자미콩나물찜", "가자미"],
    ["아귀콩나물찜", "아귀"],
    ["굴전", "굴"],
    ["황태양념구이", "황태"],
    ["북어구이", "북어"],
    ["소고기장조림", "홍두깨살"],
    ["돼지고기묵은지찜", "돼지고기"],
    ["오리고기배추찜", "오리고기"],
    ["닭숙주찜", "닭정육"],
    ["소고기청경채볶음", "소고기"],
    ["경장육슬", "돼지고기"],
    ["동파육", "돼지고기"],
    ["꿔바로우", "돼지고기"],
  ]
) {
  const realMain = recipeState(menu, [[item, 120], ["양배추", 200]]);
  const profile = premiumDishProfile(menu, realMain);
  assert(
    profile.substantial && profile.anchor,
    `${menu} remains a main even with plenty of vegetables`,
  );
}
const unresolved = {
  ...recipeState("닭강정", [["닭고기", 120]]),
  recipeAsk: { 닭강정: { question: "검토 필요" } },
};
assert(
  !premiumDishProfile("닭강정", unresolved).substantial,
  "unresolved recipe is never a generation candidate",
);
const noMethod = {
  recipes: [{ menu: "닭강정", item: "닭고기", qty: 120, unit: "g" }],
};
assert(
  !premiumDishProfile("닭강정", noMethod).substantial,
  "ingredient rows without a method do not masquerade as a ready recipe",
);

// Exact production dishes: preserve valid existing mains instead of replacing
// them merely because a familiar cooking/title form was absent from the parser.
for (
  const [menu, items] of [
    ["치킨마요덮밥토핑", [["순살치킨", 120], ["달걀", 50]]],
    ["두부부침", [["두부", 160], ["달걀액", 25]]],
    ["배추고기찜", [["돼지다짐육", 85], ["배추", 75], ["두부", 20]]],
  ] as Array<[string, Array<[string, number]>]>
) {
  const profile = premiumDishProfile(menu, recipeState(menu, items));
  assert(
    profile.substantial,
    `${menu}: a valid actual protein-centered cooked dish is preserved`,
  );
  if (menu !== "두부부침") {
    assert(
      profile.anchor,
      `${menu}: its anchor comes from actual meat evidence`,
    );
  }
}
assert(
  !premiumDishProfile("배추고기찜").anchor &&
    !premiumDishProfile("배추고기찜").substantial,
  "generic meat title without a recipe is not invented into a main",
);
for (
  const [menu, items] of [
    ["치킨마요덮밥토핑", [["닭고기", 3], ["달걀", 5], ["양배추", 80]]],
    ["두부부침", [["두부", 20], ["양배추", 80]]],
    ["배추고기찜", [["돼지다짐육", 3], ["배추", 75], ["두부", 20]]],
    ["감자토핑", [["돼지고기", 120]]],
  ] as Array<[string, Array<[string, number]>]>
) {
  assert(
    !premiumDishProfile(menu, recipeState(menu, items)).substantial,
    `${menu}: title recognition cannot promote garnish or an unrelated topping`,
  );
}

const fixedKimchi = { [`${DATE}|조식|8`]: "배추김치" };
rejects(
  () => parseMenuPlanJson(JSON.stringify(plan()), [DATE], MEALS, fixedKimchi),
  /메인급.*3/,
  "a fixed side cannot disable the quality floor for a new meal",
);
const entirelyFixed = Object.fromEntries(
  plan().days[0].meals.flatMap((meal) =>
    Object.entries(meal.slots).map((
      [slot, name],
    ) => [`${DATE}|${meal.meal}|${slot}`, name])
  ),
);
parseMenuPlanJson(JSON.stringify(plan()), [DATE], MEALS, entirelyFixed);
const stateWithExtra: State = {
  menus: { "2026-10": { "23|조식|10": "닭강정" } },
};
const effectiveExistingExtra = plan(["계란말이"]);
effectiveExistingExtra.days[0].meals[0].extras = [];
const frozenExtra = JSON.stringify(stateWithExtra.menus);
mergeMenuPlan(stateWithExtra, effectiveExistingExtra, {
  updated: "offline",
  model: "offline",
  runId: "offline",
  meals: MEALS,
  headcountDates: [],
});
assert(
  stateWithExtra.menus!["2026-10"]["23|조식|10"] === "닭강정" &&
    frozenExtra.includes("닭강정"),
  "existing extra counts and remains intact",
);

const recipeBacked = recipeState("소고기청경채볶음", [["소고기", 120], [
  "청경채",
  200,
]]);
recipeBacked.menus = { "2026-10": { "22|조식|10": "소고기청경채볶음" } };
rejects(
  () =>
    validateMenuVariety(recipeBacked, {
      days: [{
        date: DATE,
        meals: [{
          meal: "중식",
          slots: { "2": "닭갈비" },
          extras: ["소고기청경채볶음"],
        }],
      }],
    }),
  /7일.*중복/,
  "an unfamiliar recipe-backed third main participates in adjacent-week variety",
);
const proteinSide: State = { menus: { "2026-10": { "22|조식|3": "닭강정" } } };
rejects(
  () =>
    validateMenuVariety(proteinSide, {
      days: [{
        date: DATE,
        meals: [{ meal: "중식", slots: { "2": "닭강정" } }],
      }],
    }),
  /7일.*중복/,
  "third mains in side columns also participate in adjacent-week checks",
);

const prompt = buildPrompt([DATE], MEALS);
assert(
  prompt.includes(MENU_MANUAL_VERSION) &&
    prompt.includes("운영자가 실제 수정") &&
    prompt.includes("메인급 음식이 최소 3") &&
    !prompt.includes("extras는 없어도 되며"),
  "the manual, not a generic AI buffet, is authoritative in the prompt",
);

// 827 recipe menus and thousands of historical cells must not trigger a full
// recipe scan per repeated cell/profile lookup. This snapshot-local index is
// deliberately discarded after validation; manual recipe edits get fresh data.
const large: State = { recipes: [], methods: {}, menus: { "2026-10": {} } };
const rows = large.recipes as Array<Record<string, unknown>>;
const methods = large.methods as Record<string, string>;
for (let i = 0; i < 827; i++) {
  const name = `소고기청경채볶음-${i}`;
  rows.push({ menu: name, item: "소고기", qty: 120, unit: "g" });
  methods[name] = "회전솥 조리";
}
for (let i = 0; i < 3927; i++) {
  large.menus!["2026-10"][`1|과거${i}|10`] = `소고기청경채볶음-${i % 827}`;
}
const started = performance.now();
const indexed = createPremiumDishProfiler(large);
for (let i = 0; i < 10000; i++) {
  assert(
    indexed(`소고기청경채볶음-${i % 827}`).substantial,
    "indexed registered recipe remains recognized",
  );
}
validateMenuVariety(large, {
  days: [{
    date: DATE,
    meals: [{ meal: "중식", slots: { "2": "닭갈비" }, extras: ["왕교자튀김"] }],
  }],
});
assert(
  performance.now() - started < 5000,
  "production-sized profile lookup and variety must finish well within the Edge time budget",
);

console.log(
  `MENU_MANUAL_PROFILE_INDEX_MS=${Math.round(performance.now() - started)}`,
);

console.log("MENU_MANUAL_OK");

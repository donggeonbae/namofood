import {
  buildPrompt,
  type MenuPlan,
  type State,
  surroundingMenuCells,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
function assert(ok: unknown, message: string) {
  if (!ok) throw new Error(message);
}
const state: State = {
  menus: {
    "2026-09": {
      "23|중식|2": "돈까스",
      "22|중식|2": "범위밖",
      "30|조식|0": "쌀밥",
      "30|조식|n": 100,
    },
    "2026-10": { "7|야식|10": "제육볶음", "8|중식|2": "미래범위밖" },
  },
};
const context = surroundingMenuCells(state, ["2026-09-30"], [
  "조식",
  "중식",
  "석식",
  "야식",
]);
assert(
  Object.values(context).includes("돈까스") &&
    Object.values(context).includes("제육볶음"),
  "both inclusive week boundaries and extras",
);
assert(
  !Object.values(context).includes("범위밖") &&
    !Object.values(context).includes("미래범위밖") &&
    !Object.values(context).includes("쌀밥"),
  "exclude out-of-window/rice/counts",
);
const plan = (dish: string): MenuPlan => ({
  days: [{
    date: "2026-09-30",
    meals: [{
      meal: "중식",
      slots: { "2": dish, "7": "고등어구이", "3": "김치" },
    }],
  }],
});
for (const dish of ["돈 까스", "제육볶음"]) {
  let rejected = false;
  try {
    validateMenuVariety(state, plan(dish));
  } catch {
    rejected = true;
  }
  assert(rejected, "reject past/future duplicate main " + dish);
}
validateMenuVariety(state, plan("닭갈비"));
const manual = structuredClone(state);
manual.menus!["2026-09"]["30|중식|2"] = "돈까스";
validateMenuVariety(manual, plan("돈까스"));
const cross: MenuPlan = {
  days: [...plan("닭갈비").days, {
    date: "2026-10-01",
    meals: [{ meal: "야식", slots: { "2": "닭갈비" } }],
  }],
};
let rejected = false;
try {
  validateMenuVariety(state, cross);
} catch {
  rejected = true;
}
assert(rejected, "cross-day generated main collision");
const prompt = buildPrompt(
  ["2026-09-30"],
  ["조식", "중식", "석식", "야식"],
  {},
  context,
);
assert(
  prompt.includes("2026-10-07|야식|10") && prompt.includes("조리법"),
  "prompt receives future week and similarity rules",
);
console.log("MENU_VARIETY_OK");

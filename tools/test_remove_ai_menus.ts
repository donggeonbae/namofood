import { planAIRetirement } from "./remove_ai_menus.ts";
import type { State } from "../supabase/functions/nmf-menu-plan/lib.ts";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const before: State = {
  menus: {
    "2026-09": {
      "24|중식|2": "AI제육",
      "24|중식|8": "AI김치",
      "24|중식|n": "300",
      "24|중식|0": "쌀밥",
      "25|중식|2": "직접입력",
    },
    "2026-10": {
      "14|석식|2": "AI닭고기",
      "14|석식|11": "AI튀김",
      "14|석식|n": "211",
      "15|중식|2": "사용자가수정한식단",
    },
  },
  menuPlanMeta: {
    "2026-09-24|중식": {
      by: "ai",
      runId: "old",
      model: "test",
      updated: "old",
    },
    "2026-10-14|석식": {
      by: "ai",
      runId: "future",
      model: "test",
      updated: "new",
    },
  },
  headcountMeta: { "2026-10-14|석식": { by: "manual", updated: "keep" } },
  recipes: [{ menu: "AI닭고기", item: "닭", qty: 100 }],
  recipeMeta: { AI닭고기: { by: "ai" } },
  methods: { AI닭고기: "그대로" },
  settings: { meals: { 중식: { count: 300 } } },
  staff: [{ id: "fixture", name: "예시" }],
  roster: { keep: true },
};
const snapshot = JSON.stringify(before), at = "2026-10-08T12:00:00.000Z";
const result = planAIRetirement(before, at);
if (
  JSON.stringify(before) !== snapshot || result.removedMeals.length !== 2 ||
  result.removedCells.length !== 4
) {
  throw new Error(
    "Retirement must target all and only marked AI meals without mutating input",
  );
}
const expected = {
  "2026-09": {
    "24|중식|n": "300",
    "24|중식|0": "쌀밥",
    "25|중식|2": "직접입력",
  },
  "2026-10": { "14|석식|n": "211", "15|중식|2": "사용자가수정한식단" },
};
if (
  !same(result.after.menus, expected) ||
  Object.keys(result.after.menuPlanMeta || {}).length
) throw new Error("AI foods must be absent, manual foods/counts/rice retained");
for (
  const key of [
    "headcountMeta",
    "recipes",
    "recipeMeta",
    "methods",
    "settings",
    "staff",
    "roster",
  ]
) {
  if (!same(before[key], result.after[key])) {
    throw new Error(`Unrelated data changed: ${key}`);
  }
}
const policy = result.after.menuAutomation as {
  removedCells: Record<string, Record<string, unknown>>;
};
if (policy.removedCells["2026-10"]["14|석식|11"] !== "AI튀김") {
  throw new Error("Exact-value deletion provenance missing");
}
const repeat = planAIRetirement(result.after, "2026-10-09T12:00:00.000Z");
if (
  repeat.changed || repeat.removedMeals.length || repeat.removedCells.length
) throw new Error("Retirement must be idempotent");
const edited = structuredClone(result.after);
edited.menus!["2026-10"]["14|석식|2"] = "AI닭고기";
const preserve = planAIRetirement(edited, "2026-10-09T12:00:00.000Z");
if (preserve.after.menus!["2026-10"]["14|석식|2"] !== "AI닭고기") {
  throw new Error(
    "A subsequent manual selection of the same name is not AI-generated",
  );
}
console.log(
  "AI_MENU_RETIREMENT_OK all-dates AI only, counts/rice/recipes/manual preserved, exact tombstones, idempotent",
);

// Whole-window capacity check: reviewed dishes only, no cloud or credentials.
import {
  SLOT_INDICES,
  type State,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  createPremiumDishProfiler,
  menuManualViolations,
} from "../supabase/functions/_shared/menu-manual.ts";
import { INSTITUTIONAL_CATALOG } from "./institutional_catalog.ts";
import {
  type OwnershipProofs,
  planInstitutionalRefresh,
} from "./refresh_institutional_menus.ts";

const before: State = {
  menus: { "2026-10": {} },
  menuPlanMeta: {},
  recipes: [],
};
const proof: OwnershipProofs = { runAdded: { seed: [] } };
let meals = 0;
for (
  const day of [
    8,
    ...Array.from({ length: 12 }, (_, index) => index + 11),
  ]
) {
  for (const meal of ["조식", "중식", "석식", "야식"]) {
    if (day === 8 && ["석식", "야식"].includes(meal)) continue;
    if (day === 12 && meal !== "야식") continue;
    const date = `2026-10-${String(day).padStart(2, "0")}`,
      key = `${date}|${meal}`;
    before.menuPlanMeta![key] = {
      by: "ai",
      runId: "seed",
      updated: "keep",
      model: "old",
    };
    for (const slot of [...SLOT_INDICES, "10"]) {
      before.menus!["2026-10"][`${day}|${meal}|${slot}`] =
        `검증할이전AI-${day}-${meal}-${slot}`;
      proof.runAdded.seed.push(`${key}|${slot}`);
    }
    before.menus!["2026-10"][`${day}|${meal}|n`] = "300";
    before.menus!["2026-10"][`${day}|${meal}|0`] = "쌀밥";
    meals++;
  }
}
const started = performance.now();
const seeded = planInstitutionalRefresh(before, INSTITUTIONAL_CATALOG, proof, {
  today: "2026-10-07",
  updated: "2026-10-08T03:00:00.000Z",
  runId: "reviewed-seed",
});
// Same 827 menu-name scale as production; unreviewed positive recipes exist but
// cannot expand the approved automatic-composition source set.
const state = seeded.after;
const names = new Set(
  (state.recipes as Array<{ menu: string }>).map((row) => row.menu),
);
const rows = state.recipes as Array<Record<string, unknown>>;
const methods = state.methods as Record<string, string>;
for (let index = 0; names.size < 827; index++) {
  const menu = `검증하지않은AI단백질찬-${index}`;
  rows.push({ menu, item: "돼지고기", qty: 140, unit: "g", comp: "주찬" });
  methods[menu] =
    "등록된 기존 레시피여도 검토되지 않은 조합은 자동 편성에 사용하지 않는다.";
  names.add(menu);
}
// The old two-main seed can legitimately produce two supporting proteins with
// no fresh meat/fish anchor. Normalize that fixture preparation—not the repair
// assertion—to model production's 47 already-valid primary pairs. Every seeded
// replacement is a registered reviewed fresh main and passes real ±7-day and
// daily-profile variety validation before this test starts its policy repair.
const profile = createPremiumDishProfiler(state);
const freshMains = INSTITUTIONAL_CATALOG.filter((entry) =>
  entry.role === "main" && profile(entry.recipe.menu).anchor
);
let preparedPrimaryRepairs = 0;
const primarySnapshot = new Map<string, unknown>();
for (const mealKey of seeded.refreshedMeals) {
  const [date, meal] = mealKey.split("|");
  const day = Number(date.split("-")[2]);
  const month = state.menus!["2026-10"];
  const values = () =>
    Object.fromEntries(
      SLOT_INDICES.map((
        slot,
      ) => [slot, String(month[`${day}|${meal}|${slot}`])]),
    );
  const slots = values();
  const deficient = ["2", "7"].filter((slot) =>
    !profile(slots[slot]).substantial
  );
  if (
    !deficient.length &&
    ![slots["2"], slots["7"]].some((dish) => profile(dish).anchor)
  ) deficient.push("7");
  for (const slot of deficient) {
    const context: State = { ...state, menus: structuredClone(state.menus) };
    delete context.menus!["2026-10"][`${day}|${meal}|${slot}`];
    const extras = Object.entries(month).filter(([key]) =>
      key.startsWith(`${day}|${meal}|`) && /^\d+$/.test(key.split("|")[2]) &&
      Number(key.split("|")[2]) >= 10
    ).map(([, value]) => String(value));
    let chosen: string | undefined;
    for (const entry of freshMains) {
      const name = entry.recipe.menu;
      try {
        validateMenuVariety(context, {
          days: [{
            date,
            meals: [{ meal, slots: { ...values(), [slot]: name }, extras }],
          }],
        });
        chosen = name;
        break;
      } catch { /* Keep the fixture's real diversity constraints intact. */ }
    }
    if (!chosen) {
      throw new Error(
        `Cannot prepare an actual reviewed fresh primary for ${mealKey}|${slot}`,
      );
    }
    month[`${day}|${meal}|${slot}`] = chosen;
    preparedPrimaryRepairs++;
  }
  const ready = values();
  if (
    ![ready["2"], ready["7"]].every((dish) => profile(dish).substantial) ||
    ![ready["2"], ready["7"]].some((dish) => profile(dish).anchor)
  ) {
    throw new Error(`Capacity fixture primary precondition failed: ${mealKey}`);
  }
  for (const slot of ["2", "7"]) {
    primarySnapshot.set(
      `${day}|${meal}|${slot}`,
      month[`${day}|${meal}|${slot}`],
    );
  }
}
const repaired = planInstitutionalRefresh(
  state,
  INSTITUTIONAL_CATALOG,
  seeded.generatedOwnership,
  {
    today: "2026-10-08",
    updated: "2026-10-08T05:00:00.000Z",
    runId: "capacity-upgrade",
    manualPolicy: true,
  },
);
if (
  repaired.changedCells.length !== 47 ||
  repaired.changedCells.some((key) => Number(key.split("|")[2]) < 10)
) {
  throw new Error(
    `Valid-primary capacity fixture must make exactly 47 extra-only edits, got ${repaired.changedCells.length}`,
  );
}
for (const key of repaired.changedCells) {
  const [date, meal, slot] = key.split("|");
  const localKey = `${Number(date.split("-")[2])}|${meal}|${slot}`;
  if (
    state.menus!["2026-10"][localKey] !== undefined ||
    !repaired.after.menus!["2026-10"][localKey]
  ) {
    throw new Error(
      `Capacity repair must append to an empty extra cell, not replace an existing dish: ${key}`,
    );
  }
}
for (const [key, value] of primarySnapshot) {
  if (repaired.after.menus!["2026-10"][key] !== value) {
    throw new Error(`Already-valid primary changed: ${key}`);
  }
}
for (const day of repaired.plan.days) {
  for (const meal of day.meals) {
    if (menuManualViolations(meal.slots, meal.extras, state, profile).length) {
      throw new Error(`Policy capacity failed at ${day.date}|${meal.meal}`);
    }
  }
}
if (
  meals !== 47 || repaired.refreshedMeals.length !== 47 ||
  repaired.protectedChanged.length || repaired.catalogAdded.length ||
  repaired.missingNewRecipes.length
) {
  throw new Error(
    `Capacity fixture did not repair 47 owned AI meals safely: ${
      JSON.stringify({
        meals,
        refreshed: repaired.refreshedMeals.length,
        protected: repaired.protectedChanged,
      })
    }`,
  );
}
for (const day of repaired.plan.days) {
  for (const meal of day.meals) {
    if (
      [...Object.values(meal.slots), ...(meal.extras || [])].some((name) =>
        name.startsWith("검증하지않은AI")
      )
    ) {
      throw new Error(
        "Unreviewed positive legacy recipe leaked into automatic composition",
      );
    }
  }
}
const rerun = planInstitutionalRefresh(
  repaired.after,
  INSTITUTIONAL_CATALOG,
  repaired.generatedOwnership,
  {
    today: "2026-10-08",
    updated: "2026-10-08T06:00:00.000Z",
    runId: "capacity-repeat",
    manualPolicy: true,
  },
);
if (rerun.changedCells.length || rerun.refreshedMeals.length) {
  throw new Error("Whole-window rerun was not idempotent");
}
console.log(JSON.stringify({
  check: "MANUAL_POLICY_CAPACITY_OK",
  meals,
  distinctRecipes: names.size,
  approvedCatalogMains: INSTITUTIONAL_CATALOG.filter((entry) =>
    entry.role === "main"
  ).length,
  changedFoodCells: repaired.changedCells.length,
  preparedPrimaryRepairs,
  protectedChanges: 0,
  elapsedMs: Math.round(performance.now() - started),
}));

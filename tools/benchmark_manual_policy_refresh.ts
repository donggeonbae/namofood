// Production-shaped, entirely synthetic performance/protection check.
import { type State } from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  type CatalogEntry,
  type OwnershipProofs,
  planInstitutionalRefresh,
  REFRESH_MODEL,
} from "./refresh_institutional_menus.ts";

const method =
  "대량 급식용 회전솥에서 계량하여 배치 조리하고 배식 전 품질을 확인한다.";
const ready = [
  ["제육볶음", "돼지고기"],
  ["고등어구이", "고등어"],
  ["소불고기", "소고기"],
  ["돈가스", "돼지고기"],
  ["생선가스", "명태"],
  ["간장찜닭", "닭고기"],
  ["오징어볶음", "오징어"],
  ["갈치조림", "갈치"],
  ["계란찜", "달걀"],
  ["두부조림", "두부"],
];
const state: State = { menus: {}, recipes: [], methods: {}, menuPlanMeta: {} };
const rows = state.recipes as Array<Record<string, unknown>>;
const methods = state.methods as Record<string, string>;
for (const [menu, item] of ready) {
  rows.push({ menu, item, qty: 130, unit: "g", comp: "주찬" });
  methods[menu] = method;
}
const syntheticMenus = Array.from(
  { length: 817 },
  (_, index) => `성능검증채소찬-${index}`,
);
for (const menu of syntheticMenus) {
  for (const item of ["양배추", "당근", "양파", "물", "간장"]) {
    rows.push({ menu, item, qty: 10, unit: "g", comp: "부찬" });
  }
  methods[menu] = method;
}
let index = 0;
for (let month = 5; month <= 9; month++) {
  const ym = `2026-${String(month).padStart(2, "0")}`;
  const cells: Record<string, unknown> = state.menus![ym] = {};
  for (let day = 1; day <= 28; day++) {
    for (const meal of ["조식", "중식", "석식", "야식"]) {
      for (const slot of ["1", "2", "7", "3", "4", "8", "10"]) {
        cells[`${day}|${meal}|${slot}`] =
          syntheticMenus[index++ % syntheticMenus.length];
      }
    }
  }
}
const today = "2026-10-08", mealKey = `${today}|조식`;
state.menus!["2026-10"] = {
  "8|조식|1": "맑은콩나물국",
  "8|조식|2": "제육볶음",
  "8|조식|7": "고등어구이",
  "8|조식|3": "오이무침",
  "8|조식|4": "감자조림",
  "8|조식|8": "배추김치",
  "8|조식|10": "감자채볶음",
  "8|조식|0": "쌀밥",
  "8|조식|n": "350",
};
state.menuPlanMeta![mealKey] = {
  by: "ai",
  runId: "previous",
  model: REFRESH_MODEL,
  updated: "keep",
};
const ownership: OwnershipProofs = {
  runAdded: {
    previous: ["1", "2", "7", "3", "4", "8", "10"].map((slot) =>
      `${mealKey}|${slot}`
    ),
  },
};
const bank: CatalogEntry[] = ready.map(([menu, item]) => ({
  role: "main",
  protein: item,
  method: "batch",
  seasoning: "plain",
  recipe: {
    menu,
    comp: "주찬",
    method,
    source: "검증된 테스트 메뉴",
    items: [{ item, qty: 130, unit: "g" }],
  },
}));
const started = performance.now();
const result = planInstitutionalRefresh(state, bank, ownership, {
  today,
  updated: "2026-10-08T05:00:00.000Z",
  runId: "benchmark",
  manualPolicy: true,
});
const elapsedMs = Math.round(performance.now() - started);
if (
  result.changedCells.join() !== `${mealKey}|11` ||
  result.protectedChanged.length || result.catalogAdded.length
) {
  throw new Error(
    "Production-shaped benchmark changed more than the missing third main",
  );
}
console.log(
  JSON.stringify({
    benchmark: "MANUAL_POLICY_REFRESH",
    distinctRecipes: 827,
    recipeRows: rows.length,
    storedFoodCells: index + 7,
    changedCells: 1,
    elapsedMs,
  }),
);

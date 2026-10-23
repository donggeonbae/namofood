import {
  buildRecommendationInput,
  buildRecommendationPrompt,
  recommendationCatalogRevision,
} from "../supabase/functions/nmf-menu-recommend/lib.ts";
const assert = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
const state = {
  recipes: [
    {
      menu: "제육볶음",
      item: "돼지고기",
      qty: 100,
      unit: "g",
      comp: "주찬",
      method: "돼지고기를 볶는다",
    },
    {
      menu: "수육",
      item: "돼지고기",
      qty: 100,
      unit: "g",
      comp: "주찬",
      method: "돼지고기를 삶는다",
    },
    {
      menu: "고등어구이",
      item: "고등어",
      qty: 100,
      unit: "g",
      comp: "주찬",
      method: "고등어를 굽는다",
    },
  ],
  menuRotationReference: {
    version: "2026-10-24-two-week-methods-v1",
    from: "2026-10-12",
    to: "2026-10-25",
    names: ["제육볶음"],
  },
};
const before = JSON.stringify(state),
  input = buildRecommendationInput(state, "2026-11-20", "full-catalog-test");
assert(
  input.pools["2"].some((c) => c.name === "수육"),
  "recommend meat outside the fixed two-week reference",
);
assert(
  input.pools["7"].some((c) => c.name === "고등어구이"),
  "recommend fish outside the fixed two-week reference",
);
const prompt = buildRecommendationPrompt(input);
assert(
  !prompt.includes("기준 2주 메뉴만"),
  "prompt must not restrict recommendation catalog",
);
assert(
  prompt.includes("같은 날 다른 끼니") && prompt.includes("조리방식"),
  "keep cross-meal cooking-method policy",
);
assert(
  JSON.stringify(state) === before,
  "recommendation never changes saved menus or rotation metadata",
);
assert(
  await recommendationCatalogRevision(state) ===
    await recommendationCatalogRevision({
      ...state,
      menuRotationReference: {
        ...state.menuRotationReference,
        names: ["수육"],
      },
    }),
  "rotation metadata does not revise recommendation catalog",
);
console.log(
  "FULL_RECIPE_CATALOG_OUTSIDE_REFERENCE_PROMPT_METHODS_READ_ONLY_REVISION_OK",
);

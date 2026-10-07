// Offline acceptance checks for the actual recipe/content merge gate and the
// menu bank used by the one-off refresh planner.
import {
  mergeRecipes,
  recipeNames,
  validateInstitutionalMethod,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";
import {
  canonicalDish,
  dishProfile,
} from "../supabase/functions/_shared/institutional-menu.ts";
import { INSTITUTIONAL_CATALOG as catalog } from "./institutional_catalog.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function recipe(menu: string) {
  const entry = catalog.find((e) => e.recipe.menu === menu);
  assert(entry, `Missing complete catalog entry ${menu}`);
  return entry.recipe;
}

const counts = Object.fromEntries(
  ["main", "soup", "side", "kimchi"].map((
    role,
  ) => [role, catalog.filter((e) => e.role === role).length]),
);
assert(counts.main >= 90, "Need at least 90 substantial main candidates");
assert(counts.soup >= 35, "Need at least 35 soup candidates");
assert(counts.side >= 60, "Need at least 60 non-kimchi sides");
assert(catalog.length >= 250, "Recipe library expansion must be substantial");
assert(
  new Set(catalog.map((e) => e.recipe.menu)).size === catalog.length,
  "Exact name duplicate",
);
assert(
  new Set(catalog.map((e) => canonicalDish(e.recipe.menu))).size ===
    catalog.length,
  "Canonical alias duplicate",
);

const state = { recipes: [], methods: {}, sources: {}, recipeMeta: {} };
const result = mergeRecipes(state, catalog.map((e) => e.recipe), "2026-10-08");
assert(
  !result.skipped.length,
  `Recipe content/identity/safety rejection: ${result.skipped.join("; ")}`,
);
assert(
  result.added.length === catalog.length,
  "Every recipe must survive the production content validator",
);
assert(
  recipeNames(state).size === catalog.length,
  "Every candidate needs nonempty ingredient rows",
);
for (const entry of catalog) {
  const r = entry.recipe;
  assert(
    !validateInstitutionalMethod(r.method || ""),
    `${r.menu}: method gate failed`,
  );
  assert(
    r.items.every((it) =>
      it.qty > 0 && ["g", "ml", "ea"].includes(it.unit || "")
    ),
    `${r.menu}: units`,
  );
  const foodRows = r.items.filter((it) => it.item !== "물");
  assert(
    entry.role === "kimchi" || foodRows.length >= 5,
    `${r.menu}: incomplete ingredient list`,
  );
  assert(foodRows.length <= 13, `${r.menu}: oversized ingredient list`);
  assert(
    r.method?.includes("100명 기준") && r.method.includes("25명분씩 4배치"),
    `${r.menu}: missing production quantities`,
  );
  assert(
    r.method?.includes("남은 음식") && r.method.includes("폐기"),
    `${r.menu}: served leftovers not discarded`,
  );
  assert(
    r.method?.includes("실제 납품 제품 표시사항"),
    `${r.menu}: compound allergen label check missing`,
  );
  assert(
    r.source?.startsWith("AI 대량 조리 작업서"),
    `${r.menu}: authorship must be honest`,
  );
  if (entry.role === "main") {
    assert(
      !["side", "rice", "kimchi", "soup"].includes(dishProfile(r.menu).kind),
      `${r.menu}: main is an accompaniment`,
    );
    if (
      /(?:^|-)(?:fish|seafood|squid|octopus|shrimp|shellfish)(?:$|-)/.test(
        entry.protein,
      )
    ) {
      assert(
        r.method?.includes("중심온도 85℃에서 1분 이상"),
        `${r.menu}: every seafood-bearing main needs 85℃ heating`,
      );
    }
  }
  if (entry.role === "soup") {
    assert(
      !/(국수|수제비|우동|라면|만두|떡국|국밥)/.test(r.menu),
      `${r.menu}: rice/noodle soup`,
    );
  }
  if (r.method?.includes("급속냉각")) {
    const checkAt = r.method!.indexOf("중심온도");
    const coolAt = r.method!.indexOf("급속냉각");
    assert(
      checkAt >= 0 && coolAt > checkAt,
      `${r.menu}: measure cooking temperature before cooling`,
    );
  }
}

for (
  const [menu, ingredient, method, temperature] of [
    ["명태튀김", "명태살", "튀김기", "85℃"],
    ["소고기양념구이", "소고기설도", "전판", "75℃"],
    ["닭다리살소금구이", "닭고기다리살", "전판", "75℃"],
    ["당근전", "당근", "전판", "75℃"],
    ["콩나물무침", "콩나물", "대형솥", "75℃"],
    ["굴전", "굴", "전판", "85℃"],
    ["황태양념구이", "황태포", "전판", "85℃"],
    ["코다리조림", "코다리전처리", "회전솥", "85℃"],
    ["코다리강정", "코다리순살", "튀김기", "85℃"],
  ] as const
) {
  const r = recipe(menu);
  assert(
    r.items.some((it) => it.item === ingredient),
    `${menu}: real named ingredient missing`,
  );
  assert(
    r.method?.includes(method) &&
      r.method.includes(`중심온도 ${temperature}에서 1분 이상`),
    `${menu}: dish-specific equipment and safe heating`,
  );
}
for (const menu of ["굴전", "돼지고기고추잡채", "새우청경채볶음"]) {
  assert(
    recipe(menu).allergy?.includes("조개류"),
    `${menu}: fresh oyster/oyster sauce allergy`,
  );
}
assert(
  recipe("닭강정").allergy?.includes("토마토"),
  "Ketchup needs tomato declaration",
);
for (const menu of ["감자당근샐러드", "옥수수콩샐러드"]) {
  assert(
    recipe(menu).allergy?.includes("난류"),
    `${menu}: mayonnaise egg declaration`,
  );
}
for (const menu of ["콩나물무침", "취나물무침", "방풍나물"]) {
  assert(
    recipe(menu).items[0].storage === "냉장",
    `${menu}: suffix 물 is not plain water`,
  );
}
for (const menu of ["코다리조림", "코다리강정"]) {
  assert(
    recipe(menu).items[0].storage === "냉동",
    `${menu}: purchased frozen fish storage`,
  );
}
const methods = new Set(
  catalog.filter((e) => e.role === "main").map((e) => e.method),
);
for (
  const method of [
    "stir-fry",
    "braise",
    "roast",
    "pan-fry",
    "fry",
    "steam",
    "boil",
    "mix",
  ]
) {
  assert(methods.has(method), `Missing main cooking process ${method}`);
}
assert(
  catalog.filter((e) => e.role === "main" && e.protein === "beef").length /
      counts.main < 0.2,
  "Bank must not be beef-heavy",
);
console.log(
  `INSTITUTIONAL_CATALOG_OK ${
    JSON.stringify({
      total: catalog.length,
      ...counts,
      contentAccepted: result.added.length,
    })
  }`,
);
